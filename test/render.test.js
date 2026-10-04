// The shared rendering helpers' pure logic: the frame-rate smoothing
// (exponential approach, α wrap-around, null pass-through), the mic
// rows' unit formatting, and the monitor roster's disconnected-device
// hide window.

const assert = require("node:assert/strict");
const test = require("node:test");

const R = require("../public/render");

// ------------------------------------------------------------
// Smoothing (the control-rate display leg)
// ------------------------------------------------------------

test("approach glides toward the target and converges: one step never jumps", () => {
  const oneStep = R.approach(0, 180, 16, 100);
  assert.ok(oneStep > 0 && oneStep < 180, `one step ${oneStep}`);

  // τ = 100 ms: after one τ of frames the value is within (1 - e^-1)
  // of the target, and it never overshoots.
  let current = 0;
  for (let frame = 0; frame < 60; frame += 1) {
    current = R.approach(current, 180, 16, 100);
    assert.ok(current <= 180);
  }
  assert.ok(Math.abs(current - 180) < 0.5, `converged to ${current}`);
});

test("approach is dt-based: frame jitter changes the pace, not the shape", () => {
  // Ten 16 ms frames travel the same distance as one 160 ms frame.
  let stepped = 0;
  for (let i = 0; i < 10; i += 1) {
    stepped = R.approach(stepped, 100, 16, 100);
  }
  const single = R.approach(0, 100, 160, 100);
  assert.ok(Math.abs(stepped - single) < 0.5, `${stepped} vs ${single}`);
});

test("approachAngle takes the shortest path across the 0°/360° wrap", () => {
  // 359° → 1° must go through 0, not back through 180.
  const step = R.approachAngle(359, 1, 16, 100);
  assert.ok(step > 359 || step < 1.5, `wrapped step ${step}`);

  // The long way around (179° apart) is the straight line.
  const plain = R.approachAngle(10, 189, 16, 100);
  assert.ok(plain > 10 && plain < 189, `plain step ${plain}`);

  // The result stays in [0, 360).
  let current = 350;
  for (let i = 0; i < 100; i += 1) {
    current = R.approachAngle(current, 10, 16, 100);
    assert.ok(current >= 0 && current < 360, `in range: ${current}`);
  }
  assert.ok(Math.abs(current - 10) < 0.5, `converged to ${current}`);
});

test("approachField: a null on either side passes through unsmoothed", () => {
  // The zero-vs-null rule: null is a FACT, never blended into a number.
  assert.equal(R.approachField(null, 5, 16, 100, false), 5);
  assert.equal(R.approachField(5, null, 16, 100, false), null);
  assert.equal(R.approachField(null, null, 16, 100, false), null);
  assert.ok(R.approachField(1, 2, 16, 100, false) > 1);
});

// ------------------------------------------------------------
// Mic rows (units and the honest-floor vocabulary)
// ------------------------------------------------------------

test("micRows: 4-decimal FS, dBFS level, integer Hz — and the uncalibrated note on every render", () => {
  const T = {
    rms: "RMS",
    peak: "Peak",
    level: "Level",
    sampleRate: "Sample rate",
    unavailable: "unavailable",
    micMeterNote: "Uncalibrated: FS = fraction of digital full scale; level is dBFS, floor −90",
  };

  const html = R.micRows({ rms: 0.25, peak: 0.5, level: -9.03, sampleRate: 48000 }, T);
  assert.match(html, /0\.2500 FS/);
  assert.match(html, /0\.5000 FS/);
  assert.match(html, /-9\.0 dBFS/);
  assert.match(html, /48000 Hz/);
  assert.match(html, /Uncalibrated/);

  // A silent room: REAL zeros with their units, the level at its floor,
  // and a missing rate as a word — never "0 Hz".
  const silent = R.micRows({ rms: 0, peak: 0, level: -90, sampleRate: null }, T);
  assert.match(silent, /0\.0000 FS/);
  assert.match(silent, /-90\.0 dBFS/);
  assert.match(silent, /unavailable/);
  assert.doesNotMatch(silent, /null Hz/);
});

// ------------------------------------------------------------
// Roster visibility (the ghost-device hide window)
// ------------------------------------------------------------

function device(overrides = {}) {
  return {
    id: 1,
    connected: true,
    paused: false,
    since: 1000,
    sensors: {},
    ...overrides,
  };
}

test("connected devices are always visible, in id order", () => {
  const ids = R.visibleDeviceIds(
    {
      3: device({ id: 3, since: 0 }),
      1: device({ id: 1, since: 0 }),
      2: device({ id: 2, since: 0 }),
    },
    1000000,
  );

  assert.deepEqual(ids, [1, 2, 3]);
});

test("a disconnected device stays visible inside the grace window, then leaves", () => {
  const now = 20000;
  const devices = {
    // Dropped 2 s ago: a blip — the card stays (no flicker).
    1: device({ id: 1, connected: false, since: now - 2000 }),
    // Dropped 30 s ago: a ghost (a stray tab, a link preview) — gone.
    2: device({ id: 2, connected: false, since: now - 30000 }),
    // Still connected.
    3: device({ id: 3, connected: true, since: 0 }),
  };

  assert.deepEqual(R.visibleDeviceIds(devices, now), [1, 3]);

  // Exactly at the window boundary the card is gone.
  const boundary = {
    9: device({ id: 9, connected: false, since: now - R.DISCONNECTED_HIDE_AFTER_MS }),
  };
  assert.deepEqual(R.visibleDeviceIds(boundary, now), []);
});
