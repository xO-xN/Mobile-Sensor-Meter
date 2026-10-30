// Browser regression for the real performer/controller/worker boundary. No server,
// device permission or external connection is needed: routes serve local files;
// camera/mic/sensor APIs and the Socket.IO transport are test inputs/observers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const [resourceRoot, playwrightModule, browserExecutable, mode = 'controlled', locale = 'en-US'] = process.argv.slice(2);
if (!resourceRoot || !playwrightModule || !browserExecutable || !['controlled', 'real'].includes(mode) || !['en-US', 'zh-CN'].includes(locale)) {
  throw new Error('Usage: node scripts/verify-handpose-isolation.mjs <App shared resources> <playwright module> <Chromium executable> [controlled|real] [en-US|zh-CN]');
}
const { chromium } = require(playwrightModule);
const catalog = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'catalog.json')));
const ml5 = catalog.libraries.find(item => item.id === 'ml5' && item.version === '1.4.0');
assert.ok(ml5, 'the pinned ml5 1.4.0 library must be present');
const ml5Path = path.resolve(resourceRoot, ml5.browserEntry || ml5.entry);
const origin = 'https://sensor-meter.test';
const blockMs = 1400;

// These are deliberately SYNCHRONOUS CPU stalls, not delayed Promises. On the
// previous implementation they execute on the page and freeze every sample.
// On the worker implementation they must leave page sampling uninterrupted.
const controlledRuntime = `
(() => {
  function phase(name) {
    const value = { name, at: performance.timeOrigin + performance.now() };
    if (typeof importScripts === 'function') self.postMessage({ type: 'probe-phase', value });
    else window.__sensorProbe.stages.push(value);
  }
  function block() {
    const until = performance.now() + ${blockMs};
    while (performance.now() < until) {}
  }
  phase('loading-runtime');
  block();
  let firstInference = true;
  self.ml5 = {
    tf: { setBackend: async () => true, ready: async () => {}, getBackend: () => 'webgl' },
    handPose() {
      phase('loading-model');
      block();
      return Promise.resolve({
        model: { dispose() {} },
        async detect() {
          if (firstInference) {
            firstInference = false;
            phase('warming-up');
            block();
          }
          return [];
        }
      });
    }
  };
})();`;

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const context = await browser.newContext({ locale, viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const external = [];
  const modelRequests = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.href);
      return route.abort();
    }
    let body;
    let contentType = 'application/javascript';
    if (url.pathname === '/__config.js') {
      body = `window.__PNDS_CONFIG__=${JSON.stringify({ role: 'performer', projectId: 'mobile-sensor-meter', performerUrl: origin, performerPort: 6868, monitorPort: 6869 })}`;
    } else if (url.pathname === '/__pnds/shared/socket.io.js') {
      body = `window.io = () => {
        const handlers = {};
        const socket = {
          on(event, fn) { handlers[event] = fn; },
          emit(event, payload) {
            window.__sensorProbe.sent.push({ event, payload, at: performance.timeOrigin + performance.now() });
            if (event === 'join') queueMicrotask(() => handlers.joined({ id: 1, token: 't'.repeat(32), recovered: false }));
          }
        };
        setTimeout(() => handlers.connect(), 0);
        return socket;
      };`;
    } else if (url.pathname === '/__pnds/shared/ml5.js') {
      body = mode === 'real' ? fs.readFileSync(ml5Path) : controlledRuntime;
    } else if (url.pathname === '/handpose/assets.json') {
      body = JSON.stringify({ ok: true });
      contentType = 'application/json';
    } else {
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(projectRoot, 'public', relative);
      assert.ok(file.startsWith(path.join(projectRoot, 'public') + path.sep), 'route must stay in public');
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
      body = fs.readFileSync(file);
      if (file.endsWith('.html')) contentType = 'text/html';
      else if (file.endsWith('.css')) contentType = 'text/css';
      else if (file.endsWith('.json')) contentType = 'application/json';
      else if (file.endsWith('.bin')) contentType = 'application/octet-stream';
      if (relative.startsWith('vendor/handpose/')) modelRequests.push(relative);
    }
    return route.fulfill({ status: 200, contentType, body });
  });
  await context.addInitScript(() => {
    window.__sensorProbe = { sent: [], stages: [], notes: [], workers: 0 };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        window.__sensorProbe.workers += 1;
        this.addEventListener('message', event => {
          if (event.data?.type === 'probe-phase') window.__sensorProbe.stages.push(event.data.value);
        });
      }
    };
    class FakeAudioContext {
      constructor() { this.state = 'running'; this.sampleRate = 48000; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: block => block.fill(0.002) }; }
      async close() {}
      async resume() {}
    }
    window.AudioContext = FakeAudioContext;
    window.DeviceOrientationEvent = class extends Event {};
    window.DeviceMotionEvent = class extends Event {};
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async constraints => {
        if (constraints.audio) return { getTracks: () => [{ stop() {} }] };
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#808080';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const stream = canvas.captureStream(30);
        const frames = setInterval(() => ctx.fillRect(0, 0, canvas.width, canvas.height), 33);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(frames));
        return stream;
      }
    });
    window.addEventListener('DOMContentLoaded', () => {
      const note = document.getElementById('note-handpose');
      new MutationObserver(() => window.__sensorProbe.notes.push({ text: note.textContent, at: performance.timeOrigin + performance.now() })).observe(note, { childList: true, subtree: true, characterData: true });
      let sample = 0;
      setInterval(() => {
        sample += 1;
        const tilt = new Event('deviceorientation');
        Object.assign(tilt, { alpha: sample % 360, beta: 0, gamma: 0 });
        window.dispatchEvent(tilt);
        const motion = new Event('devicemotion');
        Object.assign(motion, { acceleration: { x: sample % 10, y: 0, z: 0 }, interval: 40 });
        window.dispatchEvent(motion);
      }, 40);
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => document.getElementById('device-number').textContent === '01');
  for (const sensor of ['tilt', 'motion', 'mic']) await page.locator('#btn-' + sensor).click();
  await page.waitForFunction(() => ['tilt', 'motion', 'mic'].every(sensor => window.__sensorProbe.sent.filter(item => item.event === 'pnds:sensor:sample' && item.payload.sensor === sensor).length >= 3));
  const startedAt = await page.evaluate(() => performance.timeOrigin + performance.now());
  await page.locator('#btn-handpose').click();
  if (mode === 'controlled') {
    await page.waitForFunction(() => window.__sensorProbe.stages.some(item => item.name === 'warming-up'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'loading card must fit the phone viewport');
    await page.screenshot({ path: '/tmp/pnds-sensor-handpose-loading.png', fullPage: true });
  }
  await page.waitForFunction(() => window.__sensorProbe.sent.some(item => item.event === 'pnds:sensor:sample' && item.payload.sensor === 'handpose'), undefined, { timeout: 60000 });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'ready card must fit the phone viewport');
  if (mode === 'controlled') await page.screenshot({ path: '/tmp/pnds-sensor-handpose-ready.png', fullPage: true });
  const result = await page.evaluate(() => ({ ...window.__sensorProbe, mainMl5Loaded: Boolean(window.ml5), phase: typeof handpose.phaseOf === 'function' ? handpose.phaseOf() : null, state: handpose.stateOf(), endedAt: performance.timeOrigin + performance.now() }));
  const countsAndGaps = {};
  for (const sensor of ['tilt', 'motion', 'mic']) {
    const samples = result.sent.filter(item => item.event === 'pnds:sensor:sample' && item.payload.sensor === sensor);
    const relevant = samples.filter((item, index) => item.at >= startedAt || samples[index + 1]?.at >= startedAt);
    const maxGapMs = Math.max(...relevant.slice(1).map((item, index) => item.at - relevant[index].at));
    countsAndGaps[sensor] = { count: relevant.length, maxGapMs: Math.round(maxGapMs) };
  }
  console.log(JSON.stringify({ mode, locale, viewport: '393x852', browser: browser.version(), workers: result.workers, mainMl5Loaded: result.mainMl5Loaded, phase: result.phase, state: result.state, samples: countsAndGaps, stages: result.stages.map(item => item.name), statusMessages: [...new Set(result.notes.map(item => item.text).filter(Boolean))], modelRequests, externalRequests: external, pageErrors: errors }, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  for (const [sensor, value] of Object.entries(countsAndGaps)) {
    assert.ok(value.maxGapMs < 750, `${sensor} samples froze for ${value.maxGapMs} ms during handpose startup`);
  }
  assert.equal(result.mainMl5Loaded, false, 'ml5 must never execute on the performer main thread');
  assert.equal(result.workers, 1, 'handpose must own one dedicated worker');
  assert.equal(result.phase, 'ready', 'only a completed first inference marks handpose ready');
  if (mode === 'controlled') {
    assert.deepEqual(result.stages.map(item => item.name), ['loading-runtime', 'loading-model', 'warming-up']);
    for (let index = 0; index < result.stages.length; index += 1) {
      const stage = result.stages[index];
      const end = result.stages[index + 1]?.at ?? result.endedAt;
      for (const sensor of ['tilt', 'motion', 'mic']) {
        const samples = result.sent.filter(item => item.event === 'pnds:sensor:sample' && item.payload.sensor === sensor && item.at > stage.at && item.at < end);
        assert.ok(samples.length >= 10, `${sensor} must keep sending during ${stage.name}`);
      }
    }
    assert.ok(new Set(result.notes.map(item => item.text).filter(Boolean)).size >= 3, 'runtime/model/first-inference progress must be distinguishable');
  } else {
    assert.equal(new Set(modelRequests).size, 4, 'real runtime must fetch all four pinned model files');
  }
  await page.locator('#btn-handpose').click();
  if (mode === 'controlled') {
    // Start a second worker, then stop it while its first inference is actually
    // consuming CPU. This also proves no late result revives a stopped capture.
    const before = await page.evaluate(() => window.__sensorProbe.sent.filter(item => item.event === 'pnds:sensor:sample' && item.payload.sensor === 'handpose').length);
    await page.locator('#btn-handpose').click();
    await page.waitForFunction(() => window.__sensorProbe.stages.filter(item => item.name === 'warming-up').length === 2);
    const cancelStarted = Date.now();
    await page.locator('#btn-handpose').click();
    const cancelMs = Date.now() - cancelStarted;
    assert.ok(cancelMs < 750, `Stop was delayed ${cancelMs} ms by first inference`);
    await page.waitForTimeout(blockMs + 100);
    const after = await page.evaluate(() => ({ state: handpose.stateOf(), count: window.__sensorProbe.sent.filter(item => item.event === 'pnds:sensor:sample' && item.payload.sensor === 'handpose').length }));
    assert.equal(after.state, 'off');
    assert.equal(after.count, before, 'a terminated first inference must never emit a late sample');
    console.log(JSON.stringify({ cancelDuringFirstInferenceMs: cancelMs, lateResults: 0 }));
  }
  for (const sensor of ['tilt', 'motion', 'mic']) {
    await page.locator('#btn-' + sensor).click();
    assert.equal(await page.locator('#btn-' + sensor).getAttribute('aria-pressed'), 'false');
  }
  console.log('PASS: loading and first inference leave other sensor sampling/transport and Stop controls responsive.');
} finally {
  if (browser) await browser.close();
}
