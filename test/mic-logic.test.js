// The browser-side microphone logic (public/mic-logic.js) driven through
// API stand-ins: fake getUserMedia responders, a fake analyser and a
// fake clock. These tests prove the exact rules the phone enforces —
// RMS/peak/level math (and its honest floor), silence as REAL zeros,
// the exclusive-resource release on stop/pause, late-grant and
// late-denial guards, the monotonic seq, and the independent
// capture/send rate limits.

const assert = require("node:assert/strict");
const test = require("node:test");

const ML = require("../public/mic-logic");

// ------------------------------------------------------------
// Analysis
// ------------------------------------------------------------

test("analyzeBlock: a sine's RMS/peak/level match the math; sampleRate rides along", () => {
  const samples = 2048;
  const block = new Float32Array(samples);

  for (let i = 0; i < samples; i += 1) {
    block[i] = 0.5 * Math.sin((2 * Math.PI * i) / samples);
  }

  const sample = ML.analyzeBlock(block, 48000);
  const expectedRms = 0.5 / Math.sqrt(2);

  assert.ok(Math.abs(sample.rms - expectedRms) < 1e-6, `rms ${sample.rms}`);
  assert.ok(Math.abs(sample.peak - 0.5) < 1e-6, `peak ${sample.peak}`);
  assert.ok(Math.abs(sample.level - 20 * Math.log10(expectedRms)) < 1e-6);
  assert.equal(sample.sampleRate, 48000);
});

test("silence is a REAL zero reading, and the level reads its documented floor", () => {
  const sample = ML.analyzeBlock(new Float32Array(2048), 44100);

  assert.equal(sample.rms, 0); // a silent room, not a missing field
  assert.equal(sample.peak, 0);
  assert.equal(sample.level, ML.MIC_LEVEL_FLOOR_DB); // −90: at or below
  assert.equal(sample.sampleRate, 44100);
});

test("a full-scale square reads 1.0 FS and 0.0 dBFS", () => {
  const block = new Float32Array(2048);

  for (let i = 0; i < block.length; i += 1) {
    block[i] = i % 2 === 0 ? 1 : -1;
  }

  const sample = ML.analyzeBlock(block, 48000);
  assert.equal(sample.rms, 1);
  assert.equal(sample.peak, 1);
  assert.equal(sample.level, 0);
});

test("a block that is not a sample — empty or poisoned — yields null", () => {
  assert.equal(ML.analyzeBlock(new Float32Array(0), 48000), null);
  assert.equal(ML.analyzeBlock(null, 48000), null);

  const poisoned = new Float32Array(2048);
  poisoned[100] = NaN;
  assert.equal(ML.analyzeBlock(poisoned, 48000), null);
});

test("a non-finite sampleRate travels as null (missing, never zero)", () => {
  const sample = ML.analyzeBlock(new Float32Array(16), undefined);
  assert.equal(sample.rms, 0);
  assert.equal(sample.sampleRate, null);
});

// ------------------------------------------------------------
// The controller, with API stand-ins
// ------------------------------------------------------------

function grantedStream() {
  const track = { stopped: false };
  return { getTracks: () => [track], track };
}

