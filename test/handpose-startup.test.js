const assert = require("node:assert/strict");
const test = require("node:test");
const { HandPoseController } = require("../public/handpose-logic");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function harness() {
  const ready = deferred();
  const inference = deferred();
  const samples = [];
  const phases = [];
  let progress;
  let disposed = 0;
  let created = 0;
  let tick;
  let frame = null;
  const frameSize = { width: 640, height: 480 };
  let now = 0;
  const model = {
    ready: ready.promise,
    detect: () => inference.promise,
    dispose() {
      disposed += 1;
    },
  };
  const controller = new HandPoseController(
    {
      now: () => ++now,
      getUserMedia: () => Promise.resolve({}),
      attachStream() {},
      detachStream() {},
      releaseStream() {},
      createModel(config, onProgress) {
        created += 1;
        progress = onProgress;
        return model;
      },
      modelUrls: {
        detectorModelUrl: "/detector/model.json",
        landmarkModelUrl: "/landmark/model.json",
      },
      media: () => frame,
      mediaSize: () => frameSize,
      schedule(fn) {
        tick = fn;
        return () => {
          tick = null;
        };
      },
    },
    {
      onState() {
        phases.push(controller.phaseOf());
      },
      onSend: (sample, seq) => samples.push({ sample, seq }),
    },
  );
  return {
    controller,
    ready,
    inference,
    samples,
    phases,
    progress: (phase) => progress(phase),
    tick: () => tick?.(),
    frames: () => {
      frame = {};
    },
    disposed: () => disposed,
    created: () => created,
    resize: () => {
      frameSize.width = 320;
      frameSize.height = 240;
    },
  };
}

test("startup stays visibly pending until the first real inference completes", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  assert.equal(h.controller.phaseOf(), "loading-runtime");
  h.progress("loading-model");
  assert.equal(h.controller.phaseOf(), "loading-model");
  h.ready.resolve();
  await flush();
  assert.equal(h.controller.phaseOf(), "waiting-frame");
  h.tick();
  assert.equal(h.controller.phaseOf(), "waiting-frame");
  h.frames();
  h.tick();
  assert.equal(h.controller.phaseOf(), "warming-up");
  assert.equal(h.samples.length, 0);
  h.inference.resolve([]);
  await flush();
  assert.equal(h.controller.phaseOf(), "ready");
  assert.equal(h.samples[0].sample.hands, 0);
  assert.equal(h.samples[0].seq, 1);
});

test("stop cancels a still-loading model immediately and ignores late progress/readiness", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.controller.stop();
  assert.equal(h.disposed(), 1);
  h.progress("loading-model");
  h.ready.resolve();
  await flush();
  assert.equal(h.disposed(), 1);
  assert.equal(h.controller.stateOf(), "off");
  assert.equal(h.controller.phaseOf(), null);
  assert.equal(h.samples.length, 0);
});

test("stopping during first inference drops its result and never announces ready", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.ready.resolve();
  await flush();
  h.frames();
  h.tick();
  h.controller.stop();
  h.inference.resolve([]);
  await flush();
  assert.equal(h.controller.stateOf(), "off");
  assert.equal(h.controller.phaseOf(), null);
  assert.equal(h.samples.length, 0);
  assert.equal(h.phases.includes("ready"), false);
});

test("backgrounding during model loading resumes the same pending worker", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.controller.pause();
  h.controller.resume();
  await flush();
  assert.equal(h.created(), 1);
  assert.equal(h.disposed(), 0);
  h.ready.resolve();
  await flush();
  h.frames();
  h.tick();
  h.inference.resolve([]);
  await flush();
  assert.equal(h.controller.phaseOf(), "ready");
  assert.equal(h.samples.length, 1);
});

test("a first-inference result from before backgrounding is discarded after resume", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.ready.resolve();
  await flush();
  h.frames();
  h.tick();
  h.controller.pause();
  h.controller.resume();
  await flush();
  h.inference.resolve([]);
  await flush();
  assert.equal(h.samples.length, 0);
  assert.notEqual(h.controller.phaseOf(), "ready");
  h.tick();
  await flush();
  assert.equal(h.samples.length, 1);
});

test("coordinates use the submitted frame size even when video dimensions change in flight", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.ready.resolve();
  await flush();
  h.frames();
  h.tick();
  h.resize();
  h.inference.resolve([{ confidence: 0.9, keypoints: [{ x: 320, y: 240 }] }]);
  await flush();
  assert.deepEqual(h.samples[0].sample.keypoints, [{ x: 0.5, y: 0.5 }]);
});
