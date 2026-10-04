// SensorHub (lib/sensors.js): the server-side rules the spec pins —
// late results after stop are rejected without touching state, seq is
// monotonic, heartbeats never fake freshness, and devices are isolated.

const assert = require("node:assert/strict");
const test = require("node:test");

const { SensorHub, FRESHNESS, DEFAULT_STALE_AFTER_MS } = require("../lib/sensors");
const shared = require("../public/shared");

// The freshness vocabulary is a deliberate mirror: lib/sensors.js owns
// it server-side, shared.js carries it to the pages. This pins the two
// so a rename on one side can never silently drift the other.
test("the freshness vocabulary mirrors exactly between server and pages", () => {
  assert.deepEqual(FRESHNESS, shared.freshness);
  assert.ok(DEFAULT_STALE_AFTER_MS > 0);
});

function hub(options = {}) {
  return new SensorHub({ staleAfterMs: 2000, ...options });
}

function joinedHub() {
  const h = hub();
  h.join(1, 1000);
  h.join(2, 1000);
  return h;
}

test("a capturing sensor accepts the latest sample and stores it alone", () => {
  const h = joinedHub();
  h.start(1, "tilt", { at: 1100, permission: "granted" });

  assert.equal(
    h.sample(1, "tilt", { seq: 1, tilt: { alpha: 10, beta: 0, gamma: -5 } }, { at: 1200 })
      .status,
    "accepted",
  );
  assert.equal(
    h.sample(1, "tilt", { seq: 2, tilt: { alpha: 11, beta: 1, gamma: -4 } }, { at: 1300 })
      .status,
    "accepted",
  );

  const device = h.snapshot(1400).devices[1];
  // Newest only — no history to accumulate anywhere.
  assert.equal(device.sensors.tilt.sample.seq, 2);
  assert.equal(device.sensors.tilt.sample.tilt.alpha, 11);
});

test("a late sample after stop is rejected and the record keeps the frozen last sample", () => {
  const h = joinedHub();
  h.start(1, "motion", { at: 1100, permission: "granted" });
  h.sample(
    1,
    "motion",
    { seq: 7, motion: { x: 0.1, y: 0, z: 9.8, includesGravity: true, intensity: 0, shakeCount: 0 } },
    { at: 1200 },
  );
  h.stop(1, "motion", { at: 1300 });

  const result = h.sample(
    1,
    "motion",
    { seq: 8, motion: { x: 5, y: 5, z: 5, includesGravity: false, intensity: 9, shakeCount: 1 } },
    { at: 1400 },
  );

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "not-capturing");

  const device = h.snapshot(1500).devices[1];
  assert.equal(device.sensors.motion.sample.seq, 7);
  assert.equal(device.sensors.motion.sample.motion.x, 0.1);
  assert.equal(device.sensors.motion.freshness, FRESHNESS.off);
});

test("replayed or reordered seq is rejected; the seq shown is the seq sent", () => {
  const h = joinedHub();
  h.start(1, "tilt", { at: 1100 });
  h.sample(1, "tilt", { seq: 4, tilt: { alpha: 1, beta: 2, gamma: 3 } }, { at: 1200 });

  assert.equal(
    h.sample(1, "tilt", { seq: 4, tilt: { alpha: 9, beta: 9, gamma: 9 } }, { at: 1300 }).reason,
    "stale-seq",
  );
  assert.equal(
    h.sample(1, "tilt", { seq: 3, tilt: { alpha: 9, beta: 9, gamma: 9 } }, { at: 1400 }).reason,
    "stale-seq",
  );

  assert.equal(h.snapshot(1500).devices[1].sensors.tilt.sample.tilt.alpha, 1);
});

