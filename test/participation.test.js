const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { io } = require("socket.io-client");

async function listener() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function stateMatching(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {socket.off("state", read); reject(new Error("sensor state timed out"));}, 3000);
    function read(state) { if (predicate(state)) {clearTimeout(timeout); socket.off("state", read); resolve(state);} }
    socket.on("state", read);
  });
}

test("Host listeners retain actual ports, runtime identity and the sensor stream", async (t) => {
  const listeners = [await listener(), await listener()];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-participation-"));
  const ports = listeners.map(server => server.address().port);
  const reportPath = path.join(temporary, "bound.json");
  const runId = "sensor-runtime-311";
  const assignment = { version: 1, runId, reportPath, services: [
    { role: "performer", port: ports[0], fd: 3 },
    { role: "monitor", port: ports[1], fd: 4 },
  ] };
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PNDS_HOST_IP: "127.0.0.1", PNDS_RUNTIME_PORTS: JSON.stringify(assignment) },
    stdio: ["ignore", "pipe", "pipe", ...listeners.map(server => server._handle.fd)],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  listeners.forEach(server => server.close());
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const until = Date.now() + 5000;
  while (!fs.existsSync(reportPath) && Date.now() < until && child.exitCode === null)
    await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(reportPath), `binding report missing: ${output}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath)), {
    version: 1, runId, status: "bound", services: assignment.services.map(({role, port}) => ({role, port})),
  });
  for (const port of ports) {
    const health = await (await fetch(`http://127.0.0.1:${port}/__pnds/health`)).json();
    assert.equal(health.scoreServer.runtimeRunId, runId);
    assert.equal(health.scoreServer.performerPort, ports[0]);
    assert.equal(health.scoreServer.monitorPort, ports[1]);
    assert.equal(health.status, "ready");
  }
  const config = await (await fetch(`http://127.0.0.1:${ports[0]}/__config.js`)).text();
  assert.match(config, /"role":"performer"/);
  assert.match(config, new RegExp(`"performerPort":${ports[0]}`));
  const context = await fetch(`http://127.0.0.1:${ports[0]}/__pnds/context.js`);
  assert.equal(context.status, 200);
  assert.match(context.headers.get("content-type"), /javascript/);
  const socket = io(`http://127.0.0.1:${ports[0]}`, { transports: ["websocket"], reconnection: false });
  t.after(() => socket.close());
  await once(socket, "connect");
  socket.emit("join", {});
  const [joined] = await once(socket, "joined");
  const stateEvent = stateMatching(socket, state => state.sensors.devices[joined.id]?.sensors.tilt.capture === "on");
  socket.emit("pnds:sensor:start", { sensor: "tilt", permission: "granted" });
  await stateEvent;
  const sampleEvent = stateMatching(socket, state => state.sensors.devices[joined.id]?.sensors.tilt.sample?.seq === 1);
  socket.emit("pnds:sensor:sample", {sensor: "tilt", seq: 1, tilt: {alpha: 0, beta: 12, gamma: null}});
  const state = await sampleEvent;
  assert.deepEqual(state.sensors.devices[joined.id].sensors.tilt.sample.tilt, {alpha: 0, beta: 12, gamma: null});
});

test("failed inherited listener adoption atomically reports startup failure", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-failed-binding-"));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const reportPath = path.join(temporary, "bound.json");
  const invalid = fs.openSync("/dev/null", "r");
  const assignment = {version: 1, runId: "failed-sensor-311", reportPath, services: [
    {role: "performer", port: 12345, fd: 3}, {role: "monitor", port: 12346, fd: 4},
  ]};
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {...process.env, PNDS_RUNTIME_PORTS: JSON.stringify(assignment)},
    stdio: ["ignore", "ignore", "ignore", invalid, invalid],
  });
  fs.closeSync(invalid);
  t.after(() => {if (child.exitCode === null) child.kill("SIGKILL");});
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.ok(fs.existsSync(reportPath), "failed adoption must publish the matching runtime report");
  const report = JSON.parse(fs.readFileSync(reportPath));
  assert.equal(report.runId, "failed-sensor-311");
  assert.equal(report.status, "error");
  assert.deepEqual(report.services, []);
  assert.equal(typeof report.error, "string");
});
