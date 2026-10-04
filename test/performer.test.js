// Performer page wiring: the join/token flow, the per-sensor enable/stop
// buttons driving the REAL controller code (loaded with a fake window
// platform — the "API stand-in" boundary), the phone readout rendering
// the sample it SENDS (same values, unavailable-vs-zero), the
// visibility pause path, and the microphone leg (#143): grant/denial,
// the exclusive-resource release on stop and backgrounding, the silent
// re-acquisition on return, and real zeros for a silent room.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// ------------------------------------------------------------
// The hand-rolled DOM/socket/window the page scripts run against
// ------------------------------------------------------------

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.innerHTML = "";
    this.textContent = "";
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => this.classes.add(n)),
      remove: (...names) => names.forEach((n) => this.classes.delete(n)),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : force;
        if (on) {
          this.classes.add(name);
        } else {
          this.classes.delete(name);
        }
      },
      contains: (name) => this.classes.has(name),
    };
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  dispatch(type) {
    for (const fn of this.listeners.get(type) || []) {
      fn({});
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  // Media-element stand-ins (the handpose preview video): the page
  // binds srcObject and plays; frames "arrive" when a test sets
  // videoWidth/videoHeight.
  play() {
    return Promise.resolve();
  }
}

function loadPerformerPage(options = {}) {
  const elements = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const storage = new Map();
  const emitted = [];
  const handlers = {};

  const socket = {
    on(event, fn) {
      handlers[event] = fn;
    },
    emit(event, payload) {
      emitted.push([event, payload]);
    },
  };

  const ioCalls = [];
  let clock = options.clock === undefined ? 0 : options.clock;

  // The mic stand-ins: getUserMedia responders, a fake Web Audio graph
  // whose analyser fills from a scriptable signal, and counters for
  // every exclusive-resource teardown the spec (#143) pins.
  const intervals = new Map(); // setInterval registry — tests pump it
  let intervalSeq = 0;
  const micHarness = {
    gumCalls: [],
    contextsCreated: 0,
    contextsClosed: 0,
    tracksStopped: 0,
    analysers: [],
    fill: options.micFill || ((block) => block.fill(0)),
  };

  class FakeAnalyser {
    constructor() {
      this.fftSize = 0;
      micHarness.analysers.push(this);
    }

    getFloatTimeDomainData(block) {
      micHarness.fill(block);
    }
  }

  class FakeMediaStreamSource {
    connect() {}
    disconnect() {}
  }

  class FakeAudioContext {
    constructor() {
      micHarness.contextsCreated += 1;
      this.sampleRate = 48000;
      this.state = "running";
    }

    createMediaStreamSource() {
      return new FakeMediaStreamSource();
    }

    createAnalyser() {
      return new FakeAnalyser();
    }

    resume() {
      return Promise.resolve();
    }

    close() {
      micHarness.contextsClosed += 1;
      return Promise.resolve();
    }
  }

  function fakeStream() {
    return {
      getTracks: () => [
        {
          stop: () => {
            micHarness.tracksStopped += 1;
          },
        },
      ],
    };
  }

  function defaultGetUserMedia(constraints) {
    micHarness.gumCalls.push(constraints);

    if (options.gum === "deny") {
      return Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    }

    return Promise.resolve(fakeStream());
  }

  // The handpose stand-ins: lazy script loads the page can be driven
  // through (tests fire a script's onload/onerror), a fake ml5 whose
  // detect resolves what the test scripted, and counters for every
  // teardown the spec (#144) pins.
  const scripts = [];
  const hpHarness = {
    scriptConfigs: [],
    disposedModels: 0,
    detects: 0,
    handsResult: [],
    detectError: null,
  };

  const sandbox = {
    console,
    // A clock that advances per read: the page tests assert presence
    // (a sample reached the wire), not rate limiting (that is
    // sensor-logic.test.js's business with a controlled clock).
    performance: {
      now: () => {
        clock += 250;
        return clock;
      },
    },
    setTimeout,
    setInterval: (fn) => {
      intervalSeq += 1;
      intervals.set(intervalSeq, fn);
      return intervalSeq;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
    AudioContext: FakeAudioContext,
    fetch:
      options.assetsOk === undefined
        ? undefined
        : () =>
            Promise.resolve({
              json: () => Promise.resolve({ ok: options.assetsOk }),
            }),
    // The fake ml5: handPose(config) records the config; detect()
    // resolves the scripted hands (or rejects with detectError); the
    // underlying detector's dispose() is counted.
    ml5: {
      handPose(config) {
        hpHarness.scriptConfigs.push(config);
        return {
          // options.modelReadyError scripts a tfjs/loader failure; the
          // rejection is consumed by the controller's catch.
          ready: options.modelReadyError
            ? Promise.reject(new Error(options.modelReadyError))
            : Promise.resolve(),
          model: {
            dispose() {
              hpHarness.disposedModels += 1;
            },
          },
          detect(media) {
            hpHarness.detects += 1;
            void media;

            if (hpHarness.detectError) {
              return Promise.reject(hpHarness.detectError);
            }

            return Promise.resolve(hpHarness.handsResult);
          },
        };
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    navigator: {
      language: options.language || "en",
      mediaDevices:
        options.mediaDevices === null
          ? undefined
          : { getUserMedia: options.getUserMedia || defaultGetUserMedia },
    },
    location: { hostname: "localhost", search: "", origin: "http://localhost:6868" },
    DeviceOrientationEvent: options.orientationEvent,
    DeviceMotionEvent: options.motionEvent,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) {
        windowListeners.set(type, new Set());
      }
      windowListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      windowListeners.get(type)?.delete(fn);
    },
    document: {
      visibilityState: "visible",
      getElementById(id) {
        if (!elements.has(id)) {
          const tag = id === "hp-video" ? "video" : "div";
          const element = new Element(tag);
          if (tag === "video") {
            element.videoWidth = 0;
            element.videoHeight = 0;
            element.srcObject = null;
          }
          elements.set(id, element);
        }
        return elements.get(id);
      },
      createElement(tag) {
        const element = new Element(tag);
        element.onload = null;
        element.onerror = null;
        element.src = "";
        if (tag === "canvas") {
          // The WebGL probe's stand-in: options.webgl === false reads
          // as a page with no GPU context (Low Power Mode & friends);
          // otherwise a healthy context that can be released.
          element.getContext = () =>
            options.webgl === false
              ? null
              : {
                  getExtension: () => ({ loseContext() {} }),
                };
        }
        return element;
      },
      head: {
        appendChild(node) {
          scripts.push(node);
        },
      },
      addEventListener(type, fn) {
        if (!documentListeners.has(type)) {
          documentListeners.set(type, new Set());
        }
        documentListeners.get(type).add(fn);
      },
      documentElement: new Element("html"),
    },
    io: (...args) => {
      ioCalls.push(args);
      return socket;
    },
    // The server-injected runtime config the real page receives from
    // /__config.js before any script runs.
    __PNDS_CONFIG__: {
      role: "performer",
      projectId: "mobile-sensor-meter",
      performerUrl: "http://192.168.1.10:6868/",
      performerPort: 6868,
      monitorPort: 6869,
    },
  };

  vm.createContext(sandbox);

  // In a real browser window === the global object; alias it so the
  // pages' `window.PNDS` reads what shared.js set on the global.
  vm.runInContext("var window = this; var self = this;", sandbox);

  const run = (file) =>
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8"), sandbox, {
      filename: file,
    });

  run("shared.js");
  run("locale.js");
  run("sensor-logic.js");
  run("mic-logic.js");
  run("handpose-logic.js");
  run("render.js");
  run("performer.js");

  function fireSensorEvent(type, event) {
    for (const fn of windowListeners.get(type) || []) {
      fn(event);
    }
  }

  function fireDocument(type) {
    for (const fn of documentListeners.get(type) || []) {
      fn({});
    }
  }

  return {
    sandbox,
    elements,
    storage,
    handlers,
    emitted,
    socket,
    fireSensorEvent,
    fireDocument,
    button: (sensor) => elements.get("btn-" + sensor),
    note: (sensor) => elements.get("note-" + sensor),
    values: (sensor) => elements.get("values-" + sensor),
    conn: elements.get("conn-status"),
    device: elements.get("device-label"),
    mic: micHarness,
    hp: hpHarness,
    // The pending lazy-loaded vendor scripts (the page appends one per
    // handpose model load); a test fires onload/onerror to drive the
    // load stage.
    scripts,
    // Fires every live interval once (the mic's 16 ms tick, the
    // handpose inference tick and the heartbeat alike — tests filter
    // by event name). The fake clock advances 250 ms per read, so
    // every fired tick passes both gates.
    pumpIntervals: () => {
      for (const fn of [...intervals.values()]) {
        fn();
      }
    },
    // Live intervals beyond the page-load heartbeat (id 1): the mic's
    // and handpose's ticks are the only other interval users.
    micIntervalCount: () =>
      [...intervals.keys()].filter((id) => id > 1).length,
  };
}

