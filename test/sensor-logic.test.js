// The browser-side sensor logic (public/sensor-logic.js) driven through
// API stand-ins: fake permission requesters, fake event sources and a
// fake clock. These tests prove the exact rules the phone enforces —
// zero vs missing, shake counting, the independent capture/send rate
// limits, latest-only sends, late-event and late-permission guards,
// pause.

const assert = require("node:assert/strict");
const test = require("node:test");

const S = require("../public/sensor-logic");

// ------------------------------------------------------------
// Value rules
// ------------------------------------------------------------

test("readNumber: finite numbers pass (zero included), everything else is missing", () => {
  assert.equal(S.readNumber(0), 0);
  assert.equal(S.readNumber(-3.5), -3.5);
  assert.equal(S.readNumber(null), null);
  assert.equal(S.readNumber(undefined), null);
  assert.equal(S.readNumber(NaN), null);
  assert.equal(S.readNumber(Infinity), null);
  assert.equal(S.readNumber("0"), null);
});

test("tilt sanitization keeps nulls and zeros exactly as provided", () => {
  assert.deepEqual(S.sanitizeTilt({ alpha: 0, beta: null, gamma: 359.9 }), {
    alpha: 0,
    beta: null,
    gamma: 359.9,
  });
});

// ------------------------------------------------------------
// MotionProcessor
// ------------------------------------------------------------

test("gravity-including acceleration splits into user motion and counts shakes with a cooldown", () => {
  const processor = new S.MotionProcessor();
  let at = 0;
  const feed = (x, y, z) => {
    at += 16; // ~60 Hz device cadence
    return processor.feed({ x, y, z, includesGravity: true, interval: 16, at });
  };

  // Rest: gravity only (screen flat on a table).
  for (let i = 0; i < 40; i += 1) {
    feed(0, 0, 9.81);
  }
  const rest = processor.intensity;
  assert.ok(rest < 1, `resting intensity should be tiny, got ${rest}`);
  assert.equal(processor.shakeCount, 0);

  // One sharp shake: a physical oscillation (down-up swing), then quiet.
  feed(0, 0, 9.81 + 25);
  feed(0, 0, 9.81 - 20);
  feed(0, 0, 9.81 + 18);
  for (let i = 0; i < 20; i += 1) {
    feed(0, 0, 9.81);
  }
  assert.equal(processor.shakeCount, 1);

  // The shake's own tail inside the cooldown (a late echo frame) must
  // not count as a second shake.
  feed(0, 0, 9.81 + 17);
  assert.equal(processor.shakeCount, 1);

  // A quiet gap is rest, not gravity evidence: the next spike after it
  // must still read as motion (not get swallowed into the gravity
  // estimate) and, past the cooldown, count as a new shake.
  for (let i = 0; i < 45; i += 1) {
    feed(0, 0, 9.81);
  }
  assert.equal(processor.shakeCount, 1);
  feed(0, 0, 9.81 + 25);
  assert.equal(processor.shakeCount, 2);
});

test("user-acceleration (gravity already removed) counts shakes directly", () => {
  const processor = new S.MotionProcessor();
  let at = 0;
  const feed = (x, y, z) => {
    at += 16;
    return processor.feed({ x, y, z, includesGravity: false, interval: 16, at });
  };

  feed(0, 0, 0);
  feed(0, 16, 0);
  assert.equal(processor.shakeCount, 1);
  assert.ok(processor.intensity > 10);
});

test("a motion event with no acceleration fields is not a sample", () => {
  const processor = new S.MotionProcessor();
  assert.equal(
    processor.feed({ x: null, y: null, z: null, includesGravity: false, interval: 16, at: 0 }),
    null,
  );
});

test("partially missing fields stay per-field missing; intensity cannot be invented", () => {
  const processor = new S.MotionProcessor();
  const sample = processor.feed({
    x: 0.4,
    y: null,
    z: null,
    includesGravity: true,
    interval: 16,
    at: 0,
  });

  assert.equal(sample.x, 0.4);
  assert.equal(sample.y, null);
  assert.equal(sample.z, null);
  assert.equal(sample.intensity, null); // magnitude needs all three
  assert.equal(sample.shakeCount, 0);
});

