// The browser-side handpose logic (public/handpose-logic.js) driven
// through API stand-ins: fake cameras, a fake lazy script loader, a
// fake model factory and a fake clock. These tests prove the exact
// rules the phone enforces — the three-stage pipeline with distinct
// failures (camera / model / inference), "no hand" as a RESULT, the
// exclusive camera released on stop and background while the model is
// kept for a fast silent resume, late results dropped, and the honest
// update rate derived from inference completions alone.

const assert = require("node:assert/strict");
const test = require("node:test");

const HPL = require("../public/handpose-logic");

// ------------------------------------------------------------
// Sample building
// ------------------------------------------------------------

test("buildSample normalizes pixel keypoints to [0,1] and caps at 21", () => {
  const keypoints = [];

  for (let i = 0; i < 30; i += 1) {
    keypoints.push({ name: "p" + i, x: i * 32, y: 480 - i * 16 });
  }

  const sample = HPL.buildSample(
    [{ confidence: 0.92, keypoints }],
    23.5,
    9.5,
    { width: 640, height: 480 },
  );

  assert.equal(sample.hands, 1);
  assert.equal(sample.confidence, 0.92);
  assert.equal(sample.keypoints.length, HPL.MAX_KEYPOINTS); // capped
  assert.ok(Math.abs(sample.keypoints[0].x - 0) < 1e-9);
  assert.ok(Math.abs(sample.keypoints[0].y - 1) < 1e-9);
  assert.ok(Math.abs(sample.keypoints[1].x - 32 / 640) < 1e-9);
  assert.equal(sample.inferMs, 23.5);
  assert.equal(sample.rateHz, 9.5);
});

test("no hand is a RESULT: zero hands, empty keypoints, null confidence", () => {
  const sample = HPL.buildSample([], 18, 9, { width: 640, height: 480 });

  assert.equal(sample.hands, 0); // a real zero, never "unavailable"
  assert.deepEqual(sample.keypoints, []);
  assert.equal(sample.confidence, null);
});

test("without a frame size the coordinates are missing, never guessed", () => {
  const sample = HPL.buildSample(
    [{ confidence: 0.5, keypoints: [{ x: 100, y: 100 }] }],
    10,
    9,
    null,
  );

  assert.equal(sample.hands, 1);
  assert.equal(sample.keypoints[0].x, null);
  assert.equal(sample.keypoints[0].y, null);
});

test("non-finite values fold to missing; a non-array hands result reads as zero hands", () => {
  const sample = HPL.buildSample(
    [{ confidence: NaN, keypoints: [{ x: NaN, y: 64 }] }],
    10,
    9,
    { width: 640, height: 480 },
  );

  assert.equal(sample.confidence, null);
  assert.equal(sample.keypoints[0].x, null);
  assert.equal(sample.keypoints[0].y, 64 / 480);

  assert.equal(HPL.buildSample(null, 10, 9, null).hands, 0);
});

// ------------------------------------------------------------
// The honest update rate
// ------------------------------------------------------------

test("the rate counts only inference completions inside the window", () => {
  const rate = new HPL.InferenceRate(2000);

  rate.record(0);
  rate.record(100);
  rate.record(200);

  assert.equal(rate.hz(300), 1.5); // 3 completions / 2 s

  // Completions age out by AGE, not by how many came after: recording
  // at 2500 and asking at 2600 leaves only the fresh one inside
  // (0/100/200 are all older than the 2 s window now).
  rate.record(2500);
  assert.equal(rate.hz(2600), 0.5);

  rate.record(2900);
  assert.equal(rate.hz(3000), 1); // 2500 and 2900
});

// ------------------------------------------------------------
// The controller, with API stand-ins
// ------------------------------------------------------------

function fakeHands(keypointCount = 21) {
  const keypoints = [];

  for (let i = 0; i < keypointCount; i += 1) {
    keypoints.push({ name: "k" + i, x: i * 30, y: 120 });
  }

  return [{ confidence: 0.9, keypoints }];
}

