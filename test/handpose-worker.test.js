const assert = require("node:assert/strict");
const test = require("node:test");
const { createWorkerRuntime } = require("../public/handpose-worker");

function harness(options = {}) {
  const events = [];
  const calls = [];
  class OffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext(type) {
      assert.equal(type, "2d");
      return {
        drawImage(frame) {
          calls.push(["draw", frame]);
        },
      };
    }
  }
  const scope = {
    location: {
      href: "https://sensor.test/handpose-worker.js",
      origin: "https://sensor.test",
    },
    OffscreenCanvas,
    postMessage: (data) => events.push(data),
    importScripts(src) {
      calls.push(["import", src]);
    },
    ml5: {
      tf: {
        setBackend: async (name) => {
          calls.push(["backend", name]);
          return options.webgl === false ? name === "cpu" : true;
        },
        ready: async () => {},
      },
      handPose:
        options.handPose ||
        (async (config) => {
          calls.push(["model", config]);
          return {
            detect: async (canvas) => {
              calls.push(["detect", canvas.width, canvas.height]);
              return [];
            },
          };
        }),
    },
  };
  const runtime = createWorkerRuntime(scope);
  return { events, calls, scope, runtime };
}
const INIT = {
  type: "init",
  scriptSrc: "/__pnds/shared/ml5.js",
  config: {
    maxHands: 1,
    runtime: "tfjs",
    modelType: "lite",
    detectorModelUrl: "/detector.json",
    landmarkModelUrl: "/landmark.json",
  },
};

test("runtime imports fixed same-origin ml5, selects backend and loads local models", async () => {
  const h = harness();
  await h.runtime.handleMessage(INIT);
  assert.deepEqual(
    h.events.map((event) => (event.type === "progress" ? event.phase : event.type)),
    ["loading-runtime", "loading-model", "ready"],
  );
  assert.deepEqual(h.calls[0], ["import", "https://sensor.test/__pnds/shared/ml5.js"]);
  assert.deepEqual(h.calls[1], ["backend", "webgl"]);
  assert.equal(h.calls[2][1].detectorModelUrl, "https://sensor.test/detector.json");
  assert.equal(h.scope.HTMLCanvasElement, h.scope.OffscreenCanvas);
  assert.ok(h.scope.document.createElement("canvas") instanceof h.scope.OffscreenCanvas);
});

test("CPU fallback stays inside the worker", async () => {
  const h = harness({ webgl: false });
  await h.runtime.handleMessage(INIT);
  assert.deepEqual(
    h.calls.filter((call) => call[0] === "backend"),
    [
      ["backend", "webgl"],
      ["backend", "cpu"],
    ],
  );
  assert.equal(h.events.at(-1).type, "ready");
});

test("bitmap pixels are drawn to OffscreenCanvas, closed, and only hands are returned", async () => {
  const h = harness();
  await h.runtime.handleMessage(INIT);
  const frame = {
    width: 640,
    height: 480,
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
  await h.runtime.handleMessage({ type: "detect", id: 7, frame });
  assert.equal(frame.closed, 1);
  assert.deepEqual(h.calls.at(-1), ["detect", 640, 480]);
  assert.deepEqual(h.events.at(-1), { type: "result", id: 7, hands: [] });
});

test("a failed inference closes its input and reports the error", async () => {
  const h = harness({
    handPose: async () => ({
      detect: async () => {
        throw new Error("bad model output");
      },
    }),
  });
  await h.runtime.handleMessage(INIT);
  const frame = {
    width: 2,
    height: 2,
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
  await h.runtime.handleMessage({ type: "detect", id: 2, frame });
  assert.equal(frame.closed, 1);
  assert.deepEqual(h.events.at(-1), {
    type: "error",
    id: 2,
    message: "bad model output",
  });
});

test("missing/remote assets fail before executing or fetching any library", async () => {
  for (const change of [
    { scriptSrc: "https://cdn.test/ml5.js" },
    {
      config: {
        ...INIT.config,
        landmarkModelUrl: "https://cdn.test/model.json",
      },
    },
    { config: { ...INIT.config, detectorModelUrl: undefined } },
  ]) {
    const h = harness();
    await h.runtime.handleMessage({ ...INIT, ...change });
    assert.equal(h.calls.length, 0);
    assert.equal(h.events.at(-1).type, "error");
  }
});

test("unready and duplicate concurrent inference requests close their frames", async () => {
  let finish;
  const h = harness({
    handPose: async () => ({
      detect: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }),
  });
  const early = {
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
  await h.runtime.handleMessage({ type: "detect", id: 1, frame: early });
  assert.equal(early.closed, 1);
  await h.runtime.handleMessage(INIT);
  const first = { width: 1, height: 1, close() {} };
  const pending = h.runtime.handleMessage({
    type: "detect",
    id: 2,
    frame: first,
  });
  const duplicate = {
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
  await h.runtime.handleMessage({ type: "detect", id: 3, frame: duplicate });
  assert.equal(duplicate.closed, 1);
  assert.match(h.events.at(-1).message, /in flight/);
  finish([]);
  await pending;
});

test("an invalid frame releases busy ownership so the next frame can run", async () => {
  const h = harness();
  await h.runtime.handleMessage(INIT);
  const invalid = {
    width: 0,
    height: 2,
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
  await h.runtime.handleMessage({ type: "detect", id: 1, frame: invalid });
  assert.equal(invalid.closed, 1);
  assert.match(h.events.at(-1).message, /invalid/);
  const valid = { width: 2, height: 2, close() {} };
  await h.runtime.handleMessage({ type: "detect", id: 2, frame: valid });
  assert.deepEqual(h.events.at(-1), { type: "result", id: 2, hands: [] });
});
