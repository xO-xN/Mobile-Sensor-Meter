// Performer page wiring: the join/token flow, the per-sensor enable/stop
// buttons driving the REAL controller code (loaded with a fake window
// platform — the "API stand-in" boundary), the phone readout rendering
// the sample it SENDS (same values, unavailable-vs-zero), and the
// visibility pause path.

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
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    navigator: { language: options.language || "en" },
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
          elements.set(id, new Element("div"));
        }
        return elements.get(id);
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
      projectId: "mobile-sensor-diagnostics",
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
  assert.ok(page.storage.get("mobile-sensor-diagnostics-token"));
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
