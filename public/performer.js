// Mobile Sensor Meter — performer page.
//
// The phone is the sensor: three cards (tilt, motion, mic), each with
// the user's explicit Enable/Stop pair — iOS requires the permission
// request to happen inside a user gesture, so capture NEVER starts on
// its own. The value readout binds to the SEND path (the exact sample
// that goes on the wire is the sample the phone displays), so what the
// operator sees on the monitor and what the holder sees are the same
// facts. No rate counters anywhere — the monitor renders at frame rate,
// smoothing toward the newest sample; smoothness is the deliverable.
//
// The mic card (#143) is stricter than the motion cards because the
// microphone is an EXCLUSIVE resource: capture not only stops on the
// user's Stop, on pagehide and on backgrounding — it RELEASES the
// stream and the analysis graph every time (the mic indicator goes
// dark), re-acquiring silently when the page returns if the user had
// left it on. The captured audio is analyzed on-device (RMS / peak /
// level, mic-logic.js) and never played back and never uploaded: only
// the processed numbers ride the wire.
//
// The page connects SAME-ORIGIN (io() with no URL): over plain HTTP
// that is the performer port; under the App's trusted-HTTPS entry it
// is the entry origin — zero page branches on which it is (#138).

const P = window.PNDS;
const S = window.SensorLogic;
const ML = window.MicLogic;
const HPL = window.HandPoseLogic;
const R = window.PNDS_RENDER;

// No App bridge on a phone: the page picks its locale from the device
// language (locale.js is loaded but its bridge wiring simply stays
// idle).
const locale = window.PNDS_LOCALE.pickLocale(navigator.language);
const T = P.copy[locale].performer;

const app = document.getElementById("app");
app.className = "performer-instrument";

app.innerHTML =
  '<div class="brand"><svg viewBox="0 0 28 20" fill="none" aria-hidden="true"><path d="M3 10h4l3-7 5 14 3-7h7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span>PNDS UTILITY</span></div>' +
  "<header><h1>" +
  T.title +
  '</h1><p class="sub">' +
  T.sub +
  "</p></header>" +
  '<div class="device-connection"><div><p class="device-k" id="device-label"></p><span class="perf-id" id="device-number">—</span></div><p class="connection-status" id="conn-status" role="status">' +
  T.connecting +
  "</p></div>" +
  '<p class="capture-guide">' +
  T.guide +
  "</p>" +
  '<div class="perf">' +
  sensorCardHtml("tilt") +
  sensorCardHtml("motion") +
  sensorCardHtml("mic") +
  handposeCardHtml() +
  "</div>";

function sensorCardHtml(sensor) {
  const title =
    sensor === "tilt"
      ? T.tiltTitle
      : sensor === "motion"
        ? T.motionTitle
        : T.micTitle;
  return (
    '<div class="card" id="card-' +
    sensor +
    '">' +
    '<div class="sensor-head">' +
    "<h2>" +
    title +
    "</h2>" +
    '<button type="button" aria-describedby="note-' +
    sensor +
    '" id="btn-' +
    sensor +
    '">' +
    T.enable +
    "</button>" +
    "</div>" +
    '<p class="sensor-note" role="status" id="note-' +
    sensor +
    '"></p>' +
    '<div id="values-' +
    sensor +
    '"></div>' +
    "</div>"
  );
}

// The handpose card carries its own preview stage: the raw camera
// (mirrored for the selfie view — CSS only, the frame data the model
// sees stays unmirrored) with the keypoint overlay drawn on top.
function handposeCardHtml() {
  return (
    '<div class="card" id="card-handpose">' +
    '<div class="sensor-head">' +
    "<h2>" +
    T.handposeTitle +
    "</h2>" +
    '<button type="button" aria-describedby="note-handpose" id="btn-handpose">' +
    T.enable +
    "</button>" +
    "</div>" +
    '<div class="hp-preview">' +
    '<video id="hp-video" playsinline muted autoplay></video>' +
    '<canvas id="hp-canvas"></canvas>' +
    "</div>" +
    '<p class="sensor-note" role="status" id="note-handpose"></p>' +
    '<div id="values-handpose"></div>' +
    "</div>"
  );
}