test("a restarted capture resets its sample; old-capture seq numbers do not block it", () => {
  const h = joinedHub();
  h.start(1, "tilt", { at: 1100 });
  h.sample(1, "tilt", { seq: 50, tilt: { alpha: 1, beta: 1, gamma: 1 } }, { at: 1200 });
  h.stop(1, "tilt", { at: 1300 });
  h.start(1, "tilt", { at: 1400 });

  // A fresh capture counts from scratch — seq 1 is legal again.
  assert.equal(
    h.sample(1, "tilt", { seq: 1, tilt: { alpha: 2, beta: 2, gamma: 2 } }, { at: 1500 }).status,
    "accepted",
  );
});

test("heartbeats never fake freshness — only samples do", () => {
  const h = hub({ staleAfterMs: 500 });
  h.join(1, 1000);
  h.start(1, "tilt", { at: 1100 });
  h.sample(1, "tilt", { seq: 1, tilt: { alpha: 1, beta: 1, gamma: 1 } }, { at: 1200 });

  // Heartbeats keep landing long past the freshness window.
  h.heartbeat(1, 1300);
  h.heartbeat(1, 1600);
  h.heartbeat(1, 1900);

  const device = h.snapshot(2000).devices[1];
  assert.equal(device.sensors.tilt.freshness, FRESHNESS.stale);
  assert.equal(device.sensors.tilt.sample.seq, 1); // the stale value stays readable
});

test("the freshness vocabulary derives from state and time", () => {
  const h = hub({ staleAfterMs: 500 });
  h.join(1, 1000);

  // Joined, never started, never sampled.
  assert.equal(h.snapshot(1100).devices[1].sensors.tilt.freshness, FRESHNESS.off);

  // Capturing, authorized, but no sample yet — its own state.
  h.start(1, "tilt", { at: 1100 });
  assert.equal(h.snapshot(1150).devices[1].sensors.tilt.freshness, FRESHNESS.waiting);

  // Sample inside the window: live.
  h.sample(1, "tilt", { seq: 1, tilt: { alpha: 0, beta: 0, gamma: 0 } }, { at: 1200 });
  assert.equal(h.snapshot(1400).devices[1].sensors.tilt.freshness, FRESHNESS.live);

  // Past the window without newer samples: stopped updating.
  assert.equal(h.snapshot(1800).devices[1].sensors.tilt.freshness, FRESHNESS.stale);

  // Backgrounded page: paused, even with a fresh sample.
  h.sample(1, "tilt", { seq: 2, tilt: { alpha: 1, beta: 1, gamma: 1 } }, { at: 1850 });
  h.pause(1, 1860);
  assert.equal(h.snapshot(1900).devices[1].sensors.tilt.freshness, FRESHNESS.paused);

  // Socket gone: disconnected.
  h.disconnect(1, 2000);
  assert.equal(h.snapshot(2100).devices[1].sensors.tilt.freshness, FRESHNESS.disconnected);
});

test("devices are isolated: nothing from device 1 lands on device 2", () => {
  const h = joinedHub();
  h.start(1, "tilt", { at: 1100 });
  h.start(2, "tilt", { at: 1100 });

  h.sample(1, "tilt", { seq: 1, tilt: { alpha: 11, beta: 11, gamma: 11 } }, { at: 1200 });

  const snapshot = h.snapshot(1300);
  assert.equal(snapshot.devices[1].sensors.tilt.sample.tilt.alpha, 11);
  assert.equal(snapshot.devices[2].sensors.tilt.sample, null);
  assert.equal(snapshot.devices[2].sensors.tilt.freshness, FRESHNESS.waiting);

  // Unknown device / sensor / malformed shapes are refused everywhere.
  assert.equal(h.sample(9, "tilt", { seq: 1, tilt: {} }, { at: 1300 }).reason, "unknown-device");
  assert.equal(h.sample(1, "proximity", { seq: 1 }, { at: 1300 }).reason, "unknown-sensor");
  assert.equal(h.sample(1, "tilt", null, { at: 1300 }).reason, "malformed-payload");
  assert.equal(h.sample(1, "tilt", { seq: "x", tilt: {} }, { at: 1300 }).reason, "malformed-seq");
  assert.equal(h.sample(1, "tilt", { seq: 2 }, { at: 1300 }).reason, "malformed-payload");
});

