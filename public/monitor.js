// Mobile Sensor Diagnostics — monitor page.
//
// Operator console: one card per device the server currently presents,
// keyed by the stable device id (a reconnect keeps the id — data never
// crosses devices). A device that DISCONNECTS stays visible for a short
// grace window (network blips must not flicker cards out and back), then
// leaves the roster — a ghost join (a link preview, a stray tab) never
// sits on the console forever; the returning device recovers its id.
//
// Each card shows both sensors' capture/permission state, the DERIVED
// freshness (waiting / live / stopped updating / paused / off /
// disconnected — never a heartbeat dressed as data), and the values.
// Values render at FRAME RATE (requestAnimationFrame): each number
// exponentially approaches the newest sample (the SuperCollider
// control-rate idea — the wire computes at ~30 Hz, the display presents
// continuously). No rate counters anywhere.
//
// The card structure (roster, chips) rebuilds only when a device's SHAPE
// changes (joined, left, capture/permission/freshness vocabulary); the
// value rows update in place every frame. The QR and copyable address
// below carry the same resolved performer URL the server fixed at
// startup (§15).
//
// The monitor stays INTERNAL (§15): it is served on the monitor port
// over plain HTTP and connects cross-port to the performer server —
// it never rides the App's HTTPS entry.

const P = window.PNDS;
const L = window.PNDS_LOCALE;
const R = window.PNDS_RENDER;

const SENSORS = ["tilt", "motion"];

// Smoothing time constant: the display glides ~2/3 of the way to a new
// value in one τ. 100 ms reads fluid without feeling laggy against a
// 30 Hz wire.
const SMOOTH_TAU_MS = 100;

const app = document.getElementById("app");

let state = { sensors: { devices: {} } }; // latest "state" broadcast

// Per-device smoothed display values: id -> sensor -> value block
// ({alpha,beta,gamma} / {x,y,z,...}) or null. Seeded from the newest
// sample on rebuild; advanced toward it every frame. Never a history —
// one value block per sensor, like the wire.
const smoothed = {};
const valueEls = {}; // id -> sensor -> the values container element
let visibleIds = [];

app.innerHTML =
  "<header>" +
  "<h1>" + titleText() + "</h1>" +
  '<span class="sub" id="sub-label"></span>' +
  "</header>" +
  '<div class="mon">' +
  '<div class="devices" id="devices"></div>' +
  '<p class="hint" id="empty"></p>' +
  '<div class="qr-row">' +
  '<img src="/qr" id="qr-img" alt="" />' +
  '<span class="sub" id="scan-label"></span>' +
  '<span class="address" id="address-label"></span>' +
  "</div>" +
  "</div>";

const devicesEl = document.getElementById("devices");
const emptyEl = document.getElementById("empty");

// Cross-port, internal-only connection to the performer server.
const socket = io("http://" + location.hostname + ":" + P.performerPort, {
  reconnection: true,
  reconnectionDelay: 1000,
});

socket.on(P.events.state, (payload) => {
  if (payload && payload.sensors) {
    state = payload;
  }

  render();
});

// Re-render on every language switch (the App pushes locale changes
// live); idempotent by construction.
L.subscribe(() => render());

function titleText() {
  return P.copy[L.current()].monitor.title;
}

// What forces a full card rebuild: the visible roster plus every
// vocabulary on it. Newer sample VALUES only touch the value rows,
// which the frame loop rewrites anyway.
function shapeFingerprint() {
  const devices = state.sensors.devices;
  const parts = [visibleIds.join(",")];

  for (const id of visibleIds) {
    const device = devices[id];
    parts.push(
      id,
      device.connected ? "connected" : "disconnected",
      device.paused ? "paused" : "-",
      SENSORS.map((sensor) => {
        const record = device.sensors[sensor];
        return sensor + ":" + record.capture + ":" + record.permission + ":" + record.freshness;
      }).join("|"),
    );
  }

  return parts.join(";");
}

let lastShape = null;