const connEl = document.getElementById("conn-status");
const deviceEl = document.getElementById("device-label");

const els = {
  tilt: sensorEls("tilt"),
  motion: sensorEls("motion"),
  mic: sensorEls("mic"),
  handpose: sensorEls("handpose"),
};

function sensorEls(sensor) {
  return {
    button: document.getElementById("btn-" + sensor),
    note: document.getElementById("note-" + sensor),
    values: document.getElementById("values-" + sensor),
  };
}

// ------------------------------------------------------------ socket

// Same-origin connection: works over plain HTTP and under the App's
// HTTPS entry without a single branch.
const socket = io({ reconnection: true, reconnectionDelay: 1000 });

let deviceId = null;
let connected = false;

socket.on(P.events.joined, (data) => {
  localStorage.setItem(P.tokenKey, data.token);
  deviceId = data.id;
  deviceEl.textContent = T.device + data.id + (data.recovered ? " ✓" : "");
  document.getElementById("device-number").textContent = String(
    data.id,
  ).padStart(2, "0");
  setConnection(T.connected);
});

socket.on(P.events.rejected, (data) => {
  setConnection(T.rejected + (data && data.reason ? data.reason : ""));
});

socket.on("connect", () => {
  connected = true;
  // Fires on first connect and after every reconnect: (re)join with the
  // persisted token so the server hands back the same device id — a
  // reconnect never becomes another device.
  socket.emit(P.events.join, {
    token: localStorage.getItem(P.tokenKey) || null,
  });
  socket.emit(P.events.sensorResume);
});

socket.on("disconnect", () => {
  connected = false;
  document.getElementById("device-number").textContent = "—";
  setConnection(T.connecting);
});

// Liveness ONLY — this never claims freshness (the server derives that
// from actual samples alone).
const heartbeatTimer = setInterval(() => {
  if (connected) {
    socket.emit(P.events.heartbeat);
  }
}, 2000);

// ------------------------------------------------------------ sensors

const lastShown = { tilt: null, motion: null, mic: null, handpose: null };

const controller = new S.SensorController(
  {
    now: () => performance.now(),
    addEventListener: (type, fn) => window.addEventListener(type, fn),
    removeEventListener: (type, fn) => window.removeEventListener(type, fn),
    orientationEvent: window.DeviceOrientationEvent,
    motionEvent: window.DeviceMotionEvent,
  },
  {
    onState: renderStates,
    onStart: (sensor, permission) => {
      socket.emit(P.events.sensorStart, { sensor, permission });
      renderStates();
    },
    onStop: (sensor) => {
      socket.emit(P.events.sensorStop, { sensor });
      renderStates();
    },
    onPermission: (sensor, permission) => {
      socket.emit(P.events.sensorPermission, { sensor, permission });
      renderStates();
    },
    onSend: (sensor, sample, seq) => {
      if (deviceId !== null) {
        socket.emit(P.events.sensorSample, {
          sensor,
          seq,
          [sensor]: sample,
        });
      }

      renderSample(sensor, sample, seq);
    },
  },
);

for (const sensor of S.SENSOR_IDS) {
  els[sensor].button.addEventListener("click", () => {
    if (isCapturing(controller.stateOf(sensor))) {
      controller.stop(sensor);
    } else {
      controller.start(sensor);
    }
  });
}

// ------------------------------------------------------------ microphone

function stopStreamTracks(stream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

// The mic's analysis plumbing. openAnalyser builds the graph and
// NOTHING else: the stream feeds the analyser only — never a
// destination — so the captured audio is never played back (no echo,
// ever). close() tears the whole thing down: tracks stopped, context
// closed — the exclusive resource is fully released.
function openAnalyser(stream, blockSize) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();

  analyser.fftSize = blockSize;
  source.connect(analyser);

  // Safari sometimes hands over a suspended context even inside the
  // grant chain; analysis only flows while it runs.
  if (context.state === "suspended") {
    context.resume().catch(() => {});
  }

  return {
    sampleRate: context.sampleRate,
    read(block) {
      analyser.getFloatTimeDomainData(block);
    },
    close() {
      try {
        source.disconnect();
      } catch {
        // Already torn down — nothing to release twice.
      }

      stopStreamTracks(stream);

      if (typeof context.close === "function") {
        context.close().catch(() => {});
      }
    },
  };
}

