const assert = require("node:assert/strict");
const test = require("node:test");
const { createModel, supported } = require("../public/handpose-worker-client");

function harness(options = {}) {
  const workers = [];
  const bitmaps = [];
  class Worker {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.terminated = 0;
      workers.push(this);
    }
    postMessage(message, transfer) {
      this.sent.push({ message, transfer });
    }
    terminate() {
      this.terminated += 1;
    }
    receive(message) {
      this.onmessage({ data: message });
    }
  }
  const platform = {
    Worker,
    OffscreenCanvas: class {},
    createImageBitmap:
      options.createImageBitmap ||
      (() => {
        const bitmap = {
          closed: 0,
          close() {
            this.closed += 1;
          },
        };
        bitmaps.push(bitmap);
        return Promise.resolve(bitmap);
      }),
    setTimeout,
    clearTimeout,
  };
  const progress = [];
  const model = createModel(
    { detectorModelUrl: "/detector.json", landmarkModelUrl: "/landmark.json" },
    {
      platform,
      onProgress: (phase) => progress.push(phase),
      ...options,
    },
  );
  return { model, worker: workers[0], bitmaps, progress, platform };
}

test("model loading and inference are dispatched only to a dedicated worker", async () => {
  const h = harness();
  assert.equal(h.worker.url, "/handpose-worker.js");
  assert.equal(h.worker.sent[0].message.type, "init");
  assert.equal(h.worker.sent[0].message.scriptSrc, "/__pnds/shared/ml5.js");
  h.worker.receive({ type: "progress", phase: "loading-runtime" });
  h.worker.receive({ type: "progress", phase: "loading-model" });
  h.worker.receive({ type: "ready" });
  await h.model.ready;
  const frame = {};
  const result = h.model.detect(frame);
  await Promise.resolve();
  const sent = h.worker.sent.at(-1);
  assert.equal(sent.message.type, "detect");
  assert.equal(sent.message.frame, h.bitmaps[0]);
  assert.deepEqual(sent.transfer, [h.bitmaps[0]]);
  h.worker.receive({ type: "result", id: sent.message.id, hands: [] });
  assert.deepEqual(await result, []);
  assert.deepEqual(h.progress, ["loading-runtime", "loading-model"]);
  h.model.dispose();
});

test("busy inference never queues another frame", async () => {
  const h = harness();
  h.worker.receive({ type: "ready" });
  await h.model.ready;
  const first = h.model.detect({});
  await assert.rejects(h.model.detect({}), /already in flight/);
  await Promise.resolve();
  const sent = h.worker.sent.at(-1).message;
  h.worker.receive({ type: "result", id: sent.id, hands: [] });
  await first;
  assert.equal(h.bitmaps.length, 1);
  h.model.dispose();
});

test("stop terminates a loading worker immediately and rejects ready", async () => {
  const h = harness();
  const rejected = assert.rejects(h.model.ready, /disposed/);
  h.model.dispose();
  h.model.dispose();
  await rejected;
  assert.equal(h.worker.terminated, 1);
  h.worker.receive({ type: "ready" });
  await assert.rejects(h.model.detect({}), /disposed/);
});

test("a frame snapshot completed after stop is closed and never posted", async () => {
  let complete;
  const h = harness({
    createImageBitmap: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  h.worker.receive({ type: "ready" });
  await h.model.ready;
  const pending = h.model.detect({});
  const rejected = assert.rejects(pending, /disposed/);
  h.model.dispose();
  await rejected;
  const bitmap = {
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
  complete(bitmap);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(bitmap.closed, 1);
  assert.equal(h.worker.sent.length, 1);
});

test("worker load, message decoding and runtime errors are visible", async () => {
  for (const kind of ["onerror", "onmessageerror", "runtime"]) {
    const h = harness();
    const rejected = assert.rejects(h.model.ready, /worker|broken/i);
    if (kind === "runtime") h.worker.receive({ type: "error", message: "broken model" });
    else h.worker[kind]({ message: "worker unavailable", preventDefault() {} });
    await rejected;
    assert.equal(h.worker.terminated, 1);
  }
});

test("inference errors reject the pending frame and terminate the worker", async () => {
  const h = harness();
  h.worker.receive({ type: "ready" });
  await h.model.ready;
  const pending = h.model.detect({});
  await Promise.resolve();
  const rejected = assert.rejects(pending, /bad tensor/);
  h.worker.receive({ type: "error", id: 1, message: "bad tensor" });
  await rejected;
  assert.equal(h.worker.terminated, 1);
});

test("a failed snapshot closes no owned frame and can be retried", async () => {
  let attempt = 0;
  const h = harness({
    createImageBitmap: () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("no snapshot"))
        : Promise.resolve({ close() {} });
    },
  });
  h.worker.receive({ type: "ready" });
  await h.model.ready;
  await assert.rejects(h.model.detect({}), /no snapshot/);
  const pending = h.model.detect({});
  await Promise.resolve();
  const sent = h.worker.sent.at(-1).message;
  h.worker.receive({ type: "result", id: sent.id, hands: [] });
  await pending;
  h.model.dispose();
});

test("unsupported browsers fail explicitly without loading ml5 on the page", () => {
  assert.equal(supported({}), false);
  assert.throws(() => createModel({}, { platform: {} }), /Worker|OffscreenCanvas/);
});

test("a stalled worker load times out and terminates", async () => {
  const h = harness({ startupTimeoutMs: 5 });
  await assert.rejects(h.model.ready, /timed out/);
  assert.equal(h.worker.terminated, 1);
});

test("a stalled first inference times out without leaving a pending operation", async () => {
  const h = harness({ inferenceTimeoutMs: 5 });
  h.worker.receive({ type: "ready" });
  await h.model.ready;
  await assert.rejects(h.model.detect({}), /timed out/);
  assert.equal(h.worker.terminated, 1);
});