function render() {
  const T = P.copy[L.current()].monitor;

  document.getElementById("sub-label").textContent = T.sub;
  document.getElementById("scan-label").textContent = T.scan;
  document
    .getElementById("qr-img")
    .setAttribute("alt", T.qrAlt);
  document.getElementById("address-label").textContent = T.address + ": " + P.performerUrl;

  visibleIds = R.visibleDeviceIds(state.sensors.devices, state.sensors.at);

  emptyEl.textContent = visibleIds.length === 0 ? T.empty : "";

  const shape = shapeFingerprint() + "#" + L.current();

  if (shape !== lastShape) {
    lastShape = shape;
    rebuildCards(T);
  }
}

function rebuildCards(T) {
  devicesEl.innerHTML = visibleIds
    .map((id) => deviceHtml(state.sensors.devices[id], T))
    .join("");

  // (Re)bind the value containers and seed the display values from the
  // newest known sample — a rebuild never makes the numbers glide from
  // an old position or from zero.
  for (const key of Object.keys(smoothed)) {
    delete smoothed[key];
  }

  for (const key of Object.keys(valueEls)) {
    delete valueEls[key];
  }

  for (const id of visibleIds) {
    const device = state.sensors.devices[id];

    valueEls[id] = {};
    smoothed[id] = {};

    for (const sensor of SENSORS) {
      valueEls[id][sensor] = document.getElementById("values-" + id + "-" + sensor);
      const sample = device.sensors[sensor].sample;
      smoothed[id][sensor] = sample ? cloneValueBlock(sensor, sampleValueBlock(sensor, sample)) : null;
    }
  }

  paintValues(0);
}

// One frame of the display leg: advance every visible value block
// toward the newest sample and write the rows. dt = 0 (the rebuild
// path) seeds and paints without gliding.
function paintValues(dtMs) {
  const T = P.copy[L.current()].monitor;

  for (const id of visibleIds) {
    const device = state.sensors.devices[id];

    if (!device) {
      continue;
    }

    for (const sensor of SENSORS) {
      paintSensor(id, sensor, device, T, dtMs);
    }
  }
}

function paintSensor(id, sensor, device, T, dtMs) {
  const el = valueEls[id] && valueEls[id][sensor];

  if (!el) {
    return;
  }

  const sample = device.sensors[sensor].sample;

  if (sample === null) {
    // No sample yet (or a fresh capture just started): the row says so
    // — authorized-without-data is a state, never a zero.
    smoothed[id][sensor] = null;
    el.innerHTML = R.row(T.freshness, R.naSpan(T.unavailable));
    return;
  }

  const target = sampleValueBlock(sensor, sample);
  let current = smoothed[id][sensor];

  if (current === null) {
    current = cloneValueBlock(sensor, target);
  } else {
    current = advanceValueBlock(sensor, current, target, dtMs);
  }

  smoothed[id][sensor] = current;

  el.innerHTML =
    (sensor === "tilt" ? R.tiltRows(current, T) : R.motionRows(current, T)) +
    R.row(T.freshness, ageText(device.sensors[sensor], T));
}

function sampleValueBlock(sensor, sample) {
  return sensor === "tilt" ? sample.tilt : sample.motion;
}

function cloneValueBlock(sensor, block) {
  return sensor === "tilt"
    ? { alpha: block.alpha, beta: block.beta, gamma: block.gamma }
    : {
        x: block.x,
        y: block.y,
        z: block.z,
        includesGravity: block.includesGravity,
        intensity: block.intensity,
        shakeCount: block.shakeCount,
      };
}

function advanceValueBlock(sensor, current, target, dtMs) {
  if (sensor === "tilt") {
    return {
      alpha: R.approachField(current.alpha, target.alpha, dtMs, SMOOTH_TAU_MS, true),
      beta: R.approachField(current.beta, target.beta, dtMs, SMOOTH_TAU_MS, false),
      gamma: R.approachField(current.gamma, target.gamma, dtMs, SMOOTH_TAU_MS, false),
    };
  }

  return {
    x: R.approachField(current.x, target.x, dtMs, SMOOTH_TAU_MS, false),
    y: R.approachField(current.y, target.y, dtMs, SMOOTH_TAU_MS, false),
    z: R.approachField(current.z, target.z, dtMs, SMOOTH_TAU_MS, false),
    includesGravity: target.includesGravity,
    intensity: R.approachField(current.intensity, target.intensity, dtMs, SMOOTH_TAU_MS, false),
    // A count is a count: events, not a smoothed magnitude.
    shakeCount: target.shakeCount,
  };
}

