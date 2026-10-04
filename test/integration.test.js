// Integration: the REAL server, real Socket.IO clients and the real
// HTTP surface — the parent spec's automated boundary (#137: a real
// fixture server + real clients asserting public behavior only).
//
// Covers: health / stopping contract, the §15 config injection (role,
// projectId, performerUrl from PNDS_PERFORMER_URL — the standalone
// HTTPS trial spelling), the QR endpoint, join/token recovery (the
// stable device identity), dual-end sample agreement (seq + values),
// zero-vs-null on the wire, late results after stop, device isolation,
// pause, and heartbeat-never-fakes-freshness under a shrunken stale
// window.

const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");

const { io } = require("socket.io-client");

const PROJECT_ROOT = path.join(__dirname, "..");
const ENTRY_URL = "https://show.example.org:8443/";

// Scratch ports via the PNDS_*_PORT overrides: `npm test` must work
// beside a LIVE instance the App spawned on the manifest ports
// (6868/6869) — it binds them for real.
let PERFORMER_URL = null;
let MONITOR_URL = null;
let HEALTH_URL = null;
const performerPort = () => Number(new URL(PERFORMER_URL).port);
const monitorPort = () => Number(new URL(MONITOR_URL).port);

const { events: EVENTS } = require("../public/shared");

// The shrunken freshness window: samples stay "live" for 400 ms, so
// the staleness assertions run in wall-clock seconds.
const STALE_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child;

// A port the OS is not holding right now: bind-to-0, read, release.
// (A fixed high port would still be a guess; this is not.)
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function startServer() {
  const [performer, monitor] = await Promise.all([freePort(), freePort()]);
  PERFORMER_URL = `http://127.0.0.1:${performer}`;
  MONITOR_URL = `http://127.0.0.1:${monitor}`;
  HEALTH_URL = `${PERFORMER_URL}/__pnds/health`;

  child = spawn(process.execPath, [path.join(PROJECT_ROOT, "server.js")], {
    env: {
      ...process.env,
      PNDS_HOST_IP: "127.0.0.1",
      PNDS_PERFORMER_URL: ENTRY_URL,
      PNDS_PERFORMER_PORT: String(performer),
      PNDS_MONITOR_PORT: String(monitor),
      SENSOR_STALE_AFTER_MS: String(STALE_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    console.error("[server stderr]", String(chunk));
  });
}

async function waitForHealthReady() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(HEALTH_URL);
      const payload = await response.json();

      if (payload.status === "ready") {
        return payload;
      }
    } catch {
      // not up yet
    }

    await sleep(250);
  }

  throw new Error("server never reported health ready");
}

function stopServer() {
  if (!child) {
    return Promise.resolve(null);
  }

  const exiting = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  child.kill("SIGTERM");
  return Promise.race([exiting, sleep(5000).then(() => null)]);
}

function connect(url = PERFORMER_URL) {
  return io(url, { reconnection: false, timeout: 5000 });
}

function join(socket, token = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("join timeout"));
    }, 5000);

    socket.on("connect", () => {
      socket.emit(EVENTS.join, { token });
    });

    socket.on(EVENTS.joined, (data) => {
      clearTimeout(timer);
      resolve(data);
    });

    socket.on(EVENTS.rejected, (data) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`rejected: ${data && data.reason}`));
    });
  });
}

// Resolves with the first state broadcast matching the predicate. The
// observer is a PASSIVE listener: state broadcasts reach every connected
// socket, and an observer that joined would allocate (and, after a
// disconnect, potentially steal) a device id — polluting exactly the
// identity facts under test.
function nextState(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const observer = connect();
    const timer = setTimeout(() => {
      observer.close();
      reject(new Error("state predicate never matched"));
    }, timeoutMs);

    observer.on("connect", () => {
      // Deliberately NO join: listen only.
    });

    observer.on(EVENTS.state, (state) => {
      let matched = false;

      try {
        matched = predicate(state);
      } catch (error) {
        clearTimeout(timer);
        observer.close();
        reject(error);
        return;
      }

      if (matched) {
        clearTimeout(timer);
        observer.close();
        resolve(state);
      }
    });
  });
}

