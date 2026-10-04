// Mobile Sensor Meter — browser-side handpose logic (#144).
//
// Plain script, no imports: loaded as window.HandPoseLogic on the
// performer page, require()d by the Node tests (fake cameras, fake
// model factories and a fake clock drive this exact code — what the
// tests prove is what the phone runs).
//
// The pipeline is three deliberately SEPARATE stages, because the spec
// demands their failures stay distinguishable (a live preview is not a
// loaded model; a loaded model is not a completed inference):
//
//   camera ──getUserMedia (user gesture)──▶ preview live
//         ──loadScript (local vendor ml5)──▶ model loading
//         ──ml5.handPose (local model URLs)─▶ inference loop (≤10 Hz)
//
// Rules this module enforces:
// - Everything the phone loads is SAME-ORIGIN: the ml5 script and both
//   tfjs models come from this server's /vendor/ paths — no CDN at
//   runtime. A resource the page cannot load is a diagnosable
//   "model-error" state, never a fallback to some remote URL. The
//   technical REASON behind a model/inference failure is kept
//   (failureDetail()) and the card shows it verbatim — this app is
//   itself the diagnostics tool, and a bare "failed" once sent a user
//   hunting for a missing npm script that was present all along.
// - The camera is an exclusive resource like the mic: user Stop,
//   pagehide and backgrounding release it (tracks stopped, preview
//   detached). The MODEL is memory, not an exclusive device — pause
//   keeps it loaded for a fast, silent resume; user Stop disposes it.
// - Late results are facts, never restarts: a camera grant, a script
//   load, a model-ready or an inference result that lands after the
//   user stopped (or a newer attempt superseded it) is dropped —
//   resources it carried are released, nothing re-enables.
// - "No hand" is a RESULT (hands: 0, like a silent room's real zeros),
//   never an error. An inference that THROWS is an error: the loop
//   stops, the model is disposed, the state says so.
// - Keypoints travel NORMALIZED to [0, 1] (origin top-left, x right,
//   y down, UNmirrored — the model's own frame, not the selfie view).
//   ml5's tfjs runtime reports pixels; the phone divides by the video
//   dimensions before anything reaches the wire. Mirror/orientation
//   presentation is the pages' business and is documented per page.
// - The wire carries the LATEST processed result only (inference-paced
//   ≤10 Hz; nothing queues between results), with the inference
//   duration and an honest update rate derived from actual inference
//   completions — never from ticks that merely fired.
// - seq is monotonic for the controller's whole life and never resets
//   (same contract as the mic: the server's record survives
//   pause/resume; a reset would read as a replay).

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.HandPoseLogic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The inference loop target: one detect() per tick at most. 10 Hz is
  // a realistic phone budget for the lite models and a bounded wire
  // rate by construction (one send per completed inference, newest
  // only). The loop is also re-entrancy-guarded: a tick landing while
  // an inference is still running does nothing.
  const HANDPOSE_TICK_MS = 100; // ~10 Hz

  // MediaPipe hands carry 21 landmarks; the wire is capped there so a
  // rogue result can never balloon a sample.
  const MAX_KEYPOINTS = 21;

  // The rolling window the update rate (rateHz) is derived from: only
  // actual inference COMPLETIONS inside the window count — a tick that
  // fired, a camera frame that arrived, none of that is a result.
  const RATE_WINDOW_MS = 2000;

  // What the phone requests: the raw camera, front-facing, no audio.
  // The model wants pixels, not the browser's "enhancements", so the
  // constraints name no processing flags and the page mirrors only the
  // PRESENTATION (CSS), never the frame data.
  const HANDPOSE_CAMERA_CONSTRAINTS = Object.freeze({
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  });

  function readNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // The verbatim reason behind a model/inference failure. Platform
  // errors carry messages worth reading as-is (tfjs names its real
  // failures — fetch, WebGL, shapes); anything else gets a stable
  // placeholder rather than silence.
  function failureText(error) {
    if (error && typeof error.message === "string" && error.message !== "") {
      return error.message;
    }

    if (typeof error === "string" && error !== "") {
      return error;
    }

    return "unknown error";
  }

  // ------------------------------------------------------------
  // Sample building
  // ------------------------------------------------------------

  // ml5 handPose hands → the wire block. keypoints arrive in PIXELS of
  // the media given to detect(); mediaSize normalizes them. Missing
  // size or non-finite values travel as null (missing, never zero).
  function buildSample(hands, inferMs, rateHz, mediaSize) {
    const list = Array.isArray(hands) ? hands : [];
    const first = list.length > 0 ? list[0] : null;
    const width = mediaSize ? readNumber(mediaSize.width) : null;
    const height = mediaSize ? readNumber(mediaSize.height) : null;

    const keypoints = [];

    if (first && Array.isArray(first.keypoints)) {
      for (const keypoint of first.keypoints.slice(0, MAX_KEYPOINTS)) {
        const x = readNumber(keypoint.x);
        const y = readNumber(keypoint.y);

        keypoints.push({
          x: x !== null && width !== null && width > 0 ? x / width : null,
          y: y !== null && height !== null && height > 0 ? y / height : null,
        });
      }
    }

    return {
      hands: list.length,
      confidence: first ? readNumber(first.confidence) : null,
      keypoints,
      inferMs: readNumber(inferMs),
      rateHz: readNumber(rateHz),
    };
  }

  // ------------------------------------------------------------
  // The honest update rate
  // ------------------------------------------------------------

  class InferenceRate {
    constructor(windowMs = RATE_WINDOW_MS) {
      this.windowMs = windowMs;
      this.completions = []; // monotonic-ish ms timestamps
    }

    record(at) {
      this.completions.push(at);
      this.prune(at);
    }

    prune(now) {
      while (this.completions.length > 0 && now - this.completions[0] > this.windowMs) {
        this.completions.shift();
      }
    }

    hz(now) {
      this.prune(now);
      return this.completions.length / (this.windowMs / 1000);
    }
  }

  // ------------------------------------------------------------
  // The controller
  // ------------------------------------------------------------

  // platform (all injectable; the performer page passes the real ones):
  //   now()                        monotonic-ish ms clock
  //   getUserMedia(constraints)    camera permission request; absent →
  //                                unsupported (a plain-HTTP page has no
  //                                navigator.mediaDevices at all)
  //   releaseStream(stream)        stop a granted stream's tracks
  //   attachStream(stream) / detachStream() — bind/unbind the preview
  //                                element (page-owned DOM)
  //   media()                      the preview element for detect()
  //   mediaSize()                  { width, height } of the frame, for
  //                                normalization (null until frames flow)
  //   loadScript(src)              → Promise; lazy-loads the vendor ml5
  //                                bundle ONLY when handpose is enabled
  //   createModel(config)          → { ready: Promise, detect(media),
  //                                dispose() } — the page passes
  //                                ml5.handPose(config)
  //   scriptSrc / modelUrls        the same-origin vendor locations
  //   schedule(fn, intervalMs)     → cancel() for the tick timer
  //
  // callbacks:
  //   onState(state)             — off | camera-starting | camera-denied
  //                                | unsupported | loading-model
  //                                | model-error | running | error
  //   onPermission(permission)   — a camera permission fact (unsupported,
  //                                denied, late grants)
  //   onStart(permission)        — inference actually began (the server
  //                                notification; silent re-acquisitions
  //                                after pause do NOT emit it)
  //   onStop(lastSample)         — the user's stop ended an active capture
  //   onSend(sample, seq)        — the latest processed result (the
  //                                phone's readout rides this too)
  class HandPoseController {
    constructor(platform, callbacks = {}) {
      this.platform = platform;
      this.callbacks = callbacks;

      this.paused = false;
      this.state = "off";
      this.attempt = 0;
      this.seq = 0; // monotonic for the controller's whole life
      this.lastSample = null;
      this.stream = null;
      this.model = null;
      this.busy = false; // an inference is in flight
      this.cancelTick = null;
      this.rate = new InferenceRate();
      this.notifiedStart = false; // onStart emitted since last stop?
      this.failure = null; // the reason behind the last model/inference failure
    }

    stateOf() {
      return this.state;
    }

    // The technical reason behind the last "model-error"/"error"
    // (script fetch, tfjs init, WebGL probe, inference fault) — null
    // once healthy or freshly restarted. The card shows it verbatim;
    // the npm-asset advice belongs to the OTHER failure (an assets
    // inventory that actually says files are missing).
    failureDetail() {
      return this.failure;
    }

    // The user's explicit enable. Must run inside a user gesture — the
    // camera prompt requires one. Recoverable from every terminal state
    // (denied, model-error, error): the next tap starts over.
    start() {
      if (
        this.state === "camera-starting" ||
        this.state === "loading-model" ||
        this.state === "running"
      ) {
        return;
      }

      this.failure = null; // a fresh attempt starts with a clean slate
      this.acquireCamera();
    }

    acquireCamera({ silent = false } = {}) {
      // A user start supersedes everything in flight; a silent
      // re-acquisition (resume) deliberately does NOT bump the token —
      // an in-flight model load must survive it untouched.
      if (!silent) {
        this.attempt += 1;
      }
      const attempt = this.attempt;

      if (typeof this.platform.getUserMedia !== "function") {
        this.state = "unsupported";
        this.emit("onPermission", "unsupported");
        this.emit("onState", this.state);
        return;
      }

      this.state = "camera-starting";
      if (!silent) {
        this.emit("onState", this.state);
      }

      this.platform
        .getUserMedia(HANDPOSE_CAMERA_CONSTRAINTS)
        .then((stream) => {
          if (attempt !== this.attempt) {
            // A LATE grant: report the fact, release the camera at
            // once, restart nothing.
            this.platform.releaseStream(stream);
            this.emit("onPermission", "granted");
            return;
          }

          if (this.paused) {
            // Granted while backgrounded: the preview is a foreground
            // thing — hold the fact, release, resume() re-asks.
            this.platform.releaseStream(stream);
            this.emit("onPermission", "granted");
            return;
          }

          // A re-enable from model-error / error arrives with the old
          // stream still held (the preview kept running as the
          // diagnostic): release it before the new one takes over — an
          // orphaned track would keep the camera indicator lit forever.
          this.releaseCamera();

          this.stream = stream;
          this.platform.attachStream(stream); // the preview is live

          if (this.model !== null) {
            // A silent re-acquisition with the model already loaded:
            // straight into the loop (the server was notified at the
            // original start; the monotonic seq proves freshness).
            this.beginLoop(attempt);
          } else if (this.state !== "loading-model") {
            this.loadModel(attempt);
          }
          // Else: a load is already in flight (resume raced it) — it
          // proceeds under its own unchanged token and begins the loop
          // when ready.
        })
        .catch((error) => {
          if (attempt !== this.attempt) {
            return; // a late denial changes nothing
          }

          if (
            error &&
            (error.name === "NotAllowedError" || error.name === "SecurityError")
          ) {
            this.state = "camera-denied";
            this.emit("onState", this.state);
            this.emit("onPermission", "denied");
          } else {
            // NotFoundError & friends: no camera at all.
            this.state = "error";
            this.emit("onState", this.state);
          }
        });
    }

    // Stage two: the local vendor script, then the model from the
    // local URLs. Any failure here is "model-error" — the CAMERA KEEPS
    // RUNNING (the preview is itself a diagnostic: it proves the camera
    // path works while the model path does not), and the REASON is
    // kept for the card to show.
    loadModel(attempt) {
      // The cheap GPU question first: without a WebGL context the model
      // cannot run, and knowing it now saves the phone the 4.5 MB
      // script download. A platform without the probe fails OPEN —
      // the model loader's own error still speaks.
      const webglProblem =
        typeof this.platform.webglProbe === "function"
          ? this.platform.webglProbe()
          : null;

      if (webglProblem) {
        this.failure = webglProblem;
        this.state = "model-error";
        this.emit("onState", this.state);
        return;
      }

      this.state = "loading-model";
      this.emit("onState", this.state);

      this.platform
        .loadScript(this.platform.scriptSrc)
        .then(() => {
          if (attempt !== this.attempt) {
            return;
          }

          const model = this.platform.createModel({
            maxHands: 1,
            runtime: "tfjs",
            modelType: "lite",
            detectorModelUrl: this.platform.modelUrls.detectorModelUrl,
            landmarkModelUrl: this.platform.modelUrls.landmarkModelUrl,
          });

          return model.ready.then(() => {
            if (attempt !== this.attempt) {
              // The user stopped while the weights were loading: the
              // model is unwanted — dispose it now, restart nothing.
              this.disposeModel(model);
              return;
            }

            this.model = model;

            if (this.paused) {
              // Ready while backgrounded: hold the loaded model (it is
              // memory, not a device); resume() starts the loop.
              return;
            }

            this.beginLoop(attempt);
          });
        })
        .catch((error) => {
          if (attempt !== this.attempt) {
            return;
          }

          this.failure = failureText(error);
          this.state = "model-error";
          this.emit("onState", this.state);
        });
    }

    beginLoop(attempt) {
      this.cancelTick = this.platform.schedule(
        () => this.onTick(attempt),
        HANDPOSE_TICK_MS,
      );
      this.state = "running";
      this.emit("onState", this.state);

      if (!this.notifiedStart) {
        this.notifiedStart = true;
        this.emit("onStart", "granted");
      }
    }

    onTick(attempt) {
      if (
        this.state !== "running" ||
        this.paused ||
        this.model === null ||
        this.busy
      ) {
        return;
      }

      const media = this.platform.media();

      if (media === null || media === undefined) {
        return;
      }

      this.busy = true;
      const startedAt = this.platform.now();

      this.model
        .detect(media)
        .then((hands) => {
          this.busy = false;

          if (attempt !== this.attempt || this.paused || this.state !== "running") {
            return; // a LATE result: dropped, never replayed
          }

          const endedAt = this.platform.now();
          this.rate.record(endedAt);

          const sample = buildSample(
            hands,
            endedAt - startedAt,
            this.rate.hz(endedAt),
            this.platform.mediaSize(),
          );

          this.seq += 1;
          this.lastSample = sample;
          this.emit("onSend", sample, this.seq);
        })
        .catch((error) => {
          this.busy = false;

          if (attempt !== this.attempt) {
            return;
          }

          // An inference FAULT (distinct from "no hand"): stop the
          // loop, dispose the suspect model, keep the camera — the
          // preview plus this state (plus the kept reason) is exactly
          // the diagnosis. The next Enable starts over.
          this.stopLoop();
          this.disposeModel(this.model);
          this.failure = failureText(error);
          this.state = "error";
          this.emit("onState", this.state);
        });
    }

    // The user's explicit stop (or shutdown): everything goes — loop,
    // model (GPU memory), camera (the exclusive resource).
    stop() {
      this.attempt += 1; // supersedes every in-flight stage

      this.stopLoop();
      this.disposeModel(this.model);
      this.releaseCamera();
      this.state = "off";
      this.failure = null; // a stopped card carries no stale reason

      if (this.notifiedStart) {
        this.notifiedStart = false;
        this.emit("onStop", this.lastSample);
      }
      this.emit("onState", this.state);
    }

    // Backgrounded: the CAMERA is released (the indicator goes dark,
    // the preview detaches) and the loop stops; the MODEL stays loaded
    // (memory, not a device) so returning to the foreground is a
    // silent, fast re-acquisition. A prompt still pending converts to
    // a stop — its late result lands as a fact only.
    pause() {
      if (this.paused) {
        return;
      }

      this.paused = true;

      if (this.state === "camera-starting") {
        this.stop();
        return;
      }

      this.stopLoop();
      this.releaseCamera();
    }

    resume() {
      this.paused = false;

      // Whatever the user had going (model loaded from a "running"
      // capture, or still "loading-model"), the camera comes back
      // first; the stages continue from where they were held.
      if (this.state === "running" || this.state === "loading-model") {
        this.acquireCamera({ silent: true });
      }
    }

    // ------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------

    stopLoop() {
      if (this.cancelTick !== null) {
        this.cancelTick();
        this.cancelTick = null;
      }
    }

    disposeModel(model) {
      if (model === null || model === undefined) {
        return;
      }

      if (model === this.model) {
        this.model = null;
      }

      try {
        model.dispose();
      } catch {
        // A model that fails to dispose is already gone far enough.
      }
    }

    releaseCamera() {
      if (this.stream !== null) {
        this.platform.detachStream();
        this.platform.releaseStream(this.stream);
        this.stream = null;
      }
    }

    emit(name, ...args) {
      const callback = this.callbacks[name];

      if (typeof callback === "function") {
        callback(...args);
      }
    }
  }

  return {
    HANDPOSE_TICK_MS,
    MAX_KEYPOINTS,
    RATE_WINDOW_MS,
    HANDPOSE_CAMERA_CONSTRAINTS,
    readNumber,
    buildSample,
    InferenceRate,
    HandPoseController,
  };
});