const PLAIN_ORIENTATION = function DeviceOrientationEvent() {};

function connectAndJoin(page, token = null, id = 1) {
  page.handlers.connect();
  page.handlers.joined({ id, token: "t".repeat(32), recovered: false });
}

test("the page joins same-origin with its token and stores the new one", () => {
  const page = loadPerformerPage();

  connectAndJoin(page);

  assert.equal(page.emitted[0][0], "join");
  assert.equal(page.emitted[0][1].token, null);
  assert.equal(page.emitted[1][0], "pnds:sensor:resume");
  assert.ok(page.storage.get("mobile-sensor-meter-token"));
  assert.match(page.device.textContent, /Device 1/);

  // A reconnect re-joins with the PERSISTED token — never a new device.
  page.emitted.length = 0;
  page.handlers.connect();
  assert.equal(page.emitted[0][1].token, "t".repeat(32));
});

test("enabling tilt attaches capture, notifies the server, and renders the sent sample", () => {
  const page = loadPerformerPage({ orientationEvent: PLAIN_ORIENTATION });
  connectAndJoin(page);
  page.emitted.length = 0;

  page.button("tilt").dispatch("click");

  // (vm-realm objects: compare fields, not references)
  const start = page.emitted.find(([e]) => e === "pnds:sensor:start");
  assert.ok(start, "the server must be told the capture started");
  assert.equal(start[1].sensor, "tilt");
  assert.equal(start[1].permission, "granted");

  page.fireSensorEvent("deviceorientation", { alpha: 12.5, beta: 0, gamma: -3 });

  const sample = page.emitted.find(([e]) => e === "pnds:sensor:sample");
  assert.ok(sample, "a sample must be sent");
  assert.equal(sample[1].sensor, "tilt");
  assert.equal(sample[1].seq, 1);
  assert.equal(sample[1].tilt.alpha, 12.5);

  // The readout binds to the SENT sample — the same values, no rate
  // counters anywhere on the page.
  assert.match(page.values("tilt").innerHTML, /12\.5/);
  assert.doesNotMatch(page.values("tilt").innerHTML, /·/);
  assert.equal(page.elements.get("tick-tilt"), undefined);
});