test.before(() => {
  startServer();
  return waitForHealthReady();
});

test.after(() => {
  return stopServer();
});

test("health reports the none-mode contract on both ports", async () => {
  for (const url of [HEALTH_URL, `${MONITOR_URL}/__pnds/health`]) {
    const payload = await (await fetch(url)).json();

    assert.equal(payload.status, "ready");
    assert.equal(payload.projectId, "mobile-sensor-meter");
    assert.equal(payload.audioMode, "none");
    assert.equal(payload.audio.status, "disabled");
    assert.equal(payload.audio.target, null);
    assert.equal(payload.scoreServer.performerPort, performerPort());
    assert.equal(payload.scoreServer.monitorPort, monitorPort());
  }
});

test("__config.js injects role, projectId and the resolved performer URL", async () => {
  const performerConfig = await (await fetch(`${PERFORMER_URL}/__config.js`)).text();
  const monitorConfig = await (await fetch(`${MONITOR_URL}/__config.js`)).text();

  assert.match(performerConfig, /"role":"performer"/);
  assert.match(monitorConfig, /"role":"monitor"/);
  for (const config of [performerConfig, monitorConfig]) {
    assert.match(config, /"projectId":"mobile-sensor-meter"/);
    assert.match(config, new RegExp(ENTRY_URL.replaceAll("/", "\\/")));
  }
});

test("the QR endpoint renders a PNG of the entry URL's page", async () => {
  const response = await fetch(`${MONITOR_URL}/qr`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /image\/png/);
  const buffer = Buffer.from(await response.arrayBuffer());
  // PNG magic.
  assert.equal(buffer[0], 0x89);
  assert.equal(buffer[1], 0x50);
});

// Resolves with the first state broadcast matching the predicate, read
// on an ALREADY-CONNECTED socket (the emitter's own): it receives the
// broadcast triggered by its own emit immediately, which a freshly
// connecting observer can miss entirely — the shrunken freshness window
// (400 ms) is shorter than the 1 Hz tick the latecomer would have to
// wait for, so "live" would already read "stale".
function nextStateOn(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("state predicate never matched (on socket)"));
    }, timeoutMs);

    const onState = (state) => {
      let matched = false;

      try {
        matched = predicate(state);
      } catch (error) {
        clearTimeout(timer);
        socket.off(EVENTS.state, onState);
        reject(error);
        return;
      }

      if (matched) {
        clearTimeout(timer);
        socket.off(EVENTS.state, onState);
        resolve(state);
      }
    };

    socket.on(EVENTS.state, onState);
  });
}

test("a mic's processed levels reach the monitor verbatim; silence survives as zeros, late results are refused", async () => {
  const socket = connect();
  const joined = await join(socket);

  socket.emit(EVENTS.sensorStart, { sensor: "mic", permission: "granted" });

  // Pre-sample: authorized, capturing, no data yet — its own state.
  const waiting = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.mic.capture === "on",
  );
  assert.equal(waiting.sensors.devices[joined.id].sensors.mic.freshness, "waiting");

  // A silent room: REAL zeros (rms/peak), the level at its documented
  // floor, the capture's rate riding along.
  socket.emit(EVENTS.sensorSample, {
    sensor: "mic",
    seq: 41,
    mic: { rms: 0, peak: 0, level: -90, sampleRate: 48000 },
  });

  const live = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.mic.sample?.seq === 41,
  );

  const mic = live.sensors.devices[joined.id].sensors.mic;
  assert.equal(mic.freshness, "live");
  // The dual-end agreement: what the monitor holds is exactly what the
  // phone sent (mic-logic.js analyzed, the hub stored — no audio ever
  // rode this wire, only these four numbers).
  assert.deepEqual(mic.sample.mic, {
    rms: 0,
    peak: 0,
    level: -90,
    sampleRate: 48000,
  });

  socket.emit(EVENTS.sensorStop, { sensor: "mic" });
  const stopped = await nextStateOn(
    socket,
    (state) =>
      state.sensors.devices[joined.id]?.sensors.mic.capture === "off",
  );
  assert.equal(stopped.sensors.devices[joined.id].sensors.mic.freshness, "off");

  // The late result: refused — the frozen silence survives untouched.
  socket.emit(EVENTS.sensorSample, {
    sensor: "mic",
    seq: 42,
    mic: { rms: 1, peak: 1, level: 0, sampleRate: 48000 },
  });

  await sleep(1300); // past a tick: an accepted sample would have shown

  const frozen = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.mic.capture === "off",
  );
  assert.deepEqual(frozen.sensors.devices[joined.id].sensors.mic.sample.mic, {
    rms: 0,
    peak: 0,
    level: -90,
    sampleRate: 48000,
  });

  socket.close();
});