// The fake platform: getUserMedia responders queue up, the analyser
// reads from a scriptable buffer, the tick timer is collected and
// pumped by the test, and every teardown is recorded.
//
// Tick cadence note: one tick advances the fake clock by 16 ms, so the
// capture gate passes every tick while the send gate (33 ms) passes
// every THIRD tick — sends land on ticks 1, 4, 7, …
function makePlatform(options = {}) {
  const state = {
    gumCalls: [],
    responders: options.responders || [],
    releasedStreams: [],
    analysers: [],
    timers: new Map(),
    timerSeq: 0,
    clock: 0,
    fill: options.fill || (() => {}),
    sampleRate: options.sampleRate === undefined ? 48000 : options.sampleRate,
  };

  const platform = {
    state,
    now: () => state.clock,
    getUserMedia:
      options.getUserMedia === undefined
        ? (constraints) => {
            state.gumCalls.push(constraints);

            if (state.responders.length === 0) {
              return Promise.resolve(grantedStream());
            }

            const respond = state.responders.shift();
            return respond();
          }
        : options.getUserMedia,
    releaseStream: (stream) => {
      state.releasedStreams.push(stream);
      for (const track of stream.getTracks()) {
        track.stopped = true;
      }
    },
    openAnalyser: (stream, blockSize) => {
      assert.equal(blockSize, ML.MIC_BLOCK_SIZE);
      const analyser = {
        stream,
        closed: false,
        sampleRate: state.sampleRate,
        read(block) {
          state.fill(block);
        },
        close() {
          analyser.closed = true;
          for (const track of stream.getTracks()) {
            track.stopped = true;
          }
        },
      };
      state.analysers.push(analyser);
      return analyser;
    },
    schedule: (fn, intervalMs) => {
      state.timerSeq += 1;
      const id = state.timerSeq;
      state.timers.set(id, { fn, intervalMs });
      return () => state.timers.delete(id);
    },
    // The test drives the tick timer the page would pace in the browser.
    tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        state.clock += ML.MIC_TICK_MS;
        for (const { fn } of [...state.timers.values()]) {
          fn();
        }
      }
    },
  };

  return platform;
}

function denied(name = "NotAllowedError") {
  const error = new Error(name);
  error.name = name;
  return () => Promise.reject(error);
}

test("unsupported platforms (no getUserMedia — e.g. plain HTTP) report the fact and never request", () => {
  const platform = makePlatform({ getUserMedia: null });
  const events = [];
  const mic = new ML.MicController(platform, {
    onState: (state) => events.push(["state", state]),
    onPermission: (permission) => events.push(["permission", permission]),
  });

  mic.start();

  assert.equal(mic.stateOf(), "unsupported");
  assert.deepEqual(events, [
    ["permission", "unsupported"],
    ["state", "unsupported"],
  ]);
  assert.equal(platform.state.timers.size, 0);
});

test("the grant flow: starting → granted → on; samples flow with the analysis attached", async () => {
  const platform = makePlatform();
  const events = [];
  const sends = [];
  const mic = new ML.MicController(platform, {
    onState: (state) => events.push(state),
    onStart: (permission) => events.push("start:" + permission),
    onSend: (sample, seq) => sends.push([sample, seq]),
  });

  mic.start();
  assert.equal(mic.stateOf(), "starting");
  assert.equal(platform.state.timers.size, 0); // nothing ticks until granted

  await Promise.resolve(); // getUserMedia resolves

  assert.equal(mic.stateOf(), "on");
  assert.equal(platform.state.analysers.length, 1);
  assert.deepEqual(events, ["starting", "on", "start:granted"]);

  // The analyser hands a constant half-scale signal; the wire carries
  // the analysis of exactly that block.
  platform.state.fill = (block) => {
    for (let i = 0; i < block.length; i += 1) {
      block[i] = i % 2 === 0 ? 0.25 : -0.25;
    }
  };
  platform.tick();

  assert.equal(sends.length, 1);
  assert.equal(sends[0][1], 1); // seq counts from 1
  assert.ok(Math.abs(sends[0][0].rms - 0.25) < 1e-6);
  assert.equal(sends[0][0].sampleRate, 48000);
});

test("denied and failed requests are distinct, diagnosable outcomes", async () => {
  const deniedPlatform = makePlatform({ responders: [denied()] });
  const deniedEvents = [];
  const deniedMic = new ML.MicController(deniedPlatform, {
    onState: (s) => deniedEvents.push(s),
    onPermission: (p) => deniedEvents.push("perm:" + p),
  });

  deniedMic.start();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(deniedMic.stateOf(), "denied");
  assert.deepEqual(deniedEvents, ["starting", "denied", "perm:denied"]);

  const failedPlatform = makePlatform({ responders: [denied("NotFoundError")] });
  const failedMic = new ML.MicController(failedPlatform, {});
  failedMic.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(failedMic.stateOf(), "error");
});