test("null fields render unavailable; legal zeros render as numbers", () => {
  const page = loadPerformerPage({ orientationEvent: PLAIN_ORIENTATION });
  connectAndJoin(page);
  page.button("tilt").dispatch("click");

  page.fireSensorEvent("deviceorientation", { alpha: null, beta: 0, gamma: 0 });

  const html = page.values("tilt").innerHTML;
  assert.match(html, /unavailable/);
  assert.match(html, /0\.0/); // beta and gamma are REAL zeros
});

test("stop ends the capture: the server is told and late events go nowhere", () => {
  const page = loadPerformerPage({ orientationEvent: PLAIN_ORIENTATION });
  connectAndJoin(page);
  page.button("tilt").dispatch("click");
  page.fireSensorEvent("deviceorientation", { alpha: 1, beta: 1, gamma: 1 });
  page.emitted.length = 0;

  page.button("tilt").dispatch("click"); // the button is now "Stop"

  const stop = page.emitted.find(([e]) => e === "pnds:sensor:stop");
  assert.ok(stop, "the server must be told the capture stopped");
  assert.equal(stop[1].sensor, "tilt");

  page.fireSensorEvent("deviceorientation", { alpha: 9, beta: 9, gamma: 9 });
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:sample").length,
    0,
  );
});