test("a mic's samples after a background pause/resume keep climbing — no replay refusal", async () => {
  const socket = connect();
  const joined = await join(socket);

  socket.emit(EVENTS.sensorStart, { sensor: "mic", permission: "granted" });
  await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.mic.capture === "on",
  );

  socket.emit(EVENTS.sensorSample, {
    sensor: "mic",
    seq: 5,
    mic: { rms: 0.02, peak: 0.1, level: -34, sampleRate: 48000 },
  });
  await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.mic.sample?.seq === 5,
  );

  // Background and return — device-level events only: the phone's
  // silent re-acquisition sends NO new sensorStart, so the record (and
  // its seq bar) survives; the climbing seq must be accepted.
  socket.emit(EVENTS.sensorPause);
  const paused = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.paused === true,
  );
  assert.equal(paused.sensors.devices[joined.id].sensors.mic.freshness, "paused");

  socket.emit(EVENTS.sensorResume);
  socket.emit(EVENTS.sensorSample, {
    sensor: "mic",
    seq: 6,
    mic: { rms: 0.03, peak: 0.2, level: -30, sampleRate: 48000 },
  });
  const resumed = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.mic.sample?.seq === 6,
  );
  assert.equal(resumed.sensors.devices[joined.id].sensors.mic.freshness, "live");

  socket.close();
});

test("a device's sample reaches the monitor with the same seq and values; zeros and nulls survive the wire", async () => {
  const socket = connect();
  const joined = await join(socket);

  socket.emit(EVENTS.sensorStart, { sensor: "tilt", permission: "granted" });

  // Pre-sample: capturing with the authorized-but-no-samples state.
  const waiting = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.tilt.capture === "on",
  );
  assert.equal(waiting.sensors.devices[joined.id].sensors.tilt.freshness, "waiting");

  socket.emit(EVENTS.sensorSample, {
    sensor: "tilt",
    seq: 41,
    tilt: { alpha: 12.5, beta: 0, gamma: null },
  });

  const live = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.tilt.sample?.seq === 41,
  );

  const tilt = live.sensors.devices[joined.id].sensors.tilt;
  assert.equal(tilt.freshness, "live");
  assert.equal(tilt.sample.tilt.alpha, 12.5);
  assert.equal(tilt.sample.tilt.beta, 0); // a REAL zero
  assert.equal(tilt.sample.tilt.gamma, null); // a missing field

  socket.close();
});

test("a late sample after stop is refused; the frozen sample stays", async () => {
  const socket = connect();
  const joined = await join(socket);

  socket.emit(EVENTS.sensorStart, { sensor: "motion", permission: "granted" });
  await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.motion.capture === "on",
  );

  socket.emit(EVENTS.sensorSample, {
    sensor: "motion",
    seq: 3,
    motion: { x: 0.2, y: 0, z: 9.8, includesGravity: true, intensity: 0.1, shakeCount: 1 },
  });
  const sampled = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.motion.sample?.seq === 3,
  );
  assert.equal(sampled.sensors.devices[joined.id].sensors.motion.sample.motion.x, 0.2);

  socket.emit(EVENTS.sensorStop, { sensor: "motion" });
  const stopped = await nextStateOn(
    socket,
    (state) =>
      state.sensors.devices[joined.id]?.sensors.motion.capture === "off" &&
      state.sensors.devices[joined.id]?.sensors.motion.sample?.seq === 3,
  );
  assert.equal(stopped.sensors.devices[joined.id].sensors.motion.sample.motion.x, 0.2);

  // The late result: refused — the frozen sample survives untouched
  // (the 1 Hz tick carries the proof while the socket stays connected).
  socket.emit(EVENTS.sensorSample, {
    sensor: "motion",
    seq: 4,
    motion: { x: 5, y: 5, z: 5, includesGravity: false, intensity: 9, shakeCount: 8 },
  });

  await sleep(1300); // past a tick: any accepted sample would have shown

  const frozen = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.motion.capture === "off",
  );
  const motion = frozen.sensors.devices[joined.id].sensors.motion;
  assert.equal(motion.sample.seq, 3);
  assert.equal(motion.sample.motion.x, 0.2);
  assert.equal(motion.sample.motion.shakeCount, 1);
  assert.equal(motion.freshness, "off");

  socket.close();
});