// The frame loop. rAF paces the smoothing; a page without it (the test
// harness drives paintValues directly) simply has no loop.
let lastFrameAt = null;

function frame(nowMs) {
  const dt = lastFrameAt === null ? SMOOTH_TAU_MS / 10 : Math.min(nowMs - lastFrameAt, 250);
  lastFrameAt = nowMs;

  paintValues(dt);
  requestAnimationFrame(frame);
}

if (typeof requestAnimationFrame === "function") {
  requestAnimationFrame(frame);
}

function deviceHtml(device, T) {
  return (
    '<div class="card device" data-device="' + device.id + '">' +
    '<div class="device-head">' +
    "<h2>" + T.device + device.id + "</h2>" +
    freshnessChip(device.connected ? deviceOverallFreshness(device) : P.freshness.disconnected, T) +
    "</div>" +
    sensorBlockHtml(device, device.sensors.tilt, T, true) +
    sensorBlockHtml(device, device.sensors.motion, T, false) +
    "</div>"
  );
}

// The card-level chip: the WORST freshness across the device's sensors
// (an operator scanning the room sees the problem first — a device
// with one live and one dead sensor must not read "live").
const FRESHNESS_SEVERITY = [
  P.freshness.live, // mildest
  P.freshness.off,
  P.freshness.waiting,
  P.freshness.stale,
  P.freshness.paused,
  P.freshness.disconnected, // worst
];

function deviceOverallFreshness(device) {
  if (device.paused) {
    return P.freshness.paused;
  }

  let worst = FRESHNESS_SEVERITY[0];

  for (const sensor of SENSORS) {
    const freshness = device.sensors[sensor].freshness;

    if (FRESHNESS_SEVERITY.indexOf(freshness) > FRESHNESS_SEVERITY.indexOf(worst)) {
      worst = freshness;
    }
  }

  return worst;
}

function sensorBlockHtml(device, sensor, T, isTilt) {
  const sensorId = isTilt ? "tilt" : "motion";
  const sample = sensor.sample;

  // The value rows live in their own container the frame loop rewrites;
  // the rebuild paints them once from the newest sample so a card never
  // appears blank.
  let values;

  if (sample === null) {
    values = R.row(T.freshness, R.naSpan(T.unavailable));
  } else if (isTilt) {
    values = R.tiltRows(sample.tilt, T);
  } else {
    values = R.motionRows(sample.motion, T);
  }

  return (
    '<div class="sensor-block">' +
    "<h3>" +
    (isTilt ? T.tilt : T.motion) +
    freshnessChip(sensor.freshness, T) +
    permissionChip(sensor.permission, T) +
    "</h3>" +
    '<div id="values-' + device.id + "-" + sensorId + '">' +
    values +
    R.row(T.freshness, ageText(sensor, T)) +
    "</div>" +
    "</div>"
  );
}

function freshnessChip(freshness, T) {
  return '<span class="chip ' + freshness + '">' + T.freshnessWord[freshness] + "</span>";
}

function permissionChip(permission, T) {
  return '<span class="chip ' + permission + '">' + T.permissionWord[permission] + "</span>";
}

// How old the newest sample is — the honest freshness evidence. Only
// meaningful with a sample in hand.
function ageText(sensor, T) {
  if (sensor.sample === null) {
    return R.naSpan(T.unavailable);
  }

  const ageMs = state.sensors.at - sensor.sample.at;

  if (ageMs < 1000) {
    return '<span class="value">' + T.ago.just + "</span>";
  }

  const seconds = Math.floor(ageMs / 1000);

  if (seconds < 60) {
    return '<span class="value">' + seconds + T.ago.seconds + "</span>";
  }

  return '<span class="value">' + Math.floor(seconds / 60) + T.ago.minutes + "</span>";
}

render();
