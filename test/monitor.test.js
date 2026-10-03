// Monitor page rendering: devices keyed by the stable id, every
// freshness/permission vocabulary rendered distinctly, values with
// units, nulls as "unavailable", and the QR/address carrying the
// resolved performer URL.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

class Element {
  constructor() {
    this.innerHTML = "";
    this.textContent = "";
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

function loadMonitorPage() {
  const elements = new Map();
  const handlers = {};

  const socket = {
    on(event, fn) {
      handlers[event] = fn;
    },
    emit() {},
  };

  const sandbox = {
    console,
    location: { hostname: "localhost", search: "", port: "6869" },
    addEventListener() {},
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, new Element());
        }
        return elements.get(id);
      },
      documentElement: new Element(),
    },
    io: () => socket,
    __PNDS_CONFIG__: {
      role: "monitor",
      projectId: "mobile-sensor-diagnostics",
      performerUrl: "https://show.example.org:8443/",
      performerPort: 6868,
      monitorPort: 6869,
    },
  };

  vm.createContext(sandbox);
  vm.runInContext("var window = this; var self = this;", sandbox);

  for (const file of ["shared.js", "locale.js", "render.js", "monitor.js"]) {
    vm.runInContext(
      fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8"),
      sandbox,
      { filename: file },
    );
  }

  return { sandbox, elements, handlers };
}

function deviceEntry(overrides = {}) {
  return {
    id: 1,
    connected: true,
    paused: false,
    since: 1000,
    heartbeatAgeMs: 100,
    sensors: {
      tilt: {
        sensor: "tilt",
        capture: "on",
        permission: "granted",
        freshness: "live",
        sample: null,
      },
      motion: {
        sensor: "motion",
        capture: "on",
        permission: "granted",
        freshness: "waiting",
        sample: null,
      },
    },
    ...overrides,
  };
}

test("the monitor renders one card per device, keyed by id, with the entry URL", () => {
  const page = loadMonitorPage();

  page.handlers.state({
    sensors: {
      at: 5000,
      staleAfterMs: 2000,
      devices: {
        2: deviceEntry({ id: 2 }),
        1: deviceEntry({ id: 1 }),
      },
    },
  });

  const html = page.elements.get("devices").innerHTML;
  assert.match(html, /data-device="1"/);
  assert.match(html, /data-device="2"/);
  // Sorted by id regardless of arrival order.
  assert.ok(
    html.indexOf('data-device="1"') < html.indexOf('data-device="2"'),
    "devices render in id order",
  );
  // The address is the resolved full performer URL (§15).
  assert.match(
    page.elements.get("address-label").textContent,
    /https:\/\/show\.example\.org:8443\//,
  );
});

test("every freshness vocabulary renders distinctly — never a number masquerading as data", () => {
  const page = loadMonitorPage();

  const words = {
    waiting: "waiting for samples",
    live: "live",
    stale: "stopped updating",
    paused: "paused",
    off: "off",
    disconnected: "disconnected",
  };

  page.handlers.state({
    sensors: {
      at: 5000,
      staleAfterMs: 2000,
      devices: {
        1: deviceEntry({
          sensors: {
            tilt: { ...deviceEntry().sensors.tilt, freshness: "waiting" },
            motion: { ...deviceEntry().sensors.motion, freshness: "live" },
          },
        }),
        2: deviceEntry({
          id: 2,
          paused: true,
          sensors: {
            tilt: { ...deviceEntry().sensors.tilt, freshness: "stale" },
            motion: { ...deviceEntry().sensors.motion, freshness: "off" },
          },
        }),
        3: deviceEntry({
          id: 3,
          connected: false,
          sensors: {
            tilt: { ...deviceEntry().sensors.tilt, freshness: "disconnected" },
            motion: { ...deviceEntry().sensors.motion, freshness: "off" },
          },
        }),
      },
    },
  });

  const html = page.elements.get("devices").innerHTML;

  for (const word of Object.values(words)) {
    assert.match(html, new RegExp(word));
  }

  // The card-level chip shows the WORST truth: device 1 has one live
  // and one sampleless sensor — its card must flag the problem, not
  // read "live" (an operator scanning the room sees failures first).
  const card1 = html.slice(
    html.indexOf('data-device="1"'),
    html.indexOf('data-device="2"'),
  );
  assert.match(card1, /waiting for samples/);
  assert.doesNotMatch(card1, /<h2>Device 1<\/h2>\s*<span class="chip live">/);
});

test("values render with units; nulls render unavailable; zeros stay zeros", () => {
  const page = loadMonitorPage();

  page.handlers.state({
    sensors: {
      at: 5200,
      staleAfterMs: 2000,
      devices: {
        1: deviceEntry({
          sensors: {
            tilt: {
              ...deviceEntry().sensors.tilt,
              sample: { seq: 42, at: 5000, tilt: { alpha: 12.5, beta: 0, gamma: null } },
            },
            motion: {
              ...deviceEntry().sensors.motion,
              sample: {
                seq: 7,
                at: 5000,
                motion: {
                  x: 0,
                  y: null,
                  z: 9.8,
                  includesGravity: true,
                  intensity: 0.4,
                  shakeCount: 3,
                },
              },
            },
          },
        }),
      },
    },
  });

  const html = page.elements.get("devices").innerHTML;

  // Seq correspondence: the exact sample number travels to the monitor.
  assert.match(html, /#42/);
  assert.match(html, /#7/);
  // Units on real numbers.
  assert.match(html, /12\.5 °/);
  assert.match(html, /0\.0 °/);
  assert.match(html, /9\.8 m\/s²/);
  assert.match(html, /0\.4 m\/s²/);
  assert.match(html, />3</);
  assert.match(html, /incl\. gravity/);
  // Missing fields are words, never zeros.
  assert.match(html, /unavailable/);
});

test("an empty roster points at the QR", () => {
  const page = loadMonitorPage();

  page.handlers.state({
    sensors: { at: 100, staleAfterMs: 2000, devices: {} },
  });

  assert.match(page.elements.get("empty").textContent, /scan the QR/i);
  assert.equal(page.elements.get("devices").innerHTML, "");
});