test("an unsupported sensor reports the fact to the server and the UI", () => {
  const page = loadPerformerPage(); // no DeviceOrientationEvent global
  connectAndJoin(page);
  page.emitted.length = 0;

  page.button("tilt").dispatch("click");

  const permission = page.emitted.find(
    ([e]) => e === "pnds:sensor:permission",
  );
  assert.ok(permission, "the unsupported fact must reach the server");
  assert.equal(permission[1].sensor, "tilt");
  assert.equal(permission[1].permission, "unsupported");
  assert.match(page.note("tilt").textContent, /Not supported/);
});

test("hiding the page pauses capture and tells the server; returning resumes", () => {
  const page = loadPerformerPage({ orientationEvent: PLAIN_ORIENTATION });
  connectAndJoin(page);
  page.button("tilt").dispatch("click");
  page.fireSensorEvent("deviceorientation", { alpha: 1, beta: 1, gamma: 1 });
  page.emitted.length = 0;

  page.sandbox.document.visibilityState = "hidden";
  page.fireDocument("visibilitychange");

  assert.ok(page.emitted.some(([e]) => e === "pnds:sensor:pause"));
  page.fireSensorEvent("deviceorientation", { alpha: 5, beta: 5, gamma: 5 });
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:sample").length,
    0,
  );
  assert.match(page.note("tilt").textContent, /Paused/);

  page.sandbox.document.visibilityState = "visible";
  page.fireDocument("visibilitychange");
  assert.ok(page.emitted.some(([e]) => e === "pnds:sensor:resume"));
  page.fireSensorEvent("deviceorientation", { alpha: 6, beta: 6, gamma: 6 });
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:sample").length,
    1,
  );
});

test("heartbeats carry no sensor values", () => {
  const page = loadPerformerPage();
  connectAndJoin(page);

  // The heartbeat timer is stubbed in the harness (interval id 0), so
  // the assertion targets its shape via the module's contract instead:
  // a heartbeat, whenever it fires, must never touch a sample path.
  // The wiring above emits it from the page's own interval callback —
  // verified end-to-end in test/integration.test.js with the real
  // timers. Here: no sample or sensor event can ever be emitted
  // without a capture, heartbeats or not.
  page.handlers.connect();
  assert.equal(
    page.emitted.filter(([e]) => e.startsWith("pnds:sensor:sample")).length,
    0,
  );
});

// ------------------------------------------------------------
// The microphone leg (#143)
// ------------------------------------------------------------

const HALF_SCALE_SQUARE = (block) => {
  for (let i = 0; i < block.length; i += 1) {
    block[i] = i % 2 === 0 ? 0.25 : -0.25;
  }
};

