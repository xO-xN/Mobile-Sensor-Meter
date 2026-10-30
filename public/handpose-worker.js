// Classic same-origin worker: importScripts executes the large shared ml5
// bundle here, so parsing, shader compilation and the first inference cannot
// stop the phone's orientation/motion/microphone callbacks or socket sends.
(function (scope, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createWorkerRuntime: factory };
  } else {
    factory(scope);
  }
})(typeof self !== "undefined" ? self : this, function createWorkerRuntime(scope) {
  let model = null;
  let canvas = null;
  let busy = false;
  let initializing = false;

  function localUrl(value) {
    if (typeof value !== "string" || !value)
      throw new Error("A local hand tracking asset URL is required");
    const url = new URL(value, scope.location.href);
    if (url.origin !== scope.location.origin)
      throw new Error("Hand tracking assets must be same-origin");
    return url.href;
  }

  function errorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  async function initialize(message) {
    if (initializing || model) throw new Error("Hand tracking worker has already initialized");
    const scriptSrc = localUrl(message.scriptSrc);
    const config = {
      ...message.config,
      runtime: "tfjs",
      detectorModelUrl: localUrl(message.config && message.config.detectorModelUrl),
      landmarkModelUrl: localUrl(message.config && message.config.landmarkModelUrl),
    };
    initializing = true;
    if (typeof scope.OffscreenCanvas !== "function")
      throw new Error("Hand tracking worker requires OffscreenCanvas");

    // ml5 1.4.0 bundles unused FaceMesh/D3 DOM feature detection, and its
    // canvas guard checks HTMLCanvasElement before checking OffscreenCanvas.
    // These two narrowly scoped adapters make its existing detect() API work
    // with real worker canvases. Keep window undefined so TFJS still detects
    // its native worker environment; no DOM or video objects cross threads.
    scope.document = {
      documentElement: {},
      createElement(type) {
        if (type === "canvas") return new scope.OffscreenCanvas(1, 1);
        throw new Error("Unsupported hand tracking worker element: " + type);
      },
    };
    scope.HTMLCanvasElement = scope.OffscreenCanvas;

    scope.postMessage({ type: "progress", phase: "loading-runtime" });
    scope.importScripts(scriptSrc);
    if (!scope.ml5 || typeof scope.ml5.handPose !== "function")
      throw new Error("ml5 HandPose runtime is unavailable");
    const tf = scope.ml5.tf;
    if (!tf || typeof tf.setBackend !== "function")
      throw new Error("TensorFlow runtime is unavailable");
    scope.postMessage({ type: "progress", phase: "loading-model" });
    try {
      if ((await tf.setBackend("webgl")) === false) throw new Error("WebGL backend unavailable");
      await tf.ready();
    } catch {
      if ((await tf.setBackend("cpu")) === false)
        throw new Error("Hand tracking worker backend unavailable");
      await tf.ready();
    }
    const handed = scope.ml5.handPose(config);
    const instance = handed && typeof handed.then === "function" ? await handed : handed;
    if (!instance || typeof instance.detect !== "function")
      throw new Error("ml5 HandPose returned no usable model");
    if (instance.ready && typeof instance.ready.then === "function") await instance.ready;
    model = instance;
    scope.postMessage({ type: "ready" });
  }

  async function infer(message) {
    const frame = message.frame;
    let owned = frame;
    let ownsBusy = false;
    try {
      if (!model) throw new Error("Hand tracking model is not ready");
      if (busy) throw new Error("Hand tracking inference is already in flight");
      busy = true;
      ownsBusy = true;
      if (
        !frame ||
        !Number.isInteger(frame.width) ||
        !Number.isInteger(frame.height) ||
        frame.width <= 0 ||
        frame.height <= 0
      ) {
        throw new Error("Hand tracking frame is invalid");
      }
      if (!canvas) canvas = new scope.OffscreenCanvas(frame.width, frame.height);
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Hand tracking frame context is unavailable");
      context.drawImage(frame, 0, 0);
      frame.close();
      owned = null;
      const hands = await model.detect(canvas);
      scope.postMessage({ type: "result", id: message.id, hands });
    } finally {
      if (owned && typeof owned.close === "function") owned.close();
      // A rejected duplicate never owns the current inference's busy flag.
      if (ownsBusy) busy = false;
    }
  }

  async function handleMessage(message) {
    if (!message || (message.type !== "init" && message.type !== "detect")) return;
    try {
      if (message.type === "init") await initialize(message);
      else await infer(message);
    } catch (error) {
      scope.postMessage({
        type: "error",
        ...(message.type === "detect" ? { id: message.id } : {}),
        message: errorMessage(error),
      });
    }
  }

  scope.onmessage = (event) => {
    void handleMessage(event.data);
  };
  return { handleMessage };
});