// The fake platform: camera responders queue up, the lazy script and
// the model factory are driven by the test, the inference tick timer
// is collected and pumped, and every teardown is recorded.
function makePlatform(options = {}) {
  const state = {
    gumCalls: [],
    releasedStreams: [],
    attached: 0,
    detached: 0,
    scripts: [],
    scriptResults: [], // per-load: "ok" | "error"
    modelConfigs: [],
    disposedModels: 0,
    detects: 0,
    detectResults: [],
    detectErrors: [],
    timers: new Map(),
    timerSeq: 0,
    clock: 0,
    mediaSize: options.mediaSize === undefined ? { width: 640, height: 480 } : options.mediaSize,
  };

  let scriptIndex = -1;

  const platform = {
    state,
    now: () => state.clock,
    getUserMedia:
      options.getUserMedia === undefined
        ? (constraints) => {
            state.gumCalls.push(constraints);

            if (options.gum === "deny") {
              return Promise.reject(
                Object.assign(new Error("denied"), { name: "NotAllowedError" }),
              );
            }

            const track = { stopped: false };
            return Promise.resolve({ getTracks: () => [track], track });
          }
        : options.getUserMedia,
    releaseStream: (stream) => {
      state.releasedStreams.push(stream);
      for (const track of stream.getTracks()) {
        track.stopped = true;
      }
    },
    attachStream: () => {
      state.attached += 1;
    },
    detachStream: () => {
      state.detached += 1;
    },
    media: () => ({ readyState: "live" }),
    mediaSize: () => state.mediaSize,
    loadScript: (src) => {
      scriptIndex += 1;
      const index = scriptIndex;
      state.scripts.push(src);

      return new Promise((resolve, reject) => {
        state.scriptResults.push({
          resolve: () => resolve(),
          reject: () => reject(new Error("script failed: " + src)),
          index,
        });
      });
    },
    createModel: (config) => {
      state.modelConfigs.push(config);

      return {
        ready: Promise.resolve(),
        detect: () => {
          state.detects += 1;

          if (state.detectErrors.length > 0) {
            return Promise.reject(state.detectErrors.shift());
          }

          return Promise.resolve(
            state.detectResults.length > 0 ? state.detectResults.shift() : fakeHands(),
          );
        },
        dispose: () => {
          state.disposedModels += 1;
        },
      };
    },
    scriptSrc: "/__pnds/shared/ml5.js",
    ...(options.webglProbe === undefined
      ? {}
      : { webglProbe: () => options.webglProbe }),
    modelUrls: {
      detectorModelUrl: "/vendor/handpose/detector/model.json",
      landmarkModelUrl: "/vendor/handpose/landmark/model.json",
    },
    schedule: (fn) => {
      state.timerSeq += 1;
      const id = state.timerSeq;
      state.timers.set(id, fn);
      return () => state.timers.delete(id);
    },
    // The test drives the inference tick the page would pace.
    tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        state.clock += HPL.HANDPOSE_TICK_MS;
        for (const fn of [...state.timers.values()]) {
          fn();
        }
      }
    },
  };

  return platform;
}

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

// Drives the camera+script+model stages to "running" using the happy
// path, so behavior tests can start from a live pipeline. Resolves the
// LATEST pending script load (a restarted pipeline appends a new one).
async function startRunning(controller, platform) {
  controller.start();
  await flush();
  const pending = platform.state.scriptResults.filter((r) => !r.done);

  for (const result of pending) {
    result.resolve();
    result.done = true;
  }
  await flush();
}

test("the happy path: camera → local model → running, with the pinned local URLs", async () => {
  const platform = makePlatform();
  const events = [];
  const sends = [];
  const controller = new HPL.HandPoseController(platform, {
    onState: (state) => events.push(state),
    onStart: (permission) => events.push("start:" + permission),
    onSend: (sample, seq) => sends.push([sample, seq]),
  });

  controller.start();

  assert.equal(controller.stateOf(), "camera-starting");
  await flush();

  assert.equal(platform.state.attached, 1); // the preview is live
  assert.equal(controller.stateOf(), "loading-model");
  assert.equal(platform.state.scripts.length, 1); // the lazy ml5 load
  assert.equal(platform.state.scripts[0], "/__pnds/shared/ml5.js");

  await platform.state.scriptResults[0].resolve();
  await flush();

  assert.equal(controller.stateOf(), "running");
  assert.equal(platform.state.modelConfigs.length, 1);
  assert.deepEqual(platform.state.modelConfigs[0], {
    maxHands: 1,
    runtime: "tfjs",
    modelType: "lite",
    detectorModelUrl: "/vendor/handpose/detector/model.json",
    landmarkModelUrl: "/vendor/handpose/landmark/model.json",
  });

  platform.tick();
  await flush(); // the detect promise settles on a microtask

  assert.equal(sends.length, 1);
  assert.equal(sends[0][1], 1);
  assert.equal(sends[0][0].hands, 1);
  assert.equal(sends[0][0].keypoints.length, 21);
  assert.ok(sends[0][0].inferMs >= 0);
  assert.ok(sends[0][0].rateHz > 0);
  assert.deepEqual(
    events.filter((e) => typeof e === "string" && e.startsWith("start:")),
    ["start:granted"],
  );
});