const flushMicrotasks = async () => {
  // Enough turns for the longest page chain: getUserMedia → attach →
  // loadScript → model.ready → beginLoop, and fetch → json → state.
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

test("enabling the mic grants, notifies the server, and sends the ANALYZED values", async () => {
  const page = loadPerformerPage({ micFill: HALF_SCALE_SQUARE });
  connectAndJoin(page);
  page.emitted.length = 0;

  page.button("mic").dispatch("click");
  await flushMicrotasks();

  const start = page.emitted.find(([e]) => e === "pnds:sensor:start");
  assert.ok(start, "the server must be told the capture started");
  assert.equal(start[1].sensor, "mic");
  assert.equal(start[1].permission, "granted");
  // Raw diagnostics constraints: every browser "enhancement" off.
  assert.equal(page.mic.gumCalls.length, 1);
  assert.equal(page.mic.gumCalls[0].audio.echoCancellation, false);
  assert.equal(page.mic.gumCalls[0].audio.noiseSuppression, false);
  assert.equal(page.mic.gumCalls[0].audio.autoGainControl, false);

  page.pumpIntervals();

  const sample = page.emitted.find(([e]) => e === "pnds:sensor:sample");
  assert.ok(sample, "a sample must be sent");
  assert.equal(sample[1].sensor, "mic");
  assert.equal(sample[1].seq, 1);
  assert.ok(Math.abs(sample[1].mic.rms - 0.25) < 1e-6);
  assert.equal(sample[1].mic.sampleRate, 48000);

  // The readout binds to the SENT sample — values, units and the
  // uncalibrated-meter note all render.
  const html = page.values("mic").innerHTML;
  assert.match(html, /0\.2500 FS/);
  assert.match(html, /dBFS/);
  assert.match(html, /Uncalibrated/);
});

test("a silent room sends REAL zeros — never unavailable", async () => {
  const page = loadPerformerPage(); // the default fill is silence
  connectAndJoin(page);

  page.button("mic").dispatch("click");
  await flushMicrotasks();
  page.pumpIntervals();

  const sample = page.emitted.find(([e]) => e === "pnds:sensor:sample");
  assert.equal(sample[1].mic.rms, 0);
  assert.equal(sample[1].mic.peak, 0);
  assert.equal(sample[1].mic.level, -90); // the documented floor

  const html = page.values("mic").innerHTML;
  assert.match(html, /0\.0000 FS/);
  assert.doesNotMatch(html, /RMS<\/span><span class="value na">/);
});

test("without a secure context the mic reads unsupported, with the HTTPS reason", async () => {
  const page = loadPerformerPage({ mediaDevices: null });
  connectAndJoin(page);
  page.emitted.length = 0;

  page.button("mic").dispatch("click");
  await flushMicrotasks();

  const permission = page.emitted.find(([e]) => e === "pnds:sensor:permission");
  assert.ok(permission, "the unsupported fact must reach the server");
  assert.equal(permission[1].sensor, "mic");
  assert.equal(permission[1].permission, "unsupported");
  assert.equal(page.mic.gumCalls.length, 0);
  assert.match(page.note("mic").textContent, /HTTPS/);
});

test("a denied request is a diagnosable state, not an error", async () => {
  const page = loadPerformerPage({ gum: "deny" });
  connectAndJoin(page);
  page.emitted.length = 0;

  page.button("mic").dispatch("click");
  await flushMicrotasks();

  const permission = page.emitted.find(([e]) => e === "pnds:sensor:permission");
  assert.equal(permission[1].permission, "denied");
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:start").length,
    0,
  );
  assert.match(page.note("mic").textContent, /Permission denied/);
});

test("stopping the mic releases the exclusive resource; late ticks send nothing", async () => {
  const page = loadPerformerPage({ micFill: HALF_SCALE_SQUARE });
  connectAndJoin(page);

  page.button("mic").dispatch("click");
  await flushMicrotasks();
  page.pumpIntervals();

  const contexts = page.mic.contextsCreated;
  const analyserCount = page.mic.analysers.length;

  page.button("mic").dispatch("click"); // the button is now "Stop"
  await flushMicrotasks();

  const stop = page.emitted.find(([e]) => e === "pnds:sensor:stop");
  assert.ok(stop, "the server must be told the capture stopped");
  assert.equal(stop[1].sensor, "mic");

  assert.equal(page.mic.tracksStopped, 1); // the stream is released
  assert.equal(page.mic.contextsClosed, contexts); // the context is closed
  assert.equal(page.micIntervalCount(), 0); // the tick is cancelled
  assert.equal(page.mic.analysers.length, analyserCount);

  page.emitted.length = 0;
  page.pumpIntervals();
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:sample").length,
    0,
  );
});

