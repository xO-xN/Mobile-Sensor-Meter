// Mobile Sensor Meter — score server entry point.
//
// A network-only PNDS project: no audio engine, no SuperCollider. The
// server:
// - serves the performer page (sensor capture) and the monitor page
//   (per-device sensor console) on both ports
// - exposes /__pnds/health on both ports (audio mode "none")
// - assigns client ids, restores them on reconnect (claim token) — the
//   stable test device identity every monitor row keys on
// - tracks per-device sensor state (lib/sensors.js): capture, permission,
//   the LATEST sample per sensor, and freshness derived from sample time
// - resolves the full performer URL once (runtime-contract §15): QR,
//   copyable address and __config.js all carry the same value, so the
//   project works identically over plain HTTP and over the App's
//   trusted-HTTPS entry
// - shuts down cleanly on SIGINT / SIGTERM

const path = require("node:path");
const express = require("express");

const {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveServerConfig,
  resolvePerformerUrl,
} = require("./lib/config");
const { resolveHostLanIp } = require("./lib/network");
const { HealthTracker } = require("./lib/health");
const { PlayerRegistry } = require("./lib/players");
const {
  SensorHub,
  DEFAULT_STALE_AFTER_MS,
} = require("./lib/sensors");
const { qrHandler } = require("./lib/qr");
const { readHandposeAssets } = require("./lib/handpose-assets");
const { attachShutdown, closeHttpServer } = require("./lib/lifecycle");
const shared = require("./public/shared");

const PROJECT_ROOT = __dirname;
const { events: EVENTS } = shared;

// How long a capturing sensor's newest sample stays "live" without a
// newer one (freshness is sample-derived only — heartbeats never feed
// it). Overridable so the integration tests can exercise staleness in
// wall-clock seconds instead of minutes; the fallback lives in
// lib/sensors.js (one number, one home).
function resolveStaleAfterMs(environment) {
  const declared = Number(environment.SENSOR_STALE_AFTER_MS);

  return Number.isFinite(declared) && declared >= 250
    ? declared
    : DEFAULT_STALE_AFTER_MS;
}

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const manifest = loadManifest(PROJECT_ROOT);
const cliOptions = parseCliOptions(process.argv.slice(2));

if (cliOptions.help) {
  printUsage();
  process.exit(0);
}

const serverConfig = resolveServerConfig(manifest, process.env);
const hostLanIp = resolveHostLanIp(process.env.PNDS_HOST_IP);

// The one full performer URL every outward surface shares — QR, the
// monitor's copyable address, __config.js and the startup log. The App
// injects PNDS_PERFORMER_URL while its HTTPS entry is in effect; a
// standalone HTTPS trial sets it manually (docs/https-trial.md). Without
// it, the LAN HTTP fallback keeps the plain-HTTP behavior.
const performerUrl = resolvePerformerUrl(
  process.env,
  hostLanIp,
  serverConfig.performerPort,
);

// ------------------------------------------------------------
// HTTP servers (performer port + monitor port share public/)
// ------------------------------------------------------------

const app = express();
const monitorApp = express();

app.use(express.static(path.join(PROJECT_ROOT, "public")));
monitorApp.use(express.static(path.join(PROJECT_ROOT, "public")));

// Injects runtime config into the browser so shared.js can read it.
//
// `role` says which server served the page: under the App's HTTPS entry
// the browser's port is the entry's, not the manifest's, so the page
// must never infer its role from a port comparison (runtime-contract
// §15). performerUrl is the one full URL the QR and the copyable
// address show; projectId binds the entry's access context to this
// work's identity.
function configScript(role) {
  return (request, response) => {
    response.type("application/javascript").send(
      `window.__PNDS_CONFIG__ = ${JSON.stringify({
        role,
        projectId: manifest.id,
        performerUrl,
        performerPort: serverConfig.performerPort,
        monitorPort: serverConfig.monitorPort,
      })};`,
    );
  };
}

app.get("/__config.js", configScript("performer"));
monitorApp.get("/__config.js", configScript("monitor"));

// No audio: the runtime contract's "none" mode (audio.status "disabled").
const health = new HealthTracker({
  projectId: manifest.id,
  audioMode: "none",
  performerPort: serverConfig.performerPort,
  monitorPort: serverConfig.monitorPort,
});

app.get("/__pnds/health", health.handler());
monitorApp.get("/__pnds/health", health.handler());

// QR code for the performer page, shown on the monitor page. Encodes
// the same resolved performer URL the config and the copyable address
// carry — one source, no drift.
monitorApp.get("/qr", qrHandler(performerUrl));

// The handpose leg's local-asset inventory (#144): everything the phone
// would request from /vendor/ — ml5 itself, both model.json files and
// every shard their manifests declare — checked for presence on THIS
// origin. The page uses it to say precisely what is missing (the fix is
// `npm run fetch:handpose` on the host), never to fall back to a CDN.
app.get("/handpose/assets.json", (_request, response) => {
  response.json(readHandposeAssets(path.join(PROJECT_ROOT, "public", "vendor")));
});

// ------------------------------------------------------------
// Client registry + sensor hub
// ------------------------------------------------------------

const registry = new PlayerRegistry({
  maxClients: shared.maxClients,
});

const hub = new SensorHub({ staleAfterMs: resolveStaleAfterMs(process.env) });

// ------------------------------------------------------------
// Startup
// ------------------------------------------------------------

const server = app.listen(serverConfig.performerPort, "0.0.0.0", () => {
  printRuntimeInfo();
});

const monitorServer = monitorApp.listen(
  serverConfig.monitorPort,
  "0.0.0.0",
  () => {
    console.log(
      `Monitor page: http://${hostLanIp}:${serverConfig.monitorPort}/`,
    );
  },
);

