// Mobile Sensor Meter — browser-side microphone logic.
//
// Plain script, no imports: loaded as window.MicLogic on the performer
// page, require()d by the Node tests (fake getUserMedia responders, a
// fake analyser and a fake clock drive this exact code — what the tests
// prove is what the phone runs).
//
// The mic is an EXCLUSIVE resource (the orange indicator, the room's
// audio), so its lifecycle is stricter than the motion sensors'
// (spec #143):
// - Capture starts only from the user's Enable tap — the getUserMedia
//   permission prompt must live inside a user gesture — and ends on the
//   user's Stop, on pagehide and on backgrounding. Every one of those
//   RELEASES the stream and the analysis graph (tracks stopped,
//   AudioContext closed): a backgrounded meter page never holds the
//   mic.
// - Analysis is local and total: RMS and peak over the newest
//   time-domain block (normalized float PCM — unit FS, the fraction of
//   digital full scale), and a level in dBFS (20·log10 of RMS, floored
//   at −90). These are UNCALIBRATED numbers; nothing here is or claims
//   to be a physical dB SPL reading.
// - The captured audio is never played back (the page's analysis graph
//   connects to an analyser only, never a destination) and never leaves
//   the phone: only the latest processed values ride the bounded sample
//   path (send ≤30 Hz, newest only) the other sensors use.
// - Late results are facts, never restarts: a grant landing after the
//   user stopped releases the stream it carried and reports "granted";
//   a denial landing late changes nothing at all.
// - seq is monotonic for the controller's whole life and never resets.
//   The server's record survives pauses and reconnects, so a restarted
//   seq would read as a replay of history — climbing past the last
//   accepted seq is what makes a re-acquired capture provably new.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.MicLogic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Rate limits (ms between passes), mirroring the motion sensors:
  // analysis passes run at the tick cadence (≤60 Hz), the wire carries
  // every other processed sample (~30 Hz) — enough for the monitor's
  // frame-rate smoothing to read as a continuous level.
  const MIC_TICK_MS = 16; // ~60 Hz
  const MIC_CAPTURE_MIN_INTERVAL_MS = 16; // ~60 Hz
  const MIC_SEND_MIN_INTERVAL_MS = 33; // ~30 Hz

  // The analysis block: one getFloatTimeDomainData window. 2048 samples
  // is ~43–46 ms at the usual device rates — long enough for a stable
  // RMS, short enough for peaks to register. Windows overlap by design
  // (a level meter polls the newest window at its own cadence); the
  // numbers are documented as meter values, not spectral measurements.
  const MIC_BLOCK_SIZE = 2048;

  // The level meter floor: RMS at or below 10^(−90/20) reads −90.0 dBFS.
  // Silence is still legible as REAL zeros in rms/peak; the floor is
  // the level's honest "at or below" answer, never "unavailable".
  const MIC_LEVEL_FLOOR_DB = -90;

  // Diagnostics want the raw input: every browser "enhancement" (echo
  // cancellation, noise suppression, AGC) would distort the very levels
  // being measured. There is no echo regardless — the graph never
  // reaches a destination.
  const MIC_CONSTRAINTS = Object.freeze({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  // ------------------------------------------------------------
  // Value rules
  // ------------------------------------------------------------

  function readNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // ------------------------------------------------------------
  // Rate limiting (watermark gate — same contract as sensor-logic)
  // ------------------------------------------------------------

  function makeGate(minIntervalMs) {
    let last = -Infinity;

    return function gate(now) {
      if (now - last < minIntervalMs) {
        return false;
      }

      last = now;
      return true;
    };
  }

  // ------------------------------------------------------------
  // Analysis
  // ------------------------------------------------------------

  // One block in, one processed sample out: { rms, peak, level,
  // sampleRate } or null when the block is not a sample at all (empty,
  // or carrying non-finite floats — a poisoned block is a fact about
  // the plumbing, not a zero reading).
  function analyzeBlock(block, sampleRate) {
    if (!block || block.length === 0) {
      return null;
    }

    let sumSquares = 0;
    let peak = 0;

    for (let i = 0; i < block.length; i += 1) {
      const x = block[i];

      if (!Number.isFinite(x)) {
        return null;
      }

      sumSquares += x * x;
      const magnitude = Math.abs(x);

      if (magnitude > peak) {
        peak = magnitude;
      }
    }

    const rms = Math.sqrt(sumSquares / block.length);
    const floorLinear = Math.pow(10, MIC_LEVEL_FLOOR_DB / 20);

    return {
      rms,
      peak,
      level: 20 * Math.log10(Math.max(rms, floorLinear)),
      sampleRate: readNumber(sampleRate),
    };
  }

  // ------------------------------------------------------------
  // The controller
  // ------------------------------------------------------------

  // platform (all injectable; the performer page passes the real ones):
  //   now()                            monotonic-ish ms clock
  //   getUserMedia(constraints)        the permission-bearing request;
  //                                    absent/not a function → unsupported
  //                                    (a non-secure context hides
  //                                    navigator.mediaDevices entirely)
  //   releaseStream(stream)            stop a granted stream's tracks
  //                                    (used when no analyser was built)
  //   openAnalyser(stream, blockSize)  build the analysis graph; returns
  //                                    { read(block), sampleRate, close() }
  //                                    — close() must never throw
  //   schedule(fn, intervalMs)         → cancel() for the tick timer
  //
  // callbacks:
  //   onState(state)               — capture-state changes
  //   onPermission(permission)     — a permission fact (unsupported,
  //                                  denied, late grants)
  //   onStart(permission)          — a user-initiated capture went live
  //                                  (server notification); silent
  //                                  re-acquisitions do NOT emit it
  //   onStop(lastSample)           — the user's stop ended the capture
  //   onSend(sample, seq)          — send-gated latest values (the
  //                                  phone's readout rides this too)
  class MicController {
    constructor(platform, callbacks = {}) {
      this.platform = platform;
      this.callbacks = callbacks;

      this.paused = false;
      this.state = "off"; // off | starting | on | denied | unsupported | error
      this.attempt = 0;
      this.seq = 0; // monotonic for the controller's whole life
      this.lastSample = null;
      this.analyser = null;
      this.block = null;
      this.cancelTick = null;
      this.captureGate = null;
      this.sendGate = null;
    }

    stateOf() {
      return this.state;
    }

    // The user's explicit enable. Must be called from a user gesture —
    // the permission prompt requires one.
    start() {
      if (this.state === "on" || this.state === "starting") {
        return;
      }

      this.acquire({ silent: false });
    }

    // The user's explicit stop (or shutdown). In-flight permission
    // results become late results: facts at most, never restarts.
    stop() {
      this.attempt += 1; // supersedes any in-flight getUserMedia
      this.release();

      const was = this.state;
      this.state = "off";

      if (was === "on" || was === "starting") {
        this.emit("onStop", this.lastSample);
      }
      this.emit("onState", this.state);
    }

    // Backgrounded: the mic is an exclusive resource, so unlike the
    // motion sensors (whose listeners may stay attached) the capture is
    // RELEASED here — the phone's mic indicator must go dark — while
    // the state keeps the user's intent ("on"); resume() re-acquires
    // silently. A prompt still pending ("starting") cannot survive a
    // backgrounding: it converts to a stop, and whatever the prompt
    // answers later lands as a late result.
    pause() {
      if (this.paused) {
        return;
      }

      this.paused = true;

      if (this.state === "starting") {
        this.stop();
        return;
      }

      if (this.state === "on") {
        this.release();
      }
    }

    resume() {
      this.paused = false;

      if (this.state === "on") {
        // Re-acquire without a server notification: the server's record
        // (capture on, frozen sample) is exactly the truth to keep, and
        // the monotonic seq carries the new samples past the old ones.
        this.acquire({ silent: true });
      }
    }

    // ------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------

    acquire({ silent }) {
      this.attempt += 1;
      const attempt = this.attempt;

      if (typeof this.platform.getUserMedia !== "function") {
        this.state = "unsupported";
        this.emit("onPermission", "unsupported");
        this.emit("onState", this.state);
        return;
      }

      if (!silent) {
        this.state = "starting";
        this.emit("onState", this.state);
      }

      this.platform
        .getUserMedia(MIC_CONSTRAINTS)
        .then((stream) => {
          if (attempt !== this.attempt) {
            // A LATE grant: the user stopped (or a newer acquire
            // superseded this one) while the prompt was open. Report
            // the fact, release the stream AT ONCE — a stopped capture
            // must not hold the mic, even briefly — and restart nothing.
            this.platform.releaseStream(stream);
            this.emit("onPermission", "granted");
            return;
          }

          this.attach(stream, { notify: !silent });
        })
        .catch((error) => {
          if (attempt !== this.attempt) {
            return; // a late denial changes nothing
          }

          if (
            error &&
            (error.name === "NotAllowedError" || error.name === "SecurityError")
          ) {
            this.state = "denied";
            this.emit("onState", this.state);
            this.emit("onPermission", "denied");
          } else {
            this.state = "error";
            this.emit("onState", this.state);
          }
        });
    }

    attach(stream, { notify }) {
      let analyser;

      try {
        analyser = this.platform.openAnalyser(stream, MIC_BLOCK_SIZE);
      } catch {
        // The permission itself WAS granted (getUserMedia resolved) —
        // the fact is reported — but the graph could not be built, so
        // this capture is an error, not a capture.
        this.platform.releaseStream(stream);
        this.emit("onPermission", "granted");
        this.state = "error";
        this.emit("onState", this.state);
        return;
      }

      // A fresh capture gets fresh gates — but the seq KEEPS climbing
      // (see the module header): a re-acquired capture must read as new
      // on the server, never as a replay.
      this.captureGate = makeGate(MIC_CAPTURE_MIN_INTERVAL_MS);
      this.sendGate = makeGate(MIC_SEND_MIN_INTERVAL_MS);
      this.block = new Float32Array(MIC_BLOCK_SIZE);
      this.analyser = analyser;
      this.lastSample = null;
      this.cancelTick = this.platform.schedule(() => this.onTick(), MIC_TICK_MS);

      const wasOn = this.state === "on"; // the silent re-acquisition path
      this.state = "on";

      if (!wasOn) {
        this.emit("onState", this.state);
      }

      if (notify) {
        this.emit("onStart", "granted");
      }
    }

    onTick() {
      if (this.state !== "on" || this.paused || this.analyser === null) {
        return;
      }

      const now = this.platform.now();

      if (!this.captureGate(now)) {
        return;
      }

      this.analyser.read(this.block);

      const sample = analyzeBlock(this.block, this.analyser.sampleRate);

      if (sample === null) {
        return;
      }

      this.seq += 1;
      this.lastSample = sample;

      if (this.sendGate(now)) {
        // Only the LATEST processed sample ever goes out — nothing is
        // queued between sends, so a reconnect cannot replay history.
        this.emit("onSend", sample, this.seq);
      }
    }

    // Releases every capture/analysis resource: the tick timer first
    // (no tick can race the teardown), then the analysis graph — whose
    // close() stops the stream's tracks and closes the AudioContext.
    // After this the page holds no mic at all.
    release() {
      if (this.cancelTick !== null) {
        this.cancelTick();
        this.cancelTick = null;
      }

      if (this.analyser !== null) {
        this.analyser.close();
        this.analyser = null;
      }

      this.block = null;
    }

    emit(name, ...args) {
      const callback = this.callbacks[name];

      if (typeof callback === "function") {
        callback(...args);
      }
    }
  }

  return {
    MIC_TICK_MS,
    MIC_CAPTURE_MIN_INTERVAL_MS,
    MIC_SEND_MIN_INTERVAL_MS,
    MIC_BLOCK_SIZE,
    MIC_LEVEL_FLOOR_DB,
    MIC_CONSTRAINTS,
    readNumber,
    makeGate,
    analyzeBlock,
    MicController,
  };
});