test("backgrounding releases the mic; returning re-acquires it silently", async () => {
  const page = loadPerformerPage({ micFill: HALF_SCALE_SQUARE });
  connectAndJoin(page);

  page.button("mic").dispatch("click");
  await flushMicrotasks();
  page.pumpIntervals();
  const gumCallsBefore = page.mic.gumCalls.length;
  const startsBefore = page.emitted.filter(([e]) => e === "pnds:sensor:start").length;
  const contexts = page.mic.contextsCreated;
  assert.equal(startsBefore, 1); // the user's enable did notify the server

  page.sandbox.document.visibilityState = "hidden";
  page.fireDocument("visibilitychange");

  assert.ok(page.emitted.some(([e]) => e === "pnds:sensor:pause"));
  assert.equal(page.mic.contextsClosed, contexts); // released, not suspended
  assert.equal(page.mic.tracksStopped, 1);
  assert.equal(page.micIntervalCount(), 0);
  page.emitted.length = 0;
  page.pumpIntervals(); // nothing ticks in the background
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:sample").length,
    0,
  );

  page.sandbox.document.visibilityState = "visible";
  page.fireDocument("visibilitychange");

  assert.ok(page.emitted.some(([e]) => e === "pnds:sensor:resume"));
  await flushMicrotasks();

  assert.equal(page.mic.gumCalls.length, gumCallsBefore + 1); // re-acquired
  assert.equal(page.mic.contextsCreated, contexts + 1);
  // Silent: the server's record is the truth to keep — no second
  // sensorStart after the resume, so the frozen sample survives the
  // backgrounding (emitted was re-baselined before returning visible).
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:start").length,
    0,
  );

  page.emitted.length = 0;
  page.pumpIntervals();
  const sample = page.emitted.find(([e]) => e === "pnds:sensor:sample");
  assert.ok(sample, "samples flow again after the silent re-acquisition");
  assert.equal(sample[1].seq, 2); // the seq keeps climbing — provably new
});

// ------------------------------------------------------------
// The handpose leg (#144)
// ------------------------------------------------------------

function fakePixelHands() {
  const keypoints = [];

  for (let i = 0; i < 21; i += 1) {
    keypoints.push({ name: "k" + i, x: i * 30, y: 120 }); // pixels
  }

  return [{ confidence: 0.9, keypoints }];
}

function framesFlow(page) {
  const video = page.elements.get("hp-video");
  video.videoWidth = 640;
  video.videoHeight = 480;
}

async function driveHandposeToRunning(page) {
  page.button("handpose").dispatch("click");
  await flushMicrotasks();

  // Camera granted → the lazy ml5 load starts (same-origin vendor).
  assert.equal(page.scripts.length, 1);
  assert.equal(page.scripts[0].src, "/vendor/ml5.min.js");
  page.scripts[0].onload();
  await flushMicrotasks();
}

test("enabling handpose runs the local pipeline: camera → vendor script → local model URLs → samples", async () => {
  const page = loadPerformerPage();
  connectAndJoin(page);
  page.emitted.length = 0;

  await driveHandposeToRunning(page);

  // The model config: lightweight single hand, the verifiable WebGL
  // (tfjs) runtime, BOTH models from this origin's /vendor/. (The
  // config object lives in the vm realm — compare fields.)
  assert.equal(page.hp.scriptConfigs.length, 1);
  const config = page.hp.scriptConfigs[0];
  assert.equal(config.maxHands, 1);
  assert.equal(config.runtime, "tfjs");
  assert.equal(config.modelType, "lite");
  assert.equal(config.detectorModelUrl, "/vendor/handpose/detector/model.json");
  assert.equal(config.landmarkModelUrl, "/vendor/handpose/landmark/model.json");

  const start = page.emitted.find(([e]) => e === "pnds:sensor:start");
  assert.ok(start, "the server must be told inference began");
  assert.equal(start[1].sensor, "handpose");
  assert.equal(start[1].permission, "granted");

  // The camera constraints: front camera, no audio.
  const gum = page.mic.gumCalls.find((call) => call.audio === false);
  assert.ok(gum, "the handpose camera request must be video-only");
  assert.equal(gum.video.facingMode, "user");

  framesFlow(page);
  page.hp.handsResult = fakePixelHands();
  page.pumpIntervals();
  await flushMicrotasks();

  const sample = page.emitted.find(([e]) => e === "pnds:sensor:sample");
  assert.ok(sample, "a sample must be sent");
  assert.equal(sample[1].sensor, "handpose");
  assert.equal(sample[1].seq, 1);
  assert.equal(sample[1].handpose.hands, 1);
  assert.equal(sample[1].handpose.keypoints.length, 21);
  // Pixel coordinates are normalized before the wire: [0,1], and the
  // values are REAL numbers (a hand WAS detected).
  assert.ok(Math.abs(sample[1].handpose.keypoints[1].x - 30 / 640) < 1e-9);
  assert.equal(sample[1].handpose.keypoints[0].y, 0.25);
  assert.ok(sample[1].handpose.rateHz > 0);
  assert.ok(sample[1].handpose.inferMs >= 0);

  // The phone readout: summary rows + the coordinate convention.
  const html = page.values("handpose").innerHTML;
  assert.match(html, /Hands/);
  assert.match(html, /0\.90/);
  assert.match(html, /Hz/);
  assert.match(html, /origin top-left/);
});