test("event readers prefer user acceleration, else the gravity block, else nothing", () => {
  assert.deepEqual(
    S.readMotionEvent({
      acceleration: { x: 0.1, y: null, z: null },
      accelerationIncludingGravity: { x: 0.1, y: 0.2, z: 9.8 },
      interval: 16,
    }),
    { x: 0.1, y: null, z: null, includesGravity: false, interval: 16 },
  );
  assert.deepEqual(
    S.readMotionEvent({
      acceleration: { x: null, y: null, z: null },
      accelerationIncludingGravity: { x: 0.1, y: 0.2, z: 9.8 },
      interval: 16,
    }),
    { x: 0.1, y: 0.2, z: 9.8, includesGravity: true, interval: 16 },
  );
  assert.equal(
    S.readMotionEvent({
      acceleration: { x: null, y: null, z: null },
      accelerationIncludingGravity: null,
      interval: 16,
    }),
    null,
  );
  // The Safari shape: a first all-null orientation-style tilt event.
  assert.equal(S.readTiltEvent({ alpha: null, beta: null, gamma: null }), null);
  assert.deepEqual(S.readTiltEvent({ alpha: 1, beta: 2, gamma: 3 }), {
    alpha: 1,
    beta: 2,
    gamma: 3,
  });
});

// ------------------------------------------------------------
// SensorController with API stand-ins
// ------------------------------------------------------------

function makePlatform(options = {}) {
  const listeners = new Map(); // type -> Set<fn>
  const platform = {
    now: options.now || (() => 0),
    clock: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type, event) {
      for (const fn of listeners.get(type) || []) {
        fn(event);
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
    orientationEvent: options.orientationEvent,
    motionEvent: options.motionEvent,
  };

  return platform;
}

function deferredPermission() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("unsupported platforms report the fact and never attach", () => {
  const platform = makePlatform(); // no event globals at all
  const events = [];
  const controller = new S.SensorController(platform, {
    onPermission: (sensor, permission) => events.push(["permission", sensor, permission]),
  });

  controller.start("tilt");

  assert.equal(controller.stateOf("tilt"), "unsupported");
  assert.deepEqual(events, [["permission", "tilt", "unsupported"]]);
  assert.equal(platform.listenerCount("deviceorientation"), 0);
});

test("platforms without a permission gate attach immediately", () => {
  const platform = makePlatform({
    orientationEvent: function DeviceOrientationEvent() {},
  });
  const events = [];
  const controller = new S.SensorController(platform, {
    onStart: (sensor, permission) => events.push(["start", sensor, permission]),
  });

  controller.start("tilt");

  assert.equal(controller.stateOf("tilt"), "on");
  assert.equal(platform.listenerCount("deviceorientation"), 1);
  assert.deepEqual(events, [["start", "tilt", "granted"]]);
});

test("the iOS permission flow: starting → granted → on; denied stays denied", async () => {
  const gate = deferredPermission();
  const platform = makePlatform({
    orientationEvent: { requestPermission: () => gate.promise },
  });
  const controller = new S.SensorController(platform, {});
  const permissionEvents = [];
  controller.callbacks.onPermission = (s, p) => permissionEvents.push(p);

  controller.start("tilt");
  assert.equal(controller.stateOf("tilt"), "starting");
  assert.equal(platform.listenerCount("deviceorientation"), 0);

  gate.resolve("granted");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.stateOf("tilt"), "on");
  assert.equal(platform.listenerCount("deviceorientation"), 1);
  assert.deepEqual(permissionEvents, []);

  // Denied path.
  const deniedGate = deferredPermission();
  const motionPlatform = makePlatform({
    motionEvent: { requestPermission: () => deniedGate.promise },
  });
  const motionController = new S.SensorController(motionPlatform, {});
  const seen = [];
  motionController.callbacks.onPermission = (s, p) => seen.push(p);
  motionController.callbacks.onState = (s, st) => seen.push(st);

  motionController.start("motion");
  deniedGate.resolve("denied");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(motionController.stateOf("motion"), "denied");
  assert.equal(motionPlatform.listenerCount("devicemotion"), 0);
  assert.deepEqual(seen, ["starting", "denied", "denied"]);
});

test("a LATE granted result never restarts a capture the user stopped", async () => {
  const gate = deferredPermission();
  const platform = makePlatform({
    orientationEvent: { requestPermission: () => gate.promise },
  });
  const permissionEvents = [];
  const controller = new S.SensorController(platform, {
    onPermission: (sensor, permission) => permissionEvents.push(permission),
    onStart: () => permissionEvents.push("STARTED"),
  });

  controller.start("tilt");
  assert.equal(controller.stateOf("tilt"), "starting");

  // The user gives up and stops while the dialog is still open.
  controller.stop("tilt");
  assert.equal(controller.stateOf("tilt"), "off");

  gate.resolve("granted");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.stateOf("tilt"), "off"); // still off
  assert.equal(platform.listenerCount("deviceorientation"), 0); // never attached
  assert.deepEqual(permissionEvents, ["granted"]); // the fact, not a restart
});

