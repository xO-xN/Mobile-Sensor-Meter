// The page never executes ml5: its script, model initialization and every
// inference live in one dedicated worker. A single transferred snapshot is
// in flight; a slow model cannot build a frame queue or delay other sensors.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.HandPoseWorkerClient = factory(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  function supported(platform = root) {
    return (
      typeof platform.Worker === "function" &&
      typeof platform.OffscreenCanvas === "function" &&
      typeof platform.createImageBitmap === "function"
    );
  }

  function createModel(config, options = {}) {
    const platform = options.platform || root;
    if (!supported(platform)) {
      throw new Error(
        "Hand tracking requires Worker, OffscreenCanvas and createImageBitmap support",
      );
    }
    const worker = new platform.Worker(options.workerUrl || "/handpose-worker.js");
    let ended = null;
    let initialized = false;
    let sequence = 0;
    let pending = null;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let startupTimer = platform.setTimeout(
      () => fail(new Error("Hand tracking worker initialization timed out")),
      options.startupTimeoutMs ?? 60000,
    );

    function finishPending(error, hands) {
      if (!pending) return;
      const operation = pending;
      pending = null;
      platform.clearTimeout(operation.timer);
      if (error) operation.reject(error);
      else operation.resolve(hands);
    }

    function fail(error) {
      if (ended) return;
      ended = error;
      platform.clearTimeout(startupTimer);
      startupTimer = null;
      worker.terminate();
      rejectReady(error);
      finishPending(error);
    }

    worker.onmessage = (event) => {
      if (ended || !event.data) return;
      const message = event.data;
      switch (message.type) {
        case "progress":
          if (
            typeof options.onProgress === "function" &&
            (message.phase === "loading-runtime" || message.phase === "loading-model")
          )
            options.onProgress(message.phase);
          break;
        case "ready":
          initialized = true;
          platform.clearTimeout(startupTimer);
          startupTimer = null;
          resolveReady();
          break;
        case "result":
          if (pending && message.id === pending.id) finishPending(null, message.hands);
          break;
        case "error":
          fail(new Error(message.message || "Hand tracking worker failed"));
          break;
      }
    };
    worker.onerror = (event) => {
      if (typeof event.preventDefault === "function") event.preventDefault();
      fail(new Error(event.message || "Hand tracking worker could not start"));
    };
    worker.onmessageerror = () =>
      fail(new Error("Hand tracking worker message could not be decoded"));

    try {
      worker.postMessage({
        type: "init",
        scriptSrc: options.scriptSrc || "/__pnds/shared/ml5.js",
        config,
      });
    } catch (error) {
      fail(error);
    }

    return {
      ready,
      detect(canvas) {
        if (ended) return Promise.reject(ended);
        if (!initialized) return Promise.reject(new Error("Hand tracking model is not ready"));
        if (pending)
          return Promise.reject(new Error("Hand tracking inference is already in flight"));
        sequence += 1;
        const id = sequence;
        const result = new Promise((resolve, reject) => {
          pending = {
            id,
            resolve,
            reject,
            timer: platform.setTimeout(
              () => fail(new Error("Hand tracking inference timed out")),
              options.inferenceTimeoutMs ?? 30000,
            ),
          };
        });

        let snapshot;
        try {
          snapshot = platform.createImageBitmap(canvas);
        } catch (error) {
          finishPending(error);
          return result;
        }
        Promise.resolve(snapshot).then(
          (bitmap) => {
            // Stop may run while the browser is copying pixels. That bitmap
            // belongs to this operation until a successful transfer; close it
            // rather than sending it to an already terminated worker.
            if (ended || !pending || pending.id !== id) {
              bitmap.close();
              return;
            }
            try {
              worker.postMessage({ type: "detect", id, frame: bitmap }, [bitmap]);
            } catch (error) {
              bitmap.close();
              fail(error);
            }
          },
          (error) => {
            if (pending && pending.id === id) finishPending(error);
          },
        );
        return result;
      },
      dispose() {
        fail(new Error("Hand tracking worker disposed"));
      },
    };
  }

  return { supported, createModel };
});