test("an unsupported platform (no getUserMedia — plain HTTP) reports the fact and never asks", () => {
  const platform = makePlatform({ getUserMedia: null });
  const events = [];
  const controller = new HPL.HandPoseController(platform, {
    onState: (s) => events.push(s),
    onPermission: (p) => events.push("perm:" + p),
  });

  controller.start();

  assert.equal(controller.stateOf(), "unsupported");
  assert.deepEqual(events, ["perm:unsupported", "unsupported"]);
});

test("a denied camera is its own state — recoverable by the next Enable", async () => {
  const platform = makePlatform({ gum: "deny" });
  const controller = new HPL.HandPoseController(platform, {});

  controller.start();
  await flush();

  assert.equal(controller.stateOf(), "camera-denied");
  assert.equal(platform.state.scripts.length, 0);

  // Recoverable: the next tap starts over (this platform still denies,
  // but the state machine moved through camera-starting again).
  controller.start();
  assert.equal(controller.stateOf(), "camera-starting");
});

test("a failed script load (missing vendor assets) is model-error; the CAMERA KEEPS RUNNING", async () => {
  const platform = makePlatform();
  const controller = new HPL.HandPoseController(platform, {});

  controller.start();
  await flush();

  assert.equal(controller.stateOf(), "loading-model");
  assert.equal(platform.state.attached, 1);

  await platform.state.scriptResults[0].reject();
  await flush();

  assert.equal(controller.stateOf(), "model-error");
  assert.equal(platform.state.detached, 0); // the preview keeps proving
  // the camera path works while the model path does not.
  assert.equal(platform.state.timers.size, 0);

  // The card shows the REAL reason — the script that failed to load,
  // not a blanket "run the fetch script" (the assets may all exist).
  assert.match(controller.failureDetail(), /__pnds\/shared\/ml5\.js/);

  // Recoverable: the next Enable starts the whole pipeline over.
  controller.start();
  await flush();
  assert.equal(controller.stateOf(), "loading-model");
  assert.equal(controller.failureDetail(), null); // clean slate
});

test("a failed model init (weights missing / WebGL unavailable) is model-error too", async () => {
  const platform = makePlatform();
  platform.createModel = () => ({
    ready: Promise.reject(new Error("404 model.json")),
    detect: () => Promise.resolve([]),
    dispose: () => {},
  });
  const controller = new HPL.HandPoseController(platform, {});

  controller.start();
  await flush();
  await platform.state.scriptResults[0].resolve();
  await flush();

  assert.equal(controller.stateOf(), "model-error");
  // The underlying tfjs/loader message survives verbatim.
  assert.equal(controller.failureDetail(), "404 model.json");
});

test("a WebGL-less page fails FAST: no script download, no model — and the camera keeps proving", async () => {
  const platform = makePlatform({ webglProbe: "WebGL unavailable on this page" });
  const controller = new HPL.HandPoseController(platform, {});

  controller.start();
  await flush();

  assert.equal(controller.stateOf(), "model-error");
  assert.equal(controller.failureDetail(), "WebGL unavailable on this page");
  assert.equal(platform.state.scripts.length, 0); // the 4.5 MB stays unsent
  assert.equal(platform.state.modelConfigs.length, 0);
  assert.equal(platform.state.attached, 1); // the preview is still live
  assert.equal(platform.state.detached, 0);

  // A platform without the probe at all fails OPEN (the model loader's
  // own error still speaks): the happy path is untouched.
  const openPlatform = makePlatform();
  const openController = new HPL.HandPoseController(openPlatform, {});
  openController.start();
  await flush();
  assert.equal(openController.stateOf(), "loading-model");
});