test("a granted stream whose analysis graph cannot be built reports the grant and lands in error", async () => {
  const platform = makePlatform();
  platform.openAnalyser = () => {
    throw new Error("no audio hardware");
  };
  const events = [];
  const mic = new ML.MicController(platform, {
    onState: (s) => events.push(s),
    onPermission: (p) => events.push("perm:" + p),
    onStart: () => events.push("STARTED"),
  });

  mic.start();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(mic.stateOf(), "error");
  // The permission fact (granted) survives for the monitor's chip; the
  // stream is released; no capture ever started.
  assert.deepEqual(events, ["starting", "perm:granted", "error"]);
  assert.equal(platform.state.releasedStreams.length, 1);
  assert.equal(platform.state.releasedStreams[0].track.stopped, true);
  assert.equal(platform.state.timers.size, 0);
});

test("a LATE grant after stop releases the stream and restarts nothing", async () => {
  let resolveGrant;
  const gate = new Promise((resolve) => {
    resolveGrant = resolve;
  });
  const platform = makePlatform({ getUserMedia: () => gate });
  const events = [];
  const mic = new ML.MicController(platform, {
    onPermission: (p) => events.push("perm:" + p),
    onStart: () => events.push("STARTED"),
    onStop: () => events.push("stopped"),
  });

  mic.start();
  assert.equal(mic.stateOf(), "starting");

  // The user gives up and stops while the prompt is still open.
  mic.stop();
  assert.equal(mic.stateOf(), "off");

  resolveGrant(grantedStream());
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(mic.stateOf(), "off"); // still off
  assert.equal(platform.state.analysers.length, 0); // never opened
  assert.equal(platform.state.releasedStreams.length, 1); // the mic is
  // let go AT ONCE — the granted stream's tracks are stopped.
  assert.equal(platform.state.releasedStreams[0].track.stopped, true);
  assert.deepEqual(events, ["stopped", "perm:granted"]); // the fact, not a restart
});