const mic = new ML.MicController(
  {
    now: () => performance.now(),
    // A non-secure context hides navigator.mediaDevices entirely — the
    // controller reports "unsupported" and the note says why (HTTPS).
    getUserMedia:
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function"
        ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        : null,
    releaseStream: stopStreamTracks,
    openAnalyser,
    schedule: (fn, intervalMs) => {
      const id = setInterval(fn, intervalMs);
      return () => clearInterval(id);
    },
  },
  {
    onState: renderMicState,
    onStart: (permission) => {
      socket.emit(P.events.sensorStart, { sensor: "mic", permission });
      renderMicState();
    },
    onStop: () => {
      socket.emit(P.events.sensorStop, { sensor: "mic" });
      renderMicState();
    },
    onPermission: (permission) => {
      socket.emit(P.events.sensorPermission, { sensor: "mic", permission });
      renderMicState();
    },
    onSend: (sample, seq) => {
      if (deviceId !== null) {
        socket.emit(P.events.sensorSample, {
          sensor: "mic",
          seq,
          mic: sample,
        });
      }

      renderSample("mic", sample, seq);
    },
  },
);

els.mic.button.addEventListener("click", () => {
  if (isCapturing(mic.stateOf())) {
    mic.stop();
  } else {
    mic.start();
  }
});

function isCapturing(state) {
  return state === "on" || state === "starting";
}

// ------------------------------------------------------------ handpose (#144)

// The lazy loader for the SAME-ORIGIN ml5 bundle: nothing of ml5 costs
// a byte until the user actually enables the hand card, and what loads
// comes from this server's /__pnds/shared/ — never a CDN. A bundle that has
// already loaded resolves immediately: a re-enable (e.g. after a model
// error) must not re-execute the script.
const loadedVendorScripts = new Set();

function loadVendorScript(src) {
  if (loadedVendorScripts.has(src)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => {
      loadedVendorScripts.add(src);
      resolve();
    };
    script.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(script);
  });
}

// ml5's wrapper exposes no dispose of its own; the underlying
// hand-pose-detection detector has one — release the GPU memory
// through it when present.
//
// TWO platform facts meet here, both found on a real phone:
// - ml5 1.4.0, with no p5 on the page, replaces every factory with a
//   promise-returning one — handPose(config) resolves to the instance
//   instead of returning it. This wrapper awaits both shapes.
// - The backend is pinned to WebGL (CPU fallback) BEFORE the weights
//   load: tf.ready() prefers WebGPU where present, and this model has
//   no honest GPU path for video on tfjs 4.22 — WebGPU uploads video
//   elements as blank frames (zero hands), WebGL's video upload poisons
//   the GL state and every later inference returns NaN (a constant
//   phantom hand, since NaN scores bypass the 0.5 threshold). The
//   WebGL pin keeps the GPU speed for the canvas-frame input that
//   hpFrameCopy() feeds — pixel-verified honest on every engine.
function wrapMl5HandPose(config) {
  let real = null;

  return {
    ready: (async () => {
      const tf = window.ml5 && window.ml5.tf;

      if (tf && typeof tf.setBackend === "function") {
        try {
          if ((await tf.setBackend("webgl")) === false) {
            throw new Error("webgl backend unavailable");
          }

          await tf.ready();
        } catch {
          await tf.setBackend("cpu").catch(() => {});
          await tf.ready();
        }
      }

      const handed = window.ml5.handPose(config);
      const thenable = (value) =>
        Boolean(value) && typeof value.then === "function";
      const instance = thenable(handed) ? await handed : handed;

      if (!instance || typeof instance.detect !== "function") {
        throw new Error("ml5 handPose() resolved without a usable instance");
      }

      real = instance;
      return instance;
    })(),
    detect: (media) => real.detect(media),
    dispose() {
      if (real && real.model && typeof real.model.dispose === "function") {
        real.model.dispose();
      }
    },
  };
}

function hpVideo() {
  return document.getElementById("hp-video");
}