test("stop releases everything: loop, model, camera — and emits the server stop", async () => {
  const platform = makePlatform();
  const events = [];
  const controller = new HPL.HandPoseController(platform, {
    onStop: () => events.push("stopped"),
  });

  await startRunning(controller, platform);
  assert.equal(controller.stateOf(), "running");

  controller.stop();

  assert.equal(controller.stateOf(), "off");
  assert.equal(platform.state.timers.size, 0); // the inference loop is gone
  assert.equal(platform.state.disposedModels, 1); // the GPU memory is freed
  assert.equal(platform.state.detached, 1); // the preview is unbound
  assert.equal(platform.state.releasedStreams.length, 1); // camera released
  assert.deepEqual(events, ["stopped"]);

  // A late inference result from the stopped loop is dropped.
  platform.state.detectResults.push(fakeHands());
  platform.tick();
  await flush();
  // (No assertion surface: the loop is cancelled — the tick does
  // nothing; the sends array lives in the caller's tests.)
});

test("a LATE camera grant after stop releases the stream and restarts nothing", async () => {
  let resolveGrant;
  const gate = new Promise((resolve) => {
    resolveGrant = resolve;
  });
  const platform = makePlatform({ getUserMedia: () => gate });
  const events = [];
  const controller = new HPL.HandPoseController(platform, {
    onPermission: (p) => events.push("perm:" + p),
    onStart: () => events.push("STARTED"),
    onStop: () => events.push("stopped"),
  });

  controller.start();
  controller.stop();

  const track = { stopped: false };
  resolveGrant({ getTracks: () => [track], track });
  await flush();

  assert.equal(controller.stateOf(), "off");
  assert.equal(track.stopped, true); // the camera is let go AT ONCE
  assert.equal(platform.state.attached, 0); // never previewed
  // The fact only — no onStop either: the server was never told a
  // capture existed, so there is nothing to stop on its books.
  assert.deepEqual(events, ["perm:granted"]);
});

test("a LATE model-ready after stop disposes the model it finished loading", async () => {
  const platform = makePlatform();
  let resolveReady;
  platform.createModel = (config) => {
    platform.state.modelConfigs.push(config);
    return {
      ready: new Promise((resolve) => {
        resolveReady = resolve;
      }),
      detect: () => Promise.resolve([]),
      dispose: () => {
        platform.state.disposedModels += 1;
      },
    };
  };
  const events = [];
  const controller = new HPL.HandPoseController(platform, {
    onStart: () => events.push("STARTED"),
  });

  controller.start();
  await flush();
  await platform.state.scriptResults[0].resolve();
  await flush();
  assert.equal(platform.state.modelConfigs.length, 1);

  // The user gives up while the weights are still loading.
  controller.stop();

  resolveReady();
  await flush();

  assert.equal(controller.stateOf(), "off");
  assert.equal(platform.state.disposedModels, 1); // unwanted → freed
  assert.deepEqual(events, []); // never announced a start
});

test("pause (background) releases the CAMERA but keeps the MODEL; resume is silent and seq continues", async () => {
  const platform = makePlatform();
  const events = [];
  const sends = [];
  const controller = new HPL.HandPoseController(platform, {
    onStart: () => events.push("start"),
    onSend: (sample, seq) => sends.push(seq),
  });

  await startRunning(controller, platform);
  platform.tick();
  await flush();
  assert.deepEqual(sends, [1]);

  controller.pause();

  assert.equal(controller.paused, true);
  assert.equal(controller.stateOf(), "running"); // intent kept
  assert.equal(platform.state.detached, 1); // camera released
  assert.equal(platform.state.releasedStreams.length, 1);
  assert.equal(platform.state.disposedModels, 0); // the model is memory, kept
  assert.equal(platform.state.timers.size, 0);

  platform.tick(3); // nothing ticks in the background
  assert.deepEqual(sends, [1]);

  controller.resume();
  await flush();

  assert.equal(platform.state.gumCalls.length, 2); // silent re-acquisition
  assert.equal(controller.stateOf(), "running");
  assert.equal(platform.state.disposedModels, 0); // the kept model runs
  assert.deepEqual(events, ["start"]); // no second onStart

  platform.tick();
  await flush();
  assert.deepEqual(sends, [1, 2]); // the seq keeps climbing
});