test("devices are isolated and a reconnect recovers the identity", async () => {
  const a = connect();
  const aJoined = await join(a);
  const b = connect();
  const bJoined = await join(b);

  assert.notEqual(aJoined.id, bJoined.id);

  a.emit(EVENTS.sensorStart, { sensor: "tilt", permission: "granted" });
  b.emit(EVENTS.sensorStart, { sensor: "tilt", permission: "granted" });
  a.emit(EVENTS.sensorSample, {
    sensor: "tilt",
    seq: 1,
    tilt: { alpha: 1, beta: 1, gamma: 1 },
  });

  const state = await nextState(
    (s) => s.sensors.devices[aJoined.id]?.sensors.tilt.sample?.seq === 1,
  );
  assert.equal(state.sensors.devices[bJoined.id].sensors.tilt.sample, null);

  // B's sample never lands on A's row.
  b.emit(EVENTS.sensorSample, {
    sensor: "tilt",
    seq: 1,
    tilt: { alpha: 2, beta: 2, gamma: 2 },
  });
  const after = await nextState(
    (s) => s.sensors.devices[bJoined.id]?.sensors.tilt.sample?.seq === 1,
  );
  assert.equal(after.sensors.devices[aJoined.id].sensors.tilt.sample.tilt.alpha, 1);
  assert.equal(after.sensors.devices[bJoined.id].sensors.tilt.sample.tilt.alpha, 2);

  // A drops and reconnects with its claim token: same id, record kept.
  const aId = aJoined.id;
  a.close();
  await nextState((s) => s.sensors.devices[aId]?.connected === false);

  const a2 = connect();
  const rejoined = await join(a2, aJoined.token);
  assert.equal(rejoined.id, aId);
  assert.equal(rejoined.recovered, true);

  const recovered = await nextState(
    (s) => s.sensors.devices[aId]?.connected === true,
  );
  assert.equal(recovered.sensors.devices[aId].sensors.tilt.sample.tilt.alpha, 1);

  a2.close();
  b.close();
});

test("heartbeats never fake freshness under a shrunken window", async () => {
  const socket = connect();
  const joined = await join(socket);

  socket.emit(EVENTS.sensorStart, { sensor: "tilt", permission: "granted" });
  socket.emit(EVENTS.sensorSample, {
    sensor: "tilt",
    seq: 1,
    tilt: { alpha: 3, beta: 3, gamma: 3 },
  });
  await nextStateOn(
    socket,
    (s) => s.sensors.devices[joined.id]?.sensors.tilt.freshness === "live",
  );

  // Heartbeats keep landing while NO samples do — and keep landing
  // until the stale verdict is observed (the verdict must come from the
  // sample's age, not from the heartbeat path going quiet).
  const beat = setInterval(() => socket.emit(EVENTS.heartbeat), 100);
  await sleep(STALE_MS + 700);

  const stale = await nextStateOn(
    socket,
    (s) => s.sensors.devices[joined.id]?.sensors.tilt.freshness === "stale",
  );
  clearInterval(beat);

  assert.equal(stale.sensors.devices[joined.id].sensors.tilt.sample.seq, 1);
  assert.ok(stale.sensors.devices[joined.id].heartbeatAgeMs < STALE_MS);

  socket.close();
});