// The frame the model sees: an OFFSCREEN 2d-canvas copy of the video,
// refreshed per tick. tfjs 4.22's GPU backends must NEVER touch the
// video element — WebGL's texImage2D from a MediaStream video corrupts
// the GL state and every inference afterwards returns NaN (NaN scores
// then bypass the 0.5 detector threshold, so the card reads a constant
// phantom hand), and WebGPU uploads videos as blank frames. A 2d
// canvas copy reads back honestly on every engine (pixel-verified),
// costs ~1–2 ms at 640×480, and the preview keeps its own video
// element untouched. No frames yet → null (the controller skips the
// tick; "no frames" is not "no hand").
const hpFrame =
  typeof document !== "undefined" && document.createElement
    ? document.createElement("canvas")
    : null;

function hpFrameCopy() {
  const video = hpVideo();

  if (!video || video.videoWidth === 0 || video.videoHeight === 0 || !hpFrame) {
    return null;
  }

  if (hpFrame.width !== video.videoWidth) {
    hpFrame.width = video.videoWidth;
  }

  if (hpFrame.height !== video.videoHeight) {
    hpFrame.height = video.videoHeight;
  }

  const context = hpFrame.getContext("2d");

  if (!context) {
    return null;
  }

  context.drawImage(video, 0, 0, hpFrame.width, hpFrame.height);
  return hpFrame;
}

const handpose = new HPL.HandPoseController(
  {
    now: () => performance.now(),
    getUserMedia:
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function"
        ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        : null,
    releaseStream: stopStreamTracks,
    attachStream(stream) {
      const video = hpVideo();
      video.srcObject = stream;
      video.play().catch(() => {});
    },
    detachStream() {
      hpVideo().srcObject = null;
    },
    media: hpFrameCopy,
    mediaSize() {
      const video = hpVideo();
      return video && video.videoWidth > 0
        ? { width: video.videoWidth, height: video.videoHeight }
        : null;
    },
    loadScript: loadVendorScript,
    // The cheap GPU check the controller runs before paying for the
    // ml5 bundle: a page without WebGL (iOS Low Power Mode, restricted
    // webviews) cannot run the model at all. Returns null when fine,
    // the user-facing reason when not. Unprobeable → null (fail open:
    // the model loader's own error still speaks).
    webglProbe() {
      const canvas = document.createElement("canvas");

      if (typeof canvas.getContext !== "function") {
        return null;
      }

      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");

      if (!gl) {
        return T.webglUnavailable;
      }

      if (typeof gl.getExtension === "function") {
        const lose = gl.getExtension("WEBGL_lose_context");

        if (lose && typeof lose.loseContext === "function") {
          lose.loseContext(); // the probe must not hold a context slot
        }
      }

      return null;
    },
    createModel: wrapMl5HandPose,
    scriptSrc: "/__pnds/shared/ml5.js",
    modelUrls: {
      detectorModelUrl: "/vendor/handpose/detector/model.json",
      landmarkModelUrl: "/vendor/handpose/landmark/model.json",
    },
    schedule: (fn, intervalMs) => {
      const id = setInterval(fn, intervalMs);
      return () => clearInterval(id);
    },
  },
  {
    onState: renderHandposeState,
    onStart: (permission) => {
      socket.emit(P.events.sensorStart, { sensor: "handpose", permission });
      renderHandposeState();
    },
    onStop: () => {
      socket.emit(P.events.sensorStop, { sensor: "handpose" });
      renderHandposeState();
    },
    onPermission: (permission) => {
      socket.emit(P.events.sensorPermission, {
        sensor: "handpose",
        permission,
      });
      renderHandposeState();
    },
    onSend: (sample, seq) => {
      if (deviceId !== null) {
        socket.emit(P.events.sensorSample, {
          sensor: "handpose",
          seq,
          handpose: sample,
        });
      }

      lastShown.handpose = { sample, seq };
      drawHandposeOverlay(sample);
      document.getElementById("values-handpose").innerHTML = R.handposeRows(
        sample,
        T,
      );
    },
  },
);

els.handpose.button.addEventListener("click", () => {
  if (isHandposeActive(handpose.stateOf())) {
    handpose.stop();
  } else {
    handpose.start();
  }
});