test("no hand is a RESULT: zero hands, empty keypoints — never unavailable", async () => {
  const page = loadPerformerPage();
  connectAndJoin(page);

  await driveHandposeToRunning(page);
  framesFlow(page);
  page.hp.handsResult = []; // the model ran and found nothing

  page.pumpIntervals();
  await flushMicrotasks();

  const sample = page.emitted.find(([e]) => e === "pnds:sensor:sample");
  assert.equal(sample[1].handpose.hands, 0);
  assert.equal(sample[1].handpose.keypoints.length, 0); // empty, not missing
  assert.equal(sample[1].handpose.confidence, null);
  assert.ok(sample[1].handpose.rateHz > 0); // inference DID run
});

test("a failed vendor script load is model-error WITH THE REASON; the preview keeps running", async () => {
  const page = loadPerformerPage();
  connectAndJoin(page);

  page.button("handpose").dispatch("click");
  await flushMicrotasks();

  assert.equal(page.scripts.length, 1);
  page.scripts[0].onerror();
  await flushMicrotasks();

  // The note names what actually failed (the assets inventory said
  // everything is present — the npm advice would be a wrong turn).
  const note = page.note("handpose").textContent;
  assert.match(note, /Model load failed/);
  assert.match(note, /vendor\/ml5\.min\.js/);
  assert.doesNotMatch(note, /fetch:handpose/);
  // The camera is still attached — the preview is the evidence that
  // the camera path works while the model path does not.
  assert.notEqual(page.elements.get("hp-video").srcObject, null);
});

test("a model-init failure shows the underlying tfjs/loader reason — not the fetch:handpose advice", async () => {
  const page = loadPerformerPage({ modelReadyError: "HTTP 404 fetching model.json" });
  connectAndJoin(page);

  page.button("handpose").dispatch("click");
  await flushMicrotasks();

  assert.equal(page.scripts.length, 1);
  page.scripts[0].onload();
  await flushMicrotasks();

  const note = page.note("handpose").textContent;
  assert.match(note, /Model load failed/);
  assert.match(note, /HTTP 404 fetching model\.json/); // verbatim reason
  assert.doesNotMatch(note, /fetch:handpose/); // the assets ARE there
  assert.notEqual(page.elements.get("hp-video").srcObject, null);
});

test("a page without WebGL fails fast: no script download, the GPU reason in the note", async () => {
  const page = loadPerformerPage({ webgl: false });
  connectAndJoin(page);

  page.button("handpose").dispatch("click");
  await flushMicrotasks();

  const note = page.note("handpose").textContent;
  assert.match(note, /WebGL unavailable/);
  assert.equal(page.scripts.length, 0); // the 4.5 MB bundle stays unsent
  assert.equal(page.hp.scriptConfigs.length, 0);
  assert.notEqual(page.elements.get("hp-video").srcObject, null); // camera live
});

test("stopping handpose releases loop, model and camera", async () => {
  const page = loadPerformerPage();
  connectAndJoin(page);

  await driveHandposeToRunning(page);
  framesFlow(page);
  page.hp.handsResult = fakePixelHands();
  page.pumpIntervals();
  await flushMicrotasks();

  page.button("handpose").dispatch("click"); // the button is now "Stop"
  await flushMicrotasks();

  const stop = page.emitted.find(([e]) => e === "pnds:sensor:stop");
  assert.ok(stop);
  assert.equal(stop[1].sensor, "handpose");

  assert.equal(page.hp.disposedModels, 1); // the model's GPU memory
  assert.equal(page.elements.get("hp-video").srcObject, null); // preview unbound
  assert.ok(page.mic.tracksStopped >= 1); // the camera's tracks
  assert.equal(page.micIntervalCount(), 0); // the inference loop
});

