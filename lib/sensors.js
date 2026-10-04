// Server-side sensor state hub.
//
// One SensorHub instance owns every joined device's sensor facts: capture
// state, permission vocabulary, the LATEST processed sample per sensor
// (never a history — the wire carries only newest values, so there is
// nothing here to accumulate), and the timestamps freshness is derived
// from. Pure logic, no timers: the server wires real time in and reads
// snapshots out, which keeps every rule here testable with a fake clock.
//
// The rules this module exists to enforce (spec #142, mic per #143):
// - A sample is accepted ONLY while its sensor is capturing. Every stop
//   advances the capture epoch; a sample from a stopped (or restarted)
//   capture is a late result and is rejected without touching state.
// - Sequence numbers are monotonic per sensor per capture; replays and
//   stale reorderings are rejected, so the seq the monitor displays is
//   exactly the seq the phone emitted for the value it shows.
// - Heartbeats update connection liveness ONLY. Freshness derives from
//   actual sample timestamps — a heartbeat can never make stale data
//   read as live.
// - Devices are isolated by id: a sample names its device at the socket
//   layer (the server resolves the id, the client never asserts one),
//   and nothing from device A ever lands on device B's record.
// - The mic (#143) rides the SAME protocol: its samples carry processed
//   level values only (never raw audio), and the phone's seq is
//   monotonic for the controller's life, so a re-acquired capture
//   (resume after background) keeps climbing past the last accepted seq
//   instead of reading as a replay.
// - The handpose leg (#144) rides it too: samples carry the latest
//   processed result only (normalized keypoints + meters — never video),
//   and its pause/resume re-acquisition likewise emits no second start,
//   relying on the same monotonic-seq contract.

const SENSORS = ["tilt", "motion", "mic", "handpose"];

// The production freshness window: how long a capturing sensor's
// newest sample stays "live" without a newer one. Exported so the
// server's env override (tests shrink it) keeps THIS as the single
// fallback — one number, one home.
const DEFAULT_STALE_AFTER_MS = 2000;

const PERMISSION_STATES = ["unknown", "granted", "denied", "unsupported"];

// Freshness vocabulary (derived in snapshot()):
//   "waiting"      — capturing, but no sample has arrived yet
//                    (authorized-without-data is a state, not zero)
//   "live"         — newest sample inside the freshness window
//   "stale"        — capturing, but the newest sample is past the window
//                    (data stopped updating; the last value stays readable)
//   "paused"       — the page reported itself backgrounded/hidden
//   "off"          — not capturing (stopped, or never started)
//   "disconnected" — the device's socket is gone
const FRESHNESS = {
  waiting: "waiting",
  live: "live",
  stale: "stale",
  paused: "paused",
  off: "off",
  disconnected: "disconnected",
};

function isSensorId(value) {
  return SENSORS.includes(value);
}

// A number the wire may carry: finite numbers pass (zero is a REAL
// reading and must never be folded into "missing"), everything else —
// null, undefined, NaN, ±Infinity, non-numbers — is "missing" (null).
function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The value block of one sample, per sensor. Unknown/absent blocks are
// rejected at the protocol layer; known blocks keep only the fields the
// monitor renders, nulls included (the display distinguishes them).
function sanitizeTilt(block) {
  return {
    alpha: readNumber(block.alpha),
    beta: readNumber(block.beta),
    gamma: readNumber(block.gamma),
  };
}

function sanitizeMotion(block) {
  return {
    x: readNumber(block.x),
    y: readNumber(block.y),
    z: readNumber(block.z),
    includesGravity: block.includesGravity === true,
    intensity: readNumber(block.intensity),
    shakeCount: readNumber(block.shakeCount),
  };
}

// The mic block: rms and peak are normalized float-PCM amplitudes (unit
// FS, [0, 1]); level is dBFS with its floor (public/mic-logic.js).
// Uncalibrated meter numbers — stored as-is, zeros included (a silent
// room is a REAL zero, never a missing field).
function sanitizeMic(block) {
  return {
    rms: readNumber(block.rms),
    peak: readNumber(block.peak),
    level: readNumber(block.level),
    sampleRate: readNumber(block.sampleRate),
  };
}