function isHandposeActive(state) {
  return (
    state === "camera-starting" ||
    state === "loading-model" ||
    state === "running"
  );
}

// The overlay mirrors x to match the CSS-mirrored selfie preview — the
// wire coordinates themselves stay UNmirrored (the model's frame).
function drawHandposeOverlay(sample) {
  const canvas = document.getElementById("hp-canvas");

  if (!canvas || typeof canvas.getContext !== "function") {
    return;
  }

  const width = canvas.clientWidth || 0;
  const height = canvas.clientHeight || 0;

  if (width === 0 || height === 0) {
    return;
  }

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  context.clearRect(0, 0, width, height);

  if (
    sample.hands === 0 ||
    !Array.isArray(sample.keypoints) ||
    sample.keypoints.length === 0
  ) {
    return; // no hand: the cleared overlay IS the no-hand display
  }

  const px = (point) => [(1 - point.x) * width, point.y * height];
  const drawable = (point) =>
    point &&
    point.x !== null &&
    point.y !== null &&
    point.x !== undefined &&
    point.y !== undefined;

  context.strokeStyle = "#86efac";
  context.lineWidth = 2;

  for (const [from, to] of P.handConnections) {
    const a = sample.keypoints[from];
    const b = sample.keypoints[to];

    if (!drawable(a) || !drawable(b)) {
      continue;
    }

    const [x1, y1] = px(a);
    const [x2, y2] = px(b);
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  }

  context.fillStyle = "#f9fbfa";

  for (const point of sample.keypoints) {
    if (!drawable(point)) {
      continue;
    }

    const [x, y] = px(point);
    context.beginPath();
    context.arc(x, y, 4, 0, Math.PI * 2);
    context.fill();
  }
}

// The local-asset inventory, fetched once: when the vendor files are
// missing the card says the FIX (npm run fetch:handpose on the host)
// before the user ever hits a model error.
let handposeAssetsOk = null;

if (typeof fetch === "function") {
  fetch("/handpose/assets.json")
    .then((response) => response.json())
    .then((assets) => {
      handposeAssetsOk = Boolean(assets && assets.ok);
      renderHandposeState();
    })
    .catch(() => {});
}

function renderHandposeState() {
  const state = handpose.stateOf();
  const note = els.handpose.note;
  const button = els.handpose.button;

  button.classList.toggle("stop", isHandposeActive(state));
  button.textContent = isHandposeActive(state) ? T.stop : T.enable;
  button.setAttribute("aria-pressed", String(isHandposeActive(state)));

  if (handpose.paused && isHandposeActive(state)) {
    note.textContent = T.paused;
    note.classList.add("bad");
    return;
  }

  note.classList.remove("bad");

  switch (state) {
    case "camera-starting":
      note.textContent = T.cameraAsk;
      break;
    case "camera-denied":
      note.textContent = T.permissionDenied;
      note.classList.add("bad");
      break;
    case "unsupported":
      note.textContent = T.handposeUnsupported;
      note.classList.add("bad");
      break;
    case "loading-model":
      note.textContent = T.modelLoading;
      break;
    case "model-error":
      // The REAL reason first (WebGL probe, script fetch, tfjs init).
      // The fetch:handpose advice fits exactly one failure — an assets
      // inventory that says files are missing — and that hint lives on
      // the stopped card, not here.
      note.textContent = handpose.failureDetail()
        ? T.modelFailedPrefix + " " + handpose.failureDetail()
        : T.modelError;
      note.classList.add("bad");
      break;
    case "error":
      note.textContent = handpose.failureDetail()
        ? T.inferenceFailedPrefix + " " + handpose.failureDetail()
        : T.inferenceError;
      note.classList.add("bad");
      break;
    case "running":
      note.textContent = "";
      break;
    default:
      // Stopped: the frozen last values stay readable; the note says
      // the capture ended (or the asset hint, before anything ran).
      if (lastShown.handpose) {
        note.textContent = T.stopped;
      } else if (handposeAssetsOk === false) {
        note.textContent = T.modelError;
        note.classList.add("bad");
      } else {
        note.textContent = "";
      }
  }

  if (state === "running" && lastShown.handpose === null) {
    els.handpose.values.innerHTML = R.naSpan(T.noData);
  }
}