server.on("error", (error) => {
  console.error(
    `Performer HTTP server failed on port ${serverConfig.performerPort}:`,
    error,
  );
  process.exitCode = 1;
});

monitorServer.on("error", (error) => {
  console.error(
    `Monitor HTTP server failed on port ${serverConfig.monitorPort}:`,
    error,
  );
  process.exitCode = 1;
});

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Nothing to wait for: no audio engine, so the project is ready as soon
// as the HTTP servers are up.
health.setAudioDisabled();

// ------------------------------------------------------------
// Socket.IO protocol
// ------------------------------------------------------------

io.on("connection", (socket) => {
  socket.on(EVENTS.join, (payload) => {
    const result = registry.allocate({
      socketId: socket.id,
      claimToken: payload && payload.token,
    });

    if (result.status === "rejected") {
      socket.emit(EVENTS.rejected, { reason: result.message });
      socket.disconnect(true);
      return;
    }

    // The recovered identity keeps its sensor record (and its samples);
    // a fresh join starts blank. The id is the stable device identity
    // the monitor keys on — a reconnect never lands on another row.
    if (result.status === "recovered") {
      hub.reconnect(result.id, Date.now());
    } else {
      hub.join(result.id, Date.now());
    }

    socket.emit(EVENTS.joined, {
      id: result.id,
      token: result.token,
      recovered: result.status === "recovered",
    });
    broadcastState();
  });

  // Sensor lifecycle: the phone reports what ITS user did. The socket
  // resolves the device id — a client can never write another device's
  // row.
  socket.on(EVENTS.sensorStart, (payload) => {
    const id = registry.findIdBySocket(socket.id);
    if (id === null || !payload || typeof payload.sensor !== "string") {
      return;
    }

    if (hub.start(id, payload.sensor, {
      at: Date.now(),
      permission: payload.permission,
    })) {
      broadcastState();
    }
  });

  socket.on(EVENTS.sensorStop, (payload) => {
    const id = registry.findIdBySocket(socket.id);
    if (id === null || !payload || typeof payload.sensor !== "string") {
      return;
    }

    if (hub.stop(id, payload.sensor, {
      at: Date.now(),
      permission: payload.permission,
    })) {
      broadcastState();
    }
  });

  socket.on(EVENTS.sensorPermission, (payload) => {
    const id = registry.findIdBySocket(socket.id);
    if (
      id === null ||
      !payload ||
      typeof payload.sensor !== "string" ||
      typeof payload.permission !== "string"
    ) {
      return;
    }

    if (hub.setPermission(id, payload.sensor, payload.permission, {
      at: Date.now(),
    })) {
      broadcastState();
    }
  });

  // The sample path: newest processed values only. Late results
  // (stopped captures) and replays are rejected inside the hub without
  // touching state; accepted samples broadcast at wire rate (the phone
  // limits sending to ~30 Hz per device; the monitor's frame loop
  // smooths the stream, so the broadcast cadence is not a display
  // rate).
  socket.on(EVENTS.sensorSample, (payload) => {
    const id = registry.findIdBySocket(socket.id);
    if (id === null || !payload || typeof payload.sensor !== "string") {
      return;
    }

    const result = hub.sample(id, payload.sensor, payload, {
      at: Date.now(),
    });

    if (result.status === "accepted") {
      broadcastState();
    }
  });

  // Page visibility: backgrounded pages report themselves; freshness
  // follows (paused), never fabricated from the heartbeat below.
  socket.on(EVENTS.sensorPause, () => {
    const id = registry.findIdBySocket(socket.id);
    if (id === null) {
      return;
    }

    hub.pause(id, Date.now());
    broadcastState();
  });

  socket.on(EVENTS.sensorResume, () => {
    const id = registry.findIdBySocket(socket.id);
    if (id === null) {
      return;
    }

    hub.resume(id, Date.now());
    broadcastState();
  });

  // Liveness ONLY: the hub records the beat and nothing else — a
  // heartbeat can never make stale samples read as fresh.
  socket.on(EVENTS.heartbeat, () => {
    const id = registry.findIdBySocket(socket.id);
    if (id !== null) {
      hub.heartbeat(id, Date.now());
    }
  });

  socket.on("disconnect", () => {
    const released = registry.releaseBySocket(socket.id);

    if (!released) {
      return;
    }

    hub.disconnect(released.id, Date.now());
    broadcastState();
  });
});

function broadcastState() {
  io.emit(EVENTS.state, { sensors: hub.snapshot(Date.now()) });
}

// Freshness is a function of "now": without a tick, a device whose
// samples stopped arriving would keep reading "live" forever. One
// snapshot per second retires stale rows (and refreshes ages).
const stateTimer = setInterval(broadcastState, 1000);

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------

attachShutdown({
  onShutdown: async () => {
    health.setStopping();
    clearInterval(stateTimer);

    // Drop every connected client first — performers AND the monitor
    // page's observer socket. io.close() waits for clients to take
    // their disconnect; a phone on a weak network must not outlive the
    // host's kill window. Per-step elapsed below: a slow step found in
    // the wild is diagnosable from the output tail alone.
    const t0 = Date.now();
    io.disconnectSockets(true);
    io.close();
    const tSockets = Date.now() - t0;

    const t1 = Date.now();
    await closeHttpServer(server);
    await closeHttpServer(monitorServer);
    const tHttp = Date.now() - t1;

    console.log(`[shutdown] steps: sockets ${tSockets}ms, http ${tHttp}ms`);
  },
});

// ------------------------------------------------------------
// Console output
// ------------------------------------------------------------

function printRuntimeInfo() {
  console.log(`[server] ${manifest.name} v${manifest.version}`);
  console.log(`[server] audio: disabled (network-only project)`);
  console.log(`[server] performer page: ${performerUrl}`);
}