test("pause during the camera prompt converts to a stop; the late grant is a fact", async () => {
  let resolveGrant;
  const gate = new Promise((resolve) => {
    resolveGrant = resolve;
  });
  const platform = makePlatform({ getUserMedia: () => gate });
  const events = [];
  const controller = new HPL.HandPoseController(platform, {
    onStop: () => events.push("stopped"),
    onPermission: (p) => events.push("perm:" + p),
  });

  controller.start();
  controller.pause();

  assert.equal(controller.stateOf(), "off");

  const track = { stopped: false };
  resolveGrant({ getTracks: () => [track], track });
  await flush();

  assert.equal(controller.stateOf(), "off");
  assert.equal(track.stopped, true);
  // No onStop: the server never knew about this capture (only the
  // permission fact travels — a prompt cancelled mid-flight).
  assert.deepEqual(events, ["perm:granted"]);
});

test("an inference FAULT stops the loop, disposes the model, keeps the camera", async () => {
  const platform = makePlatform();
  const controller = new HPL.HandPoseController(platform, {});

  await startRunning(controller, platform);

  platform.state.detectErrors.push(new Error("backend lost"));
  platform.tick();
  await flush();

  assert.equal(controller.stateOf(), "error");
  assert.equal(platform.state.disposedModels, 1); // the suspect model is gone
  assert.equal(platform.state.timers.size, 0); // the loop is stopped
  assert.equal(platform.state.detached, 0); // the preview keeps running
  assert.equal(controller.failureDetail(), "backend lost"); // the real reason

  // stop() clears the stale reason — a stopped card carries no ghost.
  controller.stop();
  await flush();
  assert.equal(controller.failureDetail(), null);
});

test("an inference result arriving after pause is dropped, and busy ticks never overlap", async () => {
  const platform = makePlatform();
  const sends = [];
  const controller = new HPL.HandPoseController(platform, {
    onSend: (sample, seq) => sends.push(seq),
  });

  await startRunning(controller, platform);

  // A detect that resolves on the test's schedule: the first tick
  // starts it, the second tick lands while it is still busy.
  let resolveDetect;
  platform.createModel = (config) => {
    platform.state.modelConfigs.push(config);
    return {
      ready: Promise.resolve(),
      detect: () => {
        platform.state.detects += 1;
        return new Promise((resolve) => {
          resolveDetect = () => resolve(fakeHands());
        });
      },
      dispose: () => {
        platform.state.disposedModels += 1;
      },
    };
  };

  // Restart the pipeline against the new factory.
  controller.stop();
  await startRunning(controller, platform);

  platform.tick(); // starts the in-flight inference
  const detectsBefore = platform.state.detects;
  platform.tick(); // busy — must NOT start another
  assert.equal(platform.state.detects, detectsBefore);

  controller.pause(); // background while the inference is in flight
  resolveDetect(); // the late result lands NOW
  await flush();

  assert.deepEqual(sends, []); // dropped — a late result is not a sample
});

test("resume with the capture stopped or failed asks for nothing", () => {
  const platform = makePlatform();
  const controller = new HPL.HandPoseController(platform, {});

  controller.resume();
  assert.equal(platform.state.gumCalls.length, 0);
});

test("re-enabling after a model error releases the OLD camera before the new one", async () => {
  const platform = makePlatform();
  const controller = new HPL.HandPoseController(platform, {});

  controller.start();
  await flush();
  await platform.state.scriptResults[0].reject(); // → model-error, camera kept
  await flush();
  assert.equal(controller.stateOf(), "model-error");

  const firstStreamTracks = platform.state.releasedStreams.length; // 0 so far

  controller.start(); // recoverable: the whole pipeline starts over
  await flush();

  // The first stream WAS released at handover — not orphaned (an
  // orphaned track would keep the camera indicator lit forever).
  assert.equal(platform.state.releasedStreams.length, firstStreamTracks + 1);
  assert.equal(platform.state.attached, 2); // old preview, new preview
});

test("the camera constraints: front camera, no audio, no processing flags", async () => {
  const platform = makePlatform();
  const controller = new HPL.HandPoseController(platform, {});

  controller.start();
  await flush();

  assert.deepEqual(platform.state.gumCalls[0], {
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  });
});