test("a backgrounded page reads paused", async () => {
  const socket = connect();
  const joined = await join(socket);

  socket.emit(EVENTS.sensorStart, { sensor: "tilt", permission: "granted" });
  socket.emit(EVENTS.sensorPause);

  const paused = await nextState(
    (s) => s.sensors.devices[joined.id]?.paused === true,
  );
  assert.equal(paused.sensors.devices[joined.id].sensors.tilt.freshness, "paused");

  socket.close();
});


test("the handpose asset inventory endpoint reports the committed local assets", async () => {
  const payload = await (await fetch(`${PERFORMER_URL}/handpose/assets.json`)).json();

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.missing, []);
  assert.equal(payload.runtime, "tfjs");
  assert.equal(payload.ml5.file, "ml5.min.js");
  assert.ok(payload.ml5.bytes > 1_000_000);
  assert.deepEqual(payload.detector.declaredShards, ["group1-shard1of1.bin"]);
  assert.deepEqual(payload.landmark.declaredShards, ["group1-shard1of1.bin"]);
  assert.equal(payload.detector.shards[0].present, true);
  assert.equal(payload.landmark.shards[0].present, true);
});

test("a handpose result reaches the monitor verbatim; no-hand survives as a result, late results are refused", async () => {
  const socket = connect();
  const joined = await join(socket);

  socket.emit(EVENTS.sensorStart, { sensor: "handpose", permission: "granted" });

  const waiting = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.handpose.capture === "on",
  );
  assert.equal(waiting.sensors.devices[joined.id].sensors.handpose.freshness, "waiting");

  // The model ran and found nothing: hands 0 with EMPTY keypoints and
  // live meters — a result, never "missing" (#144).
  socket.emit(EVENTS.sensorSample, {
    sensor: "handpose",
    seq: 7,
    handpose: { hands: 0, confidence: null, keypoints: [], inferMs: 18.2, rateHz: 9.5 },
  });

  const live = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.handpose.sample?.seq === 7,
  );

  const handpose = live.sensors.devices[joined.id].sensors.handpose;
  assert.equal(handpose.freshness, "live");
  assert.equal(handpose.sample.handpose.hands, 0);
  assert.deepEqual(handpose.sample.handpose.keypoints, []);
  assert.equal(handpose.sample.handpose.inferMs, 18.2);
  assert.equal(handpose.sample.handpose.rateHz, 9.5);

  // A detected hand: partial nulls survive per-field (#144).
  socket.emit(EVENTS.sensorSample, {
    sensor: "handpose",
    seq: 8,
    handpose: {
      hands: 1,
      confidence: 0.91,
      keypoints: [{ x: 0.5, y: 0.25 }, { x: null, y: 0.5 }],
      inferMs: 25,
      rateHz: 9,
    },
  });

  const detected = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.handpose.sample?.seq === 8,
  );
  const stored = detected.sensors.devices[joined.id].sensors.handpose.sample.handpose;
  assert.equal(stored.hands, 1);
  assert.equal(stored.keypoints[0].x, 0.5);
  assert.equal(stored.keypoints[1].x, null); // a missing coordinate

  socket.emit(EVENTS.sensorStop, { sensor: "handpose" });
  await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.handpose.capture === "off",
  );

  // The late result: refused — the frozen detection survives.
  socket.emit(EVENTS.sensorSample, {
    sensor: "handpose",
    seq: 9,
    handpose: { hands: 1, confidence: 1, keypoints: [], inferMs: 1, rateHz: 1 },
  });

  await sleep(1300);

  const frozen = await nextStateOn(
    socket,
    (state) => state.sensors.devices[joined.id]?.sensors.handpose.capture === "off",
  );
  const kept = frozen.sensors.devices[joined.id].sensors.handpose;
  assert.equal(kept.sample.seq, 8);
  assert.equal(kept.sample.handpose.hands, 1);
  assert.equal(kept.freshness, "off");

  socket.close();
});

test("SIGTERM stops cleanly: the process exits zero within the window", async () => {
  const exiting = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  child.kill("SIGTERM");
  const outcome = await Promise.race([exiting, sleep(5000).then(() => null)]);

  assert.ok(outcome, "the server must exit on SIGTERM");
  assert.equal(outcome.code, 0);
  assert.equal(outcome.signal, null);

  child = null; // test.after's stopServer must not double-kill
});