test("zero is a real reading; missing stays null — never folded", () => {
  const h = joinedHub();
  h.join(1, 1000);
  h.start(1, "tilt", { at: 1100 });
  h.start(1, "motion", { at: 1100 });

  h.sample(1, "tilt", { seq: 1, tilt: { alpha: 0, beta: 0, gamma: 0 } }, { at: 1200 });
  h.sample(
    1,
    "motion",
    { seq: 1, motion: { x: null, y: 0, z: 9.81, includesGravity: true, intensity: null, shakeCount: null } },
    { at: 1200 },
  );

  const sensors = h.snapshot(1300).devices[1].sensors;
  assert.deepEqual(sensors.tilt.sample.tilt, { alpha: 0, beta: 0, gamma: 0 });
  assert.equal(sensors.motion.sample.motion.x, null);
  assert.equal(sensors.motion.sample.motion.y, 0);
  assert.equal(sensors.motion.sample.motion.includesGravity, true);
});

test("mic samples: silence survives as REAL zeros, missing stays null, late results are refused", () => {
  const h = joinedHub();
  h.join(1, 1000);
  h.start(1, "mic", { at: 1100, permission: "granted" });

  // A silent room: rms/peak are real zeros, the level sits at its
  // documented floor, the capture's rate rides along.
  assert.equal(
    h.sample(
      1,
      "mic",
      { seq: 1, mic: { rms: 0, peak: 0, level: -90, sampleRate: 48000 } },
      { at: 1200 },
    ).status,
    "accepted",
  );

  const device = h.snapshot(1250).devices[1];
  assert.deepEqual(device.sensors.mic.sample.mic, {
    rms: 0,
    peak: 0,
    level: -90,
    sampleRate: 48000,
  });
  assert.equal(device.sensors.mic.freshness, FRESHNESS.live);

  // Partially provided blocks keep per-field facts — never folded.
  h.sample(
    1,
    "mic",
    { seq: 2, mic: { rms: 0.05, peak: null, level: -26, sampleRate: null } },
    { at: 1300 },
  );
  assert.deepEqual(h.snapshot(1350).devices[1].sensors.mic.sample.mic, {
    rms: 0.05,
    peak: null,
    level: -26,
    sampleRate: null,
  });

  // Malformed shapes are refused; a stop freezes the record; a late
  // sample from the stopped capture never lands.
  assert.equal(h.sample(1, "mic", { seq: 3 }, { at: 1400 }).reason, "malformed-payload");
  h.stop(1, "mic", { at: 1450 });
  assert.equal(
    h.sample(
      1,
      "mic",
      { seq: 4, mic: { rms: 1, peak: 1, level: 0, sampleRate: 48000 } },
      { at: 1500 },
    ).reason,
    "not-capturing",
  );
  assert.equal(h.snapshot(1550).devices[1].sensors.mic.sample.mic.rms, 0.05);
  assert.equal(h.snapshot(1550).devices[1].sensors.mic.freshness, FRESHNESS.off);
});