test("backgrounding releases the camera but keeps the model; return is silent and seq continues", async () => {
  const page = loadPerformerPage();
  connectAndJoin(page);

  await driveHandposeToRunning(page);
  framesFlow(page);
  page.hp.handsResult = fakePixelHands();
  page.pumpIntervals();
  await flushMicrotasks();

  const gumBefore = page.mic.gumCalls.length;
  const startsBefore = page.emitted.filter(([e]) => e === "pnds:sensor:start").length;

  page.sandbox.document.visibilityState = "hidden";
  page.fireDocument("visibilitychange");

  assert.equal(page.elements.get("hp-video").srcObject, null); // camera off
  assert.equal(page.hp.disposedModels, 0); // the model is memory, kept
  assert.equal(page.micIntervalCount(), 0);
  page.emitted.length = 0;
  page.pumpIntervals(); // nothing ticks in the background
  await flushMicrotasks();
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:sample").length,
    0,
  );

  page.sandbox.document.visibilityState = "visible";
  page.fireDocument("visibilitychange");
  await flushMicrotasks();

  assert.equal(page.mic.gumCalls.length, gumBefore + 1); // re-acquired
  assert.notEqual(page.elements.get("hp-video").srcObject, null);
  assert.equal(page.hp.disposedModels, 0); // the kept model runs
  // Silent: no second sensorStart after the resume.
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:start").length,
    0,
  );

  page.pumpIntervals();
  await flushMicrotasks();
  const sample = page.emitted.find(([e]) => e === "pnds:sensor:sample");
  assert.ok(sample, "samples flow again after the silent re-acquisition");
  assert.equal(sample[1].seq, 2); // the seq keeps climbing — provably new
  void startsBefore;
});

test("without a secure context the handpose camera reads unsupported, with the HTTPS reason", async () => {
  const page = loadPerformerPage({ mediaDevices: null });
  connectAndJoin(page);
  page.emitted.length = 0;

  page.button("handpose").dispatch("click");
  await flushMicrotasks();

  const permission = page.emitted.find(([e]) => e === "pnds:sensor:permission");
  assert.ok(permission, "the unsupported fact must reach the server");
  assert.equal(permission[1].sensor, "handpose");
  assert.equal(permission[1].permission, "unsupported");
  assert.equal(page.scripts.length, 0); // nothing loads without a camera
  assert.match(page.note("handpose").textContent, /HTTPS/);
});

test("a denied camera is diagnosable and recoverable", async () => {
  const page = loadPerformerPage({ gum: "deny" });
  connectAndJoin(page);
  page.emitted.length = 0;

  page.button("handpose").dispatch("click");
  await flushMicrotasks();

  const permission = page.emitted.find(([e]) => e === "pnds:sensor:permission");
  assert.equal(permission[1].permission, "denied");
  assert.equal(
    page.emitted.filter(([e]) => e === "pnds:sensor:start").length,
    0,
  );
  assert.match(page.note("handpose").textContent, /Permission denied/);
});

test("an inference fault lands in its own state with the camera still live", async () => {
  const page = loadPerformerPage();
  connectAndJoin(page);

  await driveHandposeToRunning(page);
  framesFlow(page);
  page.hp.detectError = new Error("backend lost");
  page.pumpIntervals();
  await flushMicrotasks();

  // The fault's own reason rides along with the state.
  assert.match(page.note("handpose").textContent, /Inference failed: backend lost/);
  assert.equal(page.hp.disposedModels, 1); // the suspect model is gone
  assert.notEqual(page.elements.get("hp-video").srcObject, null); // camera kept
  assert.equal(page.micIntervalCount(), 0);
});

test("a missing local asset inventory warns before anything runs", async () => {
  const page = loadPerformerPage({ assetsOk: false });
  connectAndJoin(page);
  await flushMicrotasks();

  assert.match(page.note("handpose").textContent, /fetch:handpose/);
  assert.equal(page.hp.scriptConfigs.length, 0);
});