// The handpose block (#144): hands is a count (0 = "no hand detected",
// a RESULT like a silent room's real zeros — never missing), keypoints
// are the first hand's normalized [0,1] coordinates capped at the 21
// MediaPipe landmarks (absent array travels as null; an EMPTY array is
// the no-hand fact). Confidence, inferMs and rateHz are meter numbers
// with their units documented on the pages.
function sanitizeHandpose(block) {
  const keypoints = Array.isArray(block.keypoints)
    ? block.keypoints.slice(0, 21).map((point) => ({
        x: readNumber(point && point.x),
        y: readNumber(point && point.y),
      }))
    : null;

  return {
    hands: readNumber(block.hands),
    confidence: readNumber(block.confidence),
    keypoints,
    inferMs: readNumber(block.inferMs),
    rateHz: readNumber(block.rateHz),
  };
}

const SANITIZERS = {
  tilt: sanitizeTilt,
  motion: sanitizeMotion,
  mic: sanitizeMic,
  handpose: sanitizeHandpose,
};

class SensorHub {
  constructor({ staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
    if (!(staleAfterMs > 0)) {
      throw new Error("staleAfterMs must be a positive number.");
    }

    this.staleAfterMs = staleAfterMs;
    this.devices = new Map(); // id -> device record (see join())
  }

  // ------------------------------------------------------------
  // Device lifecycle
  // ------------------------------------------------------------

  join(id, at) {
    this.devices.set(id, {
      id,
      connected: true,
      paused: false,
      joinedAt: at,
      lastHeartbeatAt: at,
      disconnectedAt: null,
      sensors: Object.fromEntries(
        SENSORS.map((sensor) => [sensor, blankSensor(sensor, at)]),
      ),
    });
  }

  disconnect(id, at) {
    const device = this.devices.get(id);
    if (!device) {
      return;
    }

    device.connected = false;
    device.paused = false;
    device.disconnectedAt = at;
  }

  reconnect(id, at) {
    const device = this.devices.get(id);
    if (!device) {
      return;
    }

    device.connected = true;
    device.paused = false;
    device.disconnectedAt = null;
    device.lastHeartbeatAt = at;
  }

  heartbeat(id, at) {
    const device = this.devices.get(id);
    if (!device) {
      return;
    }

    // Liveness ONLY — freshness never reads this timestamp.
    device.lastHeartbeatAt = at;
  }

  pause(id, at) {
    const device = this.devices.get(id);
    if (!device) {
      return;
    }

    device.paused = true;
    device.pausedAt = at;
  }

  resume(id, at) {
    const device = this.devices.get(id);
    if (!device) {
      return;
    }

    device.paused = false;
    device.resumedAt = at;
  }

  // ------------------------------------------------------------
  // Per-sensor capture lifecycle
  // ------------------------------------------------------------

  // The phone starts a sensor once its capture is actually live
  // (permission granted, listeners attached). `permission` rides along
  // so the monitor can show the vocabulary the page reported.
  start(id, sensor, { at, permission } = {}) {
    const device = this.devices.get(id);
    if (!device || !isSensorId(sensor)) {
      return false;
    }

    const record = device.sensors[sensor];
    record.capture = "on";
    record.epoch += 1; // a NEW capture: samples from the old one are late
    record.permission =
      typeof permission === "string" && PERMISSION_STATES.includes(permission)
        ? permission
        : record.permission;
    record.startedAt = at;
    record.sample = null;

    return true;
  }

  // Stop advances the epoch: any sample still in flight (or emitted by a
  // queued event the page failed to detach) is a late result and will be
  // rejected by sample() below. The last accepted sample stays readable —
  // frozen, clearly off — never deleted.
  stop(id, sensor, { at, permission } = {}) {
    const device = this.devices.get(id);
    if (!device || !isSensorId(sensor)) {
      return false;
    }

    const record = device.sensors[sensor];
    record.capture = "off";
    record.epoch += 1;
    record.stoppedAt = at;
    if (
      typeof permission === "string" &&
      PERMISSION_STATES.includes(permission)
    ) {
      record.permission = permission;
    }

    return true;
  }

  // Permission facts can arrive without changing capture (a denied
  // request, an unsupported API, a late permission result after stop —
  // the fact is recorded, the capture is NOT restarted).
  setPermission(id, sensor, permission, { at } = {}) {
    const device = this.devices.get(id);
    if (
      !device ||
      !isSensorId(sensor) ||
      !PERMISSION_STATES.includes(permission)
    ) {
      return false;
    }

    const record = device.sensors[sensor];
    record.permission = permission;
    record.permissionAt = at;
    return true;
  }

  // ------------------------------------------------------------
  // Samples
  // ------------------------------------------------------------

  // Accepts the LATEST processed sample from a capturing sensor.
  // Returns { status: "accepted" } or { status: "rejected", reason }
  // with the record untouched. Rejection reasons:
  //   "unknown-device" / "unknown-sensor" — protocol errors
  //   "not-capturing"   — late result after stop (or before start)
  //   "stale-seq"       — replayed/reordered seq (<= last accepted)
  sample(id, sensor, payload, { at } = {}) {
    const device = this.devices.get(id);
    if (!device) {
      return { status: "rejected", reason: "unknown-device" };
    }
    if (!isSensorId(sensor)) {
      return { status: "rejected", reason: "unknown-sensor" };
    }

    const record = device.sensors[sensor];

    if (record.capture !== "on") {
      return { status: "rejected", reason: "not-capturing" };
    }

    if (!payload || typeof payload !== "object") {
      return { status: "rejected", reason: "malformed-payload" };
    }

    const seq = payload.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
      return { status: "rejected", reason: "malformed-seq" };
    }

    if (record.sample !== null && seq <= record.sample.seq) {
      return { status: "rejected", reason: "stale-seq" };
    }

    const block = payload[sensor];

    if (!block || typeof block !== "object") {
      return { status: "rejected", reason: "malformed-payload" };
    }

    record.sample = { seq, at, [sensor]: SANITIZERS[sensor](block) };

    return { status: "accepted" };
  }