test("handpose samples: no-hand is a result, keypoints capped, late results refused", () => {
  const h = joinedHub();
  h.join(1, 1000);
  h.start(1, "handpose", { at: 1100, permission: "granted" });

  // A no-hand inference is a COMPLETED result: zero hands, an EMPTY
  // keypoint list, meters riding along — never "missing".
  assert.equal(
    h.sample(
      1,
      "handpose",
      {
        seq: 1,
        handpose: { hands: 0, confidence: null, keypoints: [], inferMs: 18.2, rateHz: 9.5 },
      },
      { at: 1200 },
    ).status,
    "accepted",
  );

  let device = h.snapshot(1250).devices[1];
  assert.equal(device.sensors.handpose.freshness, FRESHNESS.live);
  assert.equal(device.sensors.handpose.sample.handpose.hands, 0);
  assert.deepEqual(device.sensors.handpose.sample.handpose.keypoints, []);

  // A detected hand: keypoints capped at the 21 canonical landmarks,
  // per-field facts preserved (a null coordinate stays null).
  const keypoints = [];

  for (let i = 0; i < 30; i += 1) {
    keypoints.push({ x: i / 30, y: null });
  }

  h.sample(
    1,
    "handpose",
    { seq: 2, handpose: { hands: 1, confidence: 0.9, keypoints, inferMs: 25, rateHz: 10 } },
    { at: 1300 },
  );
  const stored = h.snapshot(1350).devices[1].sensors.handpose.sample.handpose;
  assert.equal(stored.hands, 1);
  assert.equal(stored.keypoints.length, 21); // capped
  assert.equal(stored.keypoints[0].x, 0);
  assert.equal(stored.keypoints[1].y, null); // missing, never zero

  // A missing keypoint array travels as null (missing ≠ empty).
  h.sample(
    1,
    "handpose",
    { seq: 3, handpose: { hands: 1, confidence: 0.9, inferMs: 25, rateHz: 10 } },
    { at: 1400 },
  );
  assert.equal(h.snapshot(1450).devices[1].sensors.handpose.sample.handpose.keypoints, null);

  // Malformed shapes are refused; stop freezes; late samples rejected.
  assert.equal(
    h.sample(1, "handpose", { seq: 4 }, { at: 1450 }).reason,
    "malformed-payload",
  );
  h.stop(1, "handpose", { at: 1500 });
  assert.equal(
    h.sample(
      1,
      "handpose",
      { seq: 5, handpose: { hands: 1, confidence: 1, keypoints: [], inferMs: 1, rateHz: 1 } },
      { at: 1600 },
    ).reason,
    "not-capturing",
  );
  device = h.snapshot(1650).devices[1];
  assert.equal(device.sensors.handpose.sample.handpose.hands, 1); // frozen
  assert.equal(device.sensors.handpose.freshness, FRESHNESS.off);
});

test("every device carries all four sensor records from join on", () => {
  const h = joinedHub();
  const sensors = h.snapshot(1100).devices[1].sensors;

  assert.deepEqual(Object.keys(sensors), ["tilt", "motion", "mic", "handpose"]);
  assert.equal(sensors.mic.permission, "unknown");
  assert.equal(sensors.mic.freshness, FRESHNESS.off);
});

test("permission facts ride along without restarting capture", () => {
  const h = joinedHub();
  h.join(1, 1000);

  // A denied request reports the fact; capture stays off.
  assert.equal(h.setPermission(1, "tilt", "denied", { at: 1100 }), true);
  assert.equal(h.snapshot(1200).devices[1].sensors.tilt.permission, "denied");
  assert.equal(h.snapshot(1200).devices[1].sensors.tilt.capture, "off");

  // A LATE "granted" after the user gave up: recorded, capture still off.
  h.setPermission(1, "tilt", "granted", { at: 1300 });
  assert.equal(h.snapshot(1400).devices[1].sensors.tilt.permission, "granted");
  assert.equal(h.snapshot(1400).devices[1].sensors.tilt.capture, "off");
});

test("a reconnect keeps the device's record and samples", () => {
  const h = joinedHub();
  h.start(1, "tilt", { at: 1100 });
  h.sample(1, "tilt", { seq: 3, tilt: { alpha: 5, beta: 5, gamma: 5 } }, { at: 1200 });
  h.disconnect(1, 1300);

  h.reconnect(1, 2000);

  const device = h.snapshot(2100).devices[1];
  assert.equal(device.connected, true);
  assert.equal(device.sensors.tilt.sample.seq, 3);
  // The sample is 900 ms old against a 2 s window — still live. The
  // gap itself is the disconnect's business, not the sample's.
  assert.equal(device.sensors.tilt.freshness, FRESHNESS.live);
});
