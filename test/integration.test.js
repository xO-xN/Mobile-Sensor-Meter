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

const { io } = require("socket.io-client");

const PROJECT_ROOT = path.join(__dirname, "..");
const PERFORMER_URL = "http://127.0.0.1:6868";
const MONITOR_URL = "http://127.0.0.1:6869";
const HEALTH_URL = `${PERFORMER_URL}/__pnds/health`;
const ENTRY_URL = "https://show.example.org:8443/";

const { events: EVENTS } = require("../public/shared");

// The shrunken freshness window: samples stay "live" for 400 ms, so
// the staleness assertions run in wall-clock seconds.
const STALE_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child;

function startServer() {
  child = spawn(process.execPath, [path.join(PROJECT_ROOT, "server.js")], {
    env: {
      ...process.env,
      PNDS_HOST_IP: "127.0.0.1",
      PNDS_PERFORMER_URL: ENTRY_URL,
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
    assert.equal(payload.projectId, "mobile-sensor-diagnostics");
    assert.equal(payload.audioMode, "none");
    assert.equal(payload.audio.status, "disabled");
    assert.equal(payload.audio.target, null);
    assert.equal(payload.scoreServer.performerPort, 6868);
    assert.equal(payload.scoreServer.monitorPort, 6869);
  }
});

test("__config.js injects role, projectId and the resolved performer URL", async () => {
  const performerConfig = await (await fetch(`${PERFORMER_URL}/__config.js`)).text();
  const monitorConfig = await (await fetch(`${MONITOR_URL}/__config.js`)).text();

  assert.match(performerConfig, /"role":"performer"/);
  assert.match(monitorConfig, /"role":"monitor"/);
  for (const config of [performerConfig, monitorConfig]) {
    assert.match(config, /"projectId":"mobile-sensor-diagnostics"/);
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
