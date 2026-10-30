// Public launch seam: a distributed project has no local node_modules.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");

function copyRuntime(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnds-shared-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ["manifest.json", "package.json", "server.js", "lib", "audio", "public", "supercollider"]) {
    if (fs.existsSync(path.join(root, name))) {
      fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
    }
  }
  return dir;
}

function failedLaunch(dir, libraries) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
      cwd: dir,
      env: { ...process.env, PNDS_SHARED_LIBRARIES: JSON.stringify(libraries) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`invalid launch did not fail before startup: ${output}`)); }, 3000);
    child.once("error", reject);
    child.once("exit", code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

test("launch reports the exact missing Host library instead of using a local fallback", async t => {
  const result = await failedLaunch(copyRuntime(t), {});
  assert.notEqual(result.code, 0);
  assert.match(result.output, /express@5\.3\.0.*missing/i);
});

function libraryMap() {
  return JSON.parse(require("node:child_process").execFileSync(process.execPath, [path.join(root, "scripts/shared-env.cjs")], { encoding: "utf8" }));
}

async function freePort() {
  const server = require("node:net").createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function runningProject(t, libraries) {
  const dir = copyRuntime(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  manifest.scoreServer.performerPort = await freePort();
  do { manifest.scoreServer.monitorPort = await freePort(); } while (manifest.scoreServer.monitorPort === manifest.scoreServer.performerPort);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const child = spawn(process.execPath, ["server.js", "--audio-mode", "none"], { cwd: dir, env: { ...process.env, PNDS_SHARED_LIBRARIES: JSON.stringify(libraries) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.kill("SIGTERM");
    await exited;
    clearTimeout(force);
  });
  const performer = `http://127.0.0.1:${manifest.scoreServer.performerPort}`;
  const monitor = `http://127.0.0.1:${manifest.scoreServer.monitorPort}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      const health = await (await fetch(`${performer}/__pnds/health`)).json();
      if (health.status === "ready") return { performer, monitor, child, dir };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`shared project failed to become ready: ${output}`);
}

test("distributed project loads shared scripts, QR and a real Socket.IO connection with no local dependencies", async t => {
  const libraries = libraryMap();
  const project = await runningProject(t, libraries);
  assert.equal(fs.existsSync(path.join(project.dir, "node_modules")), false);
  for (const origin of [project.performer, project.monitor]) {
    const page = await (await fetch(origin)).text();
    assert.match(page, /__pnds\/shared/);
    for (const id of ["p5", "ml5", "socket.io"].filter(id => libraries[id])) {
      const response = await fetch(`${origin}/__pnds/shared/${id}.js`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), fs.readFileSync(libraries[id].browserPath || libraries[id].path, "utf8"));
    }
  }
  const qr = await fetch(`${project.monitor}/qr`);
  assert.equal(qr.status, 404);

  const { io } = require("socket.io-client");
  const socket = io(project.performer, { transports: ["websocket"], reconnection: false });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  const stopped = new Promise(resolve => project.child.once("exit", resolve));
  project.child.kill("SIGTERM");
  assert.equal(await stopped, 0);
});

test("a busy performer port fails promptly without reporting a successful listener", async t => {
  const busy = require("node:net").createServer();
  await new Promise(resolve => busy.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise(resolve => busy.close(resolve)));
  const dir = copyRuntime(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  manifest.scoreServer.performerPort = busy.address().port;
  manifest.scoreServer.monitorPort = await freePort();
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const result = await failedLaunch(dir, libraryMap());
  assert.notEqual(result.code, 0);
  assert.match(result.output, /EADDRINUSE/);
  assert.doesNotMatch(result.output, /performer page:/i);
});


test("Host version mismatch or missing entry fails without silently choosing local dependencies", async t => {
  const libraries = libraryMap();
  const id = libraries.express ? "express" : "qrcode";
  const label = `${id}@${libraries[id].version}`;
  const mismatch = { ...libraries, [id]: { ...libraries[id], version: "0.0.0" } };
  const changed = await failedLaunch(copyRuntime(t), mismatch);
  assert.notEqual(changed.code, 0);
  assert.ok(changed.output.includes(label));
  assert.match(changed.output, /mismatched version/);
  const missing = { ...libraries, [id]: { ...libraries[id], path: path.join(os.tmpdir(), "absent-pnds-shared-entry.js") } };
  const removed = await failedLaunch(copyRuntime(t), missing);
  assert.notEqual(removed.code, 0);
  assert.ok(removed.output.includes(label));
  assert.match(removed.output, /entry file is missing/);
});
