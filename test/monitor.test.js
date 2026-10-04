// Monitor page rendering: devices keyed by the stable id, every
// freshness/permission vocabulary rendered distinctly, values with
// units, nulls as "unavailable", frame-rate smoothing toward the newest
// sample (no display-rate counters anywhere), disconnected devices
// leaving the roster after a grace window, and the QR/address carrying
// the resolved performer URL.

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
  const rafQueue = [];

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
    // The display leg's pacing: queued (never run automatically), so a
    // test pumps frames with explicit timestamps.
    requestAnimationFrame: (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    },
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
      projectId: "mobile-sensor-meter",
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

  return {
    sandbox,
    elements,
    handlers,
    // Runs one generation of scheduled frames at the given timestamp;
    // the loop re-schedules itself, so the next pump is another frame.
    pump(nowMs) {
      for (const fn of rafQueue.splice(0)) {
        fn(nowMs);
      }
    },
  };
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
      mic: {
        sensor: "mic",
        capture: "off",
        permission: "unknown",
        freshness: "off",
        sample: null,
      },
      handpose: {
        sensor: "handpose",
        capture: "off",
        permission: "unknown",
        freshness: "off",
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
            ...deviceEntry().sensors,
            tilt: { ...deviceEntry().sensors.tilt, freshness: "waiting" },
            motion: { ...deviceEntry().sensors.motion, freshness: "live" },
          },
        }),
        2: deviceEntry({
          id: 2,
          paused: true,
          sensors: {
            ...deviceEntry().sensors,
            tilt: { ...deviceEntry().sensors.tilt, freshness: "stale" },
            motion: { ...deviceEntry().sensors.motion, freshness: "off" },
          },
        }),
        3: deviceEntry({
          id: 3,
          connected: false,
          sensors: {
            ...deviceEntry().sensors,
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
            ...deviceEntry().sensors,
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
            mic: {
              ...deviceEntry().sensors.mic,
              capture: "on",
              freshness: "live",
              sample: {
                seq: 9,
                at: 5000,
                mic: { rms: 0, peak: 0, level: -90, sampleRate: null },
              },
            },
          },
        }),
      },
    },
  });

  const html = page.elements.get("devices").innerHTML;

  // Units on real numbers.
  assert.match(html, /12\.5 °/);
  assert.match(html, /0\.0 °/);
  assert.match(html, /9\.8 m\/s²/);
  assert.match(html, /0\.4 m\/s²/);
  assert.match(html, />3</);
  assert.match(html, /incl\. gravity/);
  // The mic block: a silent room is REAL zeros with meter units, the
  // level at its floor, a missing rate as a word — and the
  // uncalibrated note rides along (#143).
  assert.match(html, /Microphone/);
  assert.match(html, /0\.0000 FS/);
  assert.match(html, /-90\.0 dBFS/);
  assert.match(html, /Uncalibrated/);
  // Missing fields are words, never zeros.
  assert.match(html, /unavailable/);
});