test("events from a stopped capture are dropped (the late-result guard)", () => {
  const platform = makePlatform({
    orientationEvent: function DeviceOrientationEvent() {},
    now: () => 0,
  });
  const sends = [];
  const controller = new S.SensorController(platform, {
    onSend: (sensor, sample, seq) => sends.push([sensor, sample, seq]),
  });

  controller.start("tilt");
  platform.fire("deviceorientation", { alpha: 1, beta: 2, gamma: 3 });
  controller.stop("tilt");

  // A queued event lands after the stop.
  platform.fire("deviceorientation", { alpha: 9, beta: 9, gamma: 9 });

  assert.equal(sends.length, 1); // only the pre-stop sample went out
  assert.equal(sends[0][1].alpha, 1);
});

test("a paused controller processes and sends nothing", () => {
  const platform = makePlatform({
    orientationEvent: function DeviceOrientationEvent() {},
    now: () => 0,
  });
  const sends = [];
  const controller = new S.SensorController(platform, {
    onSend: (...args) => sends.push(args),
  });

  controller.start("tilt");
  controller.pause();
  platform.fire("deviceorientation", { alpha: 1, beta: 2, gamma: 3 });
  assert.equal(sends.length, 0);

  // Resume: the sensor the user left ON flows again.
  controller.resume();
  platform.fire("deviceorientation", { alpha: 4, beta: 5, gamma: 6 });
  assert.equal(sends.length, 1);
});

test("capture and send limit independently; only the latest sample is sent", () => {
  let clock = 0;
  const platform = makePlatform({
    orientationEvent: function DeviceOrientationEvent() {},
    now: () => clock,
  });
  const sends = [];
  const controller = new S.SensorController(platform, {
    onSend: (sensor, sample, seq) => sends.push([sample.alpha, seq]),
  });

  controller.start("tilt");

  // 120 device events 16 ms apart (~2 s of 60 Hz device cadence).
  for (let i = 1; i <= 120; i += 1) {
    clock = i * 16;
    platform.fire("deviceorientation", { alpha: i, beta: 0, gamma: 0 });
  }

  // Capture gate (~60 Hz): every event becomes a processed sample. Send
  // gate (~30 Hz): the watermark passes every 48 ms here — 40 sends.
  assert.equal(sends.length, 40, `send ${sends.length}`);

  // Every send carries the LATEST processed sample at its moment —
  // here the last send must carry a high alpha, never an old one, and
  // nothing between sends is queued or replayed afterwards.
  const last = sends[sends.length - 1];
  assert.ok(last[0] > 100, `latest sample should be recent, got ${last[0]}`);
  assert.equal(sends.length, new Set(sends.map(([, seq]) => seq)).size); // seqs strictly fresh
});

test("a reconnect cannot replay history: stopping drops everything in flight", () => {
  const platform = makePlatform({
    orientationEvent: function DeviceOrientationEvent() {},
    now: () => 0,
  });
  const sends = [];
  const controller = new S.SensorController(platform, {
    onSend: (...args) => sends.push(args),
  });

  controller.start("tilt");
  platform.fire("deviceorientation", { alpha: 1, beta: 1, gamma: 1 });
  controller.stop("tilt");

  // Whatever was pending between sends is simply gone — a restart
  // begins from seq 1 again.
  controller.start("tilt");
  platform.fire("deviceorientation", { alpha: 2, beta: 2, gamma: 2 });

  assert.equal(sends.length, 2);
  assert.equal(sends[1][2], 1); // the new capture counts from scratch
});

test("motion events flow through the processor and carry shake facts to the wire", () => {
  let clock = 0;
  const platform = makePlatform({
    motionEvent: function DeviceMotionEvent() {},
    now: () => clock,
  });
  const sends = [];
  const controller = new S.SensorController(platform, {
    onSend: (sensor, sample) => sends.push(sample),
  });

  controller.start("motion");

  clock = 16;
  platform.fire("devicemotion", {
    acceleration: null,
    accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
    interval: 16,
  });
  // Advance past the send window, then the spike: the next SEND (the
  // one that can carry it) must include the counted shake.
  clock = 250;
  platform.fire("devicemotion", {
    acceleration: null,
    accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 + 25 },
    interval: 16,
  });

  assert.equal(sends.length >= 2, true);
  const last = sends[sends.length - 1];
  assert.equal(last.includesGravity, true);
  assert.equal(last.shakeCount, 1);
});
