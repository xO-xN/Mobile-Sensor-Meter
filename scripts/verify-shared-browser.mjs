// Real ml5 computation with the project's models; no camera or fabricated inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const [resourceRoot, playwrightModule, browserExecutable] = process.argv.slice(2);
if (!resourceRoot || !playwrightModule || !browserExecutable) {
  throw new Error('Usage: node scripts/verify-shared-browser.mjs <App shared resources> <playwright module> <Chromium executable>');
}
const { chromium } = require(playwrightModule);
const catalog = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'catalog.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json')));
const libraries = Object.fromEntries(manifest.sharedLibraries.map(reference => {
  const item = catalog.libraries.find(item => item.id === reference.id && item.version === reference.version);
  assert.ok(item, `missing ${reference.id}@${reference.version}`);
  return [item.id, { version: item.version, kind: item.kind, path: path.resolve(resourceRoot, item.entry), ...(item.browserEntry ? { browserPath: path.resolve(resourceRoot, item.browserEntry) } : {}) }];
}));
// Socket.IO's browser file is part of its verified production lock tree.
libraries['socket.io'].browserPath ||= path.resolve(resourceRoot, 'node/node_modules/socket.io/client-dist/socket.io.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pnds-mobile-browser-'));
let child;
let browser;
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
try {
  for (const name of ['package.json', 'server.js', 'lib', 'public']) {
    fs.cpSync(path.join(projectRoot, name), path.join(temporary, name), { recursive: true });
  }
  manifest.scoreServer.performerPort = await freePort();
  do { manifest.scoreServer.monitorPort = await freePort(); } while (manifest.scoreServer.performerPort === manifest.scoreServer.monitorPort);
  fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest));
  child = spawn(process.execPath, ['server.js'], { cwd: temporary, env: { ...process.env, PNDS_SHARED_LIBRARIES: JSON.stringify(libraries) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const origin = `http://127.0.0.1:${manifest.scoreServer.performerPort}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await (await fetch(`${origin}/__pnds/health`)).json()).status === 'ready') break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const context = await browser.newContext();
  const external = [];
  const modelRequests = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (new URL(url).origin === origin || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().includes('/vendor/handpose/')) modelRequests.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  await page.goto(origin);
  await page.waitForFunction(() => typeof window.wrapMl5HandPose === 'function');
  const inference = await page.evaluate(async () => {
    await loadVendorScript('/__pnds/shared/ml5.js');
    const model = wrapMl5HandPose({ maxHands: 1, runtime: 'tfjs', modelType: 'lite', detectorModelUrl: '/vendor/handpose/detector/model.json', landmarkModelUrl: '/vendor/handpose/landmark/model.json' });
    await model.ready;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 256, 256);
    const started = performance.now();
    try {
      const hands = await model.detect(canvas);
      return { hands: hands.length, elapsedMs: performance.now() - started, backend: window.ml5.tf.getBackend() };
    } finally { model.dispose(); }
  });
  assert.equal(inference.hands, 0, 'a blank input should finish actual model computation with zero hands');
  assert.ok(inference.elapsedMs > 0);
  assert.equal(modelRequests.length, 4);
  assert.ok(modelRequests.every(request => request.status === 200));
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  const inventory = await (await fetch(`${origin}/handpose/assets.json`)).json();
  assert.equal(inventory.ok, true);
  console.log(JSON.stringify({ project: `${manifest.id}@${manifest.version}`, libraries: Object.fromEntries(manifest.sharedLibraries.map(item => [item.id, item.version])), browser: browser.version(), inference, modelRequests, externalRequestsBlocked: true, externalRequests: external, libraryAndModelInventory: 'passed', deviceAcceptance: 'not verified: camera, motion, microphone, native App and mobile phone', localNodeModules: fs.existsSync(path.join(temporary, 'node_modules')) }, null, 2));
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(force);
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
