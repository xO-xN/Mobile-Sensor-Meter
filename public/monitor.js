// Mobile Sensor Diagnostics — monitor page.
//
// Operator console: one card per device ever joined, keyed by the
// stable device id (a reconnect keeps the id — data never crosses
// devices). Each card shows both sensors' capture/permission state,
// the DERIVED freshness (waiting / live / stopped updating / paused /
// disconnected — never a heartbeat dressed as data), the latest
// sample's values with units and seq, and how old it is. The QR and
// copyable address below carry the same resolved performer URL the
// server fixed at startup (§15).
//
// The monitor stays INTERNAL (§15): it is served on the monitor port
// over plain HTTP and connects cross-port to the performer server —
// it never rides the App's HTTPS entry.

const P = window.PNDS;
const L = window.PNDS_LOCALE;
const R = window.PNDS_RENDER;

const app = document.getElementById("app");

let state = { sensors: { devices: {} } }; // latest "state" broadcast

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

function render() {
  const T = P.copy[L.current()].monitor;

  document.getElementById("sub-label").textContent = T.sub;
  document.getElementById("scan-label").textContent = T.scan;
  document
    .getElementById("qr-img")
    .setAttribute("alt", T.qrAlt);
  document.getElementById("address-label").textContent = T.address + ": " + P.performerUrl;

  const ids = Object.keys(state.sensors.devices).sort((a, b) => a - b);

  emptyEl.textContent = ids.length === 0 ? T.empty : "";

  devicesEl.innerHTML = ids
    .map((id) => deviceHtml(state.sensors.devices[id], T))
    .join("");
}

function deviceHtml(device, T) {
  return (
    '<div class="card device" data-device="' + device.id + '">' +
    '<div class="device-head">' +
    "<h2>" + T.device + device.id + "</h2>" +
    freshnessChip(device.connected ? deviceOverallFreshness(device) : P.freshness.disconnected, T) +
    "</div>" +
    sensorBlockHtml(device.sensors.tilt, T, true) +
    sensorBlockHtml(device.sensors.motion, T, false) +
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

  for (const sensor of ["tilt", "motion"]) {
    const freshness = device.sensors[sensor].freshness;

    if (FRESHNESS_SEVERITY.indexOf(freshness) > FRESHNESS_SEVERITY.indexOf(worst)) {
      worst = freshness;
    }
  }

  return worst;
}

function sensorBlockHtml(sensor, T, isTilt) {
  const sample = sensor.sample;

  let values;

  if (sample === null) {
    values = R.row(T.seq, R.naSpan(T.unavailable));
  } else if (isTilt) {
    values =
      R.seqRow(sample.seq, T) +
      R.tiltRows(sample.tilt, T) +
      R.row(T.freshness, ageText(sensor, T));
  } else {
    values =
      R.seqRow(sample.seq, T) +
      R.motionRows(sample.motion, T) +
      R.row(T.freshness, ageText(sensor, T));
  }

  return (
    '<div class="sensor-block">' +
    "<h3>" +
    (isTilt ? T.tilt : T.motion) +
    freshnessChip(sensor.freshness, T) +
    permissionChip(sensor.permission, T) +
    "</h3>" +
    values +
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