test("a late denial after stop changes nothing at all", async () => {
  let rejectGrant;
  const gate = new Promise((resolve, reject) => {
    rejectGrant = reject;
  });
  const platform = makePlatform({ getUserMedia: () => gate });
  const events = [];
  const mic = new ML.MicController(platform, {
    onState: () => events.push("state"),
    onPermission: () => events.push("permission"),
  });

  mic.start();
  mic.stop();
  events.length = 0;

  rejectGrant(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(mic.stateOf(), "off");
  assert.deepEqual(events, []);
});

test("stop releases everything: the tick timer, the analyser, the stream", async () => {
  const platform = makePlatform();
  const mic = new ML.MicController(platform, {});

  mic.start();
  await Promise.resolve();

  assert.equal(platform.state.timers.size, 1);
  const analyser = platform.state.analysers[0];

  mic.stop();

  assert.equal(mic.stateOf(), "off");
  assert.equal(platform.state.timers.size, 0); // the tick is cancelled
  assert.equal(analyser.closed, true); // the graph (stream + context) is gone
  assert.equal(analyser.stream.track.stopped, true);

  // A stray late tick — even if one somehow fired — processes nothing.
  platform.tick();
});

test("pause (background) releases the mic while keeping the user's intent; resume re-acquires silently", async () => {
  const platform = makePlatform();
  const events = [];
  const sends = [];
  const mic = new ML.MicController(platform, {
    onStart: () => events.push("start"),
    onSend: (sample, seq) => sends.push(seq),
  });

  mic.start();
  await Promise.resolve();
  platform.tick();
  assert.deepEqual(sends, [1]);
  const analyser = platform.state.analysers[0];

  mic.pause();

  assert.equal(mic.paused, true);
  assert.equal(mic.stateOf(), "on"); // the intent stays "on"…
  assert.equal(analyser.closed, true); // …but the mic is fully released
  assert.equal(platform.state.timers.size, 0);
  assert.equal(platform.state.gumCalls.length, 1); // no request while hidden

  platform.tick(5); // nothing ticks — nothing sends
  assert.deepEqual(sends, [1]);

  mic.resume();

  assert.equal(platform.state.gumCalls.length, 2); // silent re-acquisition
  await Promise.resolve();

  assert.equal(mic.stateOf(), "on");
  assert.equal(platform.state.analysers.length, 2);
  assert.deepEqual(events, ["start"]); // NO second onStart: the server's
  // record (capture on, frozen sample) is the truth to keep.

  platform.tick();
  assert.deepEqual(sends, [1, 2]); // the seq keeps climbing — provably new
});

test("pause during the permission prompt converts to a stop; the late grant is just a fact", async () => {
  let resolveGrant;
  const gate = new Promise((resolve) => {
    resolveGrant = resolve;
  });
  let gumCalls = 0;
  const platform = makePlatform({
    getUserMedia: () => {
      gumCalls += 1;
      return gate;
    },
  });
  const events = [];
  const mic = new ML.MicController(platform, {
    onStop: () => events.push("stopped"),
    onPermission: (p) => events.push("perm:" + p),
    onStart: () => events.push("STARTED"),
  });

  mic.start();
  assert.equal(mic.stateOf(), "starting");

  mic.pause(); // backgrounded mid-prompt

  assert.equal(mic.stateOf(), "off");
  assert.deepEqual(events, ["stopped"]);

  resolveGrant(grantedStream());
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(mic.stateOf(), "off");
  assert.equal(platform.state.releasedStreams.length, 1);
  assert.deepEqual(events, ["stopped", "perm:granted"]);

  mic.resume(); // a stopped capture never restarts on its own
  assert.equal(gumCalls, 1);
});

test("resume with the capture stopped requests nothing", () => {
  const platform = makePlatform();
  const mic = new ML.MicController(platform, {});

  mic.resume();
  assert.equal(platform.state.gumCalls.length, 0);
});

test("a failed silent re-acquisition lands in a diagnosable state", async () => {
  const platform = makePlatform();
  const mic = new ML.MicController(platform, {});

  mic.start();
  await Promise.resolve();

  mic.pause();
  platform.state.responders.push(denied());
  mic.resume();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(mic.stateOf(), "denied");
});

test("seq is monotonic for the controller's life — a restart never replays", async () => {
  const platform = makePlatform();
  const sends = [];
  const mic = new ML.MicController(platform, {
    onSend: (sample, seq) => sends.push(seq),
  });

  mic.start();
  await Promise.resolve();
  platform.tick();

  mic.stop();
  mic.start();
  await Promise.resolve();
  platform.tick();

  // A seq-resetting controller would emit 1 again — the server would
  // then read the new capture's samples as replays of the old.
  assert.deepEqual(sends, [1, 2]);
});

test("capture and send limit independently; only the latest sample is sent", async () => {
  const platform = makePlatform();
  const sends = [];
  const mic = new ML.MicController(platform, {
    onSend: (sample) => sends.push(sample.rms),
  });

  mic.start();
  await Promise.resolve();

  // A louder block every tick: 120 ticks at the 16 ms cadence (~2 s of
  // ~60 Hz analysis). The send gate (33 ms) passes every third one —
  // 40 sends, the same budget the motion sensors' tests pin.
  let level = 0;
  platform.state.fill = (block) => {
    level += 0.001;
    for (let i = 0; i < block.length; i += 1) {
      block[i] = level;
    }
  };
  platform.tick(120);

  assert.equal(sends.length, 40, `send ${sends.length}`);
  // Every send carries the LATEST analyzed block — the last send is the
  // loudest, never an old one, and nothing queues between sends.
  assert.ok(sends[sends.length - 1] > 0.11, `latest ${sends[sends.length - 1]}`);
});