test("values glide at frame rate toward the newest sample — never a jump", () => {
  const page = loadMonitorPage();

  const entryWith = (alpha, seq, at) =>
    deviceEntry({
      sensors: {
        ...deviceEntry().sensors,
        tilt: {
          ...deviceEntry().sensors.tilt,
          sample: { seq, at, tilt: { alpha, beta: 0, gamma: 0 } },
        },
        motion: deviceEntry().sensors.motion,
      },
    });

  page.handlers.state({
    sensors: {
      at: 5000,
      staleAfterMs: 2000,
      devices: { 1: entryWith(0, 1, 4900) },
    },
  });

  // The α row's number, parsed out of the values block the frame loop
  // rewrites.
  const alphaRow = () => {
    const match = page.sandbox.document
      .getElementById("values-1-tilt")
      .innerHTML.match(/label">α<\/span><span class="value">(-?[\d.]+) °/);
    assert.ok(match, "the α row must render");
    return Number(match[1]);
  };

  // The rebuild paints the newest sample directly (no glide from zero).
  assert.equal(alphaRow(), 0);

  // A newer sample lands (same shape — the card is not rebuilt): the
  // first frame moves TOWARD it without reaching it. (90° apart: an
  // unambiguous shortest path — exactly 180° would be a coin flip.)
  page.handlers.state({
    sensors: {
      at: 5000,
      staleAfterMs: 2000,
      devices: { 1: entryWith(90, 2, 4950) },
    },
  });
  page.pump(1000);
  const gliding = alphaRow();
  assert.ok(gliding > 0 && gliding < 90, `gliding, not jumping: ${gliding}`);

  // Frame after frame it converges — the 30 Hz wire reads continuous.
  for (let t = 1016; t <= 3000; t += 16) {
    page.pump(t);
  }
  assert.ok(alphaRow() > 89.9, `converged: ${alphaRow()}`);
});

test("the mic's level glides at frame rate; the sample rate never smooths", () => {
  const page = loadMonitorPage();

  const micEntry = (level, seq) =>
    deviceEntry({
      sensors: {
        ...deviceEntry().sensors,
        mic: {
          ...deviceEntry().sensors.mic,
          capture: "on",
          freshness: "live",
          sample: {
            seq,
            at: 5000,
            mic: { rms: 0.1, peak: 0.2, level, sampleRate: 44100 },
          },
        },
      },
    });

  page.handlers.state({
    sensors: { at: 5000, staleAfterMs: 2000, devices: { 1: micEntry(-60, 1) } },
  });

  const micHtml = () =>
    page.sandbox.document.getElementById("values-1-mic").innerHTML;
  const levelRow = () => {
    const match = micHtml().match(/Level<\/span><span class="value">(-?[\d.]+) dBFS/);
    assert.ok(match, "the level row must render");
    return Number(match[1]);
  };

  // The rebuild paints the newest sample directly (no glide from the
  // −90 floor).
  assert.equal(levelRow(), -60);

  // A louder sample lands (same shape — the card is not rebuilt): the
  // first frame moves TOWARD 0 dBFS without reaching it.
  page.handlers.state({
    sensors: { at: 5000, staleAfterMs: 2000, devices: { 1: micEntry(0, 2) } },
  });
  page.pump(1000);
  const gliding = levelRow();
  assert.ok(gliding < 0 && gliding > -60, `gliding, not jumping: ${gliding}`);

  // The sample rate is a fact, not a magnitude: identical every frame.
  const rate = micHtml().match(/(-?\d+) Hz/);
  assert.equal(rate[1], "44100");
});

test("a disconnected device stays through a blip and leaves after the grace window", () => {
  const page = loadMonitorPage();
  const now = 20000;

  page.handlers.state({
    sensors: {
      at: now,
      staleAfterMs: 2000,
      devices: {
        // Dropped 2 s ago: a blip — the card stays (no flicker).
        1: deviceEntry({ id: 1, connected: false, since: now - 2000 }),
        // Dropped 30 s ago: a ghost join — gone from the roster.
        2: deviceEntry({ id: 2, connected: false, since: now - 30000 }),
      },
    },
  });

  const html = page.elements.get("devices").innerHTML;
  assert.match(html, /data-device="1"/);
  assert.doesNotMatch(html, /data-device="2"/);
  assert.equal(page.elements.get("empty").textContent, "");
});

test("an empty roster points at the QR", () => {
  const page = loadMonitorPage();

  page.handlers.state({
    sensors: { at: 100, staleAfterMs: 2000, devices: {} },
  });

  assert.match(page.elements.get("empty").textContent, /scan the QR/i);
  assert.equal(page.elements.get("devices").innerHTML, "");
});

test("the handpose block shows summary meters and an expandable keypoint detail that refreshes on new samples", () => {
  const page = loadMonitorPage();

  const handposeEntry = (hands, keypoints, seq) =>
    deviceEntry({
      sensors: {
        ...deviceEntry().sensors,
        handpose: {
          ...deviceEntry().sensors.handpose,
          capture: "on",
          freshness: "live",
          sample: {
            seq,
            at: 5000,
            handpose: { hands, confidence: 0.87, keypoints, inferMs: 42.5, rateHz: 9.5 },
          },
        },
      },
    });

  page.handlers.state({
    sensors: {
      at: 5000,
      staleAfterMs: 2000,
      devices: {
        1: handposeEntry(1, [{ x: 0.5, y: 0.25 }, { x: null, y: 0.5 }], 3),
      },
    },
  });

  const html = page.elements.get("devices").innerHTML;
  // Summary meters with units; the count is a fact.
  assert.match(html, /Hand/);
  assert.match(html, /0\.87/);
  assert.match(html, /42\.5 ms/);
  assert.match(html, /9\.5 Hz/);
  assert.match(html, /origin top-left/); // the coordinate convention
  // The expandable detail exists with the canonical names.
  assert.match(html, /<details class="kp-details">/);
  const kp = page.sandbox.document.getElementById("kpd-1").innerHTML;
  assert.match(kp, /wrist/);
  assert.match(kp, /0\.500/);
  assert.match(kp, /0\.250/);
  assert.match(kp, /unavailable/); // a missing coordinate is a word

  // A NEWER sample refreshes the detail rows in place (the element is
  // never recreated — the operator's <details> stays as they left it).
  page.handlers.state({
    sensors: {
      at: 5200,
      staleAfterMs: 2000,
      devices: { 1: handposeEntry(0, [], 4) },
    },
  });
  page.pump(5216);

  const after = page.sandbox.document.getElementById("kpd-1").innerHTML;
  assert.match(after, /No hand detected/);
  // And the summary row shows the real zero.
  assert.match(
    page.sandbox.document.getElementById("values-1-handpose").innerHTML,
    /label">Hands<\/span><span class="value">0<\/span>/,
  );
});