// ------------------------------------------------------------ page visibility

// Backgrounded pages pause capture and say so; coming back resumes the
// sensors the user left ON — stopped ones stay stopped (nothing ever
// restarts capture on its own). The mic and the handpose camera RELEASE
// their streams here (exclusive resources must not outlive the
// foreground) and re-acquire silently on return; the handpose MODEL is
// memory, not a device — it stays loaded for a fast resume.
function pauseCapture() {
  controller.pause();
  mic.pause();
  handpose.pause();
  socket.emit(P.events.sensorPause);
  renderStates();
  renderMicState();
  renderHandposeState();
}

function resumeCapture() {
  controller.resume();
  mic.resume();
  handpose.resume();
  socket.emit(P.events.sensorResume);
  renderStates();
  renderMicState();
  renderHandposeState();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    pauseCapture();
  } else {
    resumeCapture();
  }
});

window.addEventListener("pagehide", pauseCapture);

// ------------------------------------------------------------ rendering

function setConnection(text) {
  connEl.textContent = text;
}

function renderStates() {
  for (const sensor of S.SENSOR_IDS) {
    renderSensorState(sensor);
  }
}

function renderSensorState(sensor) {
  const state = controller.stateOf(sensor);
  const note = els[sensor].note;
  const button = els[sensor].button;

  button.classList.toggle("stop", isCapturing(state));
  button.textContent = isCapturing(state) ? T.stop : T.enable;
  button.setAttribute("aria-pressed", String(isCapturing(state)));

  if (controller.paused && isCapturing(state)) {
    note.textContent = T.paused;
    note.classList.add("bad");
    return;
  }

  note.classList.remove("bad");

  switch (state) {
    case "starting":
      note.textContent = T.permissionAsk;
      break;
    case "denied":
      note.textContent = T.permissionDenied;
      note.classList.add("bad");
      break;
    case "unsupported":
      note.textContent = T.unsupported;
      note.classList.add("bad");
      break;
    case "error":
      note.textContent = T.error;
      note.classList.add("bad");
      break;
    case "on":
      note.textContent = "";
      break;
    default:
      // Stopped: the frozen last sample stays readable in the values
      // block; the note says the capture ended.
      note.textContent = lastShown[sensor] ? T.stopped : "";
  }

  if (state === "on" && lastShown[sensor] === null) {
    els[sensor].values.innerHTML = R.naSpan(T.noData);
  }
}

function renderSample(sensor, sample, seq) {
  lastShown[sensor] = { sample, seq };
  els[sensor].values.innerHTML = R.rowsFor(sensor, sample, T);
}

function renderMicState() {
  const state = mic.stateOf();
  const note = els.mic.note;
  const button = els.mic.button;

  button.classList.toggle("stop", isCapturing(state));
  button.textContent = isCapturing(state) ? T.stop : T.enable;
  button.setAttribute("aria-pressed", String(isCapturing(state)));

  if (mic.paused && isCapturing(state)) {
    note.textContent = T.paused;
    note.classList.add("bad");
    return;
  }

  note.classList.remove("bad");

  switch (state) {
    case "starting":
      note.textContent = T.permissionAsk;
      break;
    case "denied":
      note.textContent = T.permissionDenied;
      note.classList.add("bad");
      break;
    case "unsupported":
      // The mic's own unsupported note: a plain-HTTP page has no
      // navigator.mediaDevices at all — the fix is the secure context,
      // not a browser change.
      note.textContent = T.micUnsupported;
      note.classList.add("bad");
      break;
    case "error":
      note.textContent = T.error;
      note.classList.add("bad");
      break;
    case "on":
      note.textContent = "";
      break;
    default:
      // Stopped: the frozen last sample stays readable in the values
      // block; the note says the capture ended.
      note.textContent = lastShown.mic ? T.stopped : "";
  }

  if (state === "on" && lastShown.mic === null) {
    els.mic.values.innerHTML = R.naSpan(T.noData);
  }
}

renderStates();
renderMicState();
renderHandposeState();