  // ------------------------------------------------------------
  // Snapshot
  // ------------------------------------------------------------

  freshness(record, device, now) {
    if (!device.connected) {
      return FRESHNESS.disconnected;
    }
    if (device.paused) {
      return FRESHNESS.paused;
    }
    if (record.capture !== "on") {
      return FRESHNESS.off;
    }
    if (record.sample === null) {
      return FRESHNESS.waiting;
    }
    return now - record.sample.at <= this.staleAfterMs
      ? FRESHNESS.live
      : FRESHNESS.stale;
  }

  // The monitor's whole world: one entry per device ever seen, keyed by
  // the stable id (reconnects keep the id, so data never crosses
  // devices), each carrying both sensors' capture/permission/value/
  // freshness facts. Derived at read time — staleness is a function of
  // "now", not a stored flag.
  snapshot(now) {
    const devices = {};

    for (const device of this.devices.values()) {
      devices[device.id] = {
        id: device.id,
        connected: device.connected,
        paused: device.paused,
        since: device.connected ? device.joinedAt : device.disconnectedAt,
        heartbeatAgeMs: now - device.lastHeartbeatAt,
        sensors: Object.fromEntries(
          SENSORS.map((sensor) => [
            sensor,
            sensorSnapshot(device.sensors[sensor], device, now, this),
          ]),
        ),
      };
    }

    return { at: now, staleAfterMs: this.staleAfterMs, devices };
  }
}

function blankSensor(sensor, at) {
  return {
    sensor,
    capture: "off", // "off" | "on"
    epoch: 0,
    permission: "unknown",
    startedAt: null,
    stoppedAt: null,
    permissionAt: null,
    sample: null, // { seq, at, tilt?|motion? } — latest only
    createdAt: at,
  };
}

function sensorSnapshot(record, device, now, hub) {
  return {
    sensor: record.sensor,
    capture: record.capture,
    permission: record.permission,
    freshness: hub.freshness(record, device, now),
    sample: record.sample,
  };
}

module.exports = {
  SensorHub,
  SENSORS,
  FRESHNESS,
  PERMISSION_STATES,
  DEFAULT_STALE_AFTER_MS,
};
