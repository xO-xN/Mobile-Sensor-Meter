// Mobile Sensor Meter — performer page.
//
// The phone is the sensor: two cards (tilt, motion), each with the
// user's explicit Enable/Stop pair — iOS requires the permission
// request to happen inside a user gesture, so capture NEVER starts on
// its own. The value readout binds to the SEND path (the exact sample
// that goes on the wire is the sample the phone displays), so what the
// operator sees on the monitor and what the holder sees are the same
// facts. No rate counters anywhere — the monitor renders at frame rate,
// smoothing toward the newest sample; smoothness is the deliverable.
//
// The page connects SAME-ORIGIN (io() with no URL): over plain HTTP
// that is the performer port; under the App's trusted-HTTPS entry it
// is the entry origin — zero page branches on which it is (#138).

const P = window.PNDS;
const S = window.SensorLogic;
const R = window.PNDS_RENDER;

// No App bridge on a phone: the page picks its locale from the device
// language (locale.js is loaded but its bridge wiring simply stays
// idle).
const locale = window.PNDS_LOCALE.pickLocale(navigator.language);
const T = P.copy[locale].performer;

const app = document.getElementById("app");

app.innerHTML =
  "<header>" +
  "<h1>" + T.title + "</h1>" +
  '<span class="sub">' + T.sub + "</span>" +
  "</header>" +
  '<div class="perf">' +
  '<p class="hint" id="conn-status">' + T.connecting + "</p>" +
  '<p class="hint" id="device-label"></p>' +
  sensorCardHtml("tilt") +
  sensorCardHtml("motion") +
  "</div>";

function sensorCardHtml(sensor) {
  const title = sensor === "tilt" ? T.tiltTitle : T.motionTitle;
  return (
    '<div class="card" id="card-' + sensor + '">' +
    '<div class="sensor-head">' +
    "<h2>" + title + "</h2>" +
    '<button id="btn-' + sensor + '">' + T.enable + "</button>" +
    "</div>" +
    '<p class="sensor-note" id="note-' + sensor + '"></p>' +
    '<div id="values-' + sensor + '"></div>' +
    "</div>"
  );
}

const connEl = document.getElementById("conn-status");
const deviceEl = document.getElementById("device-label");

const els = {
  tilt: sensorEls("tilt"),
  motion: sensorEls("motion"),
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

const lastShown = { tilt: null, motion: null };

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

function isCapturing(state) {
  return state === "on" || state === "starting";
}

// ------------------------------------------------------------ page visibility

// Backgrounded pages pause capture and say so; coming back resumes the
// sensors the user left ON — stopped ones stay stopped (nothing ever
// restarts capture on its own).
function pauseCapture() {
  controller.pause();
  socket.emit(P.events.sensorPause);
  renderStates();
}

function resumeCapture() {
  controller.resume();
  socket.emit(P.events.sensorResume);
  renderStates();
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

  let html;

  if (sensor === "tilt") {
    html = R.tiltRows(sample, T);
  } else {
    html = R.motionRows(sample, T);
  }

  els[sensor].values.innerHTML = html;
}

renderStates();
