// Manifest, CLI and port resolution.
//
// Reusable PNDS core: every score server needs to load manifest.json, parse
// a few CLI flags and resolve the server ports. This project additionally
// resolves the full performer URL (runtime-contract §15): the App injects
// PNDS_PERFORMER_URL while its trusted-HTTPS entry is in effect, and every
// outward surface (QR, copyable address, __config.js) shares that one
// value.
//
// This project runs without audio (mode is always "none"), so the
// audio-mode / OSC machinery of the template has been removed.
// `--audio-mode` is still accepted for App compatibility (the App launches
// the entry with the manifest's defaultMode) but its value is ignored.

const fs = require("node:fs");
const path = require("node:path");

function loadManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, "manifest.json");
  const raw = fs.readFileSync(manifestPath, "utf8");
  return JSON.parse(raw);
}

function parseCliOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--audio-mode") {
      // Accepted for App compatibility; this project always runs with
      // audio disabled ("none").
      options.audioMode = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--audio-mode=")) {
      options.audioMode = argument.slice("--audio-mode=".length);
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printUsage() {
  console.log(
    [
      "Usage: node server.js [options]",
      "",
      "Options:",
      "  --audio-mode <mode>  Accepted for App compatibility (ignored: this",
      "                      project always runs with audio disabled)",
      "  -h, --help           Show this help",
      "",
      "Environment:",
      "  PNDS_HOST_IP         LAN IP advertised to performers",
      "  PNDS_PERFORMER_URL   Full performer URL (injected by the PNDS App's",
      "                       HTTPS entry, or set manually for a standalone",
      "                       HTTPS trial — see docs/https-trial.md)",
    ].join("\n"),
  );
}

function parseHttpPort(value, label) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }

  return port;
}

function resolveServerConfig(manifest, environment = {}) {
  const scoreServer = manifest.scoreServer;

  if (!scoreServer) {
    throw new Error("manifest.json must declare a scoreServer object.");
  }

  // The manifest ports are the contract (the App's entry proxies to
  // exactly these); the env overrides exist for the test suite, so
  // `npm test` can run beside a live instance the App spawned on the
  // manifest ports. Nothing in production sets them.
  const performerPort =
    environment.PNDS_PERFORMER_PORT === undefined
      ? parseHttpPort(scoreServer.performerPort, "scoreServer.performerPort")
      : parseHttpPort(environment.PNDS_PERFORMER_PORT, "PNDS_PERFORMER_PORT");
  const monitorPort =
    environment.PNDS_MONITOR_PORT === undefined
      ? parseHttpPort(scoreServer.monitorPort, "scoreServer.monitorPort")
      : parseHttpPort(environment.PNDS_MONITOR_PORT, "PNDS_MONITOR_PORT");

  if (performerPort === monitorPort) {
    throw new Error(
      "scoreServer.performerPort and scoreServer.monitorPort must be different.",
    );
  }

  return {
    entry: scoreServer.entry,
    workingDirectory: scoreServer.workingDirectory || ".",
    performerPort,
    monitorPort,
  };
}

// PNDS_PERFORMER_URL is injected by the App while its local trusted
// HTTPS entry is in effect and wins whenever present; without it the
// LAN HTTP fallback is exactly today's URL. A declared value must be a
// full http(s) URL — it lands verbatim in QR codes and page config, so
// anything unparsable fails here, at startup, never at show time. The
// parsed href is normalized (root URLs always carry the trailing /).
function resolvePerformerUrl(environment, hostLanIp, performerPort) {
  const declared = String(environment.PNDS_PERFORMER_URL || "").trim();

  if (declared === "") {
    return `http://${hostLanIp}:${performerPort}/`;
  }

  let parsed;

  try {
    parsed = new URL(declared);
  } catch {
    throw new Error(
      `PNDS_PERFORMER_URL is not a valid URL: '${declared}'.`,
    );
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(
      `PNDS_PERFORMER_URL must be a plain http(s) URL: '${declared}'.`,
    );
  }

  return parsed.href;
}

module.exports = {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveServerConfig,
  resolvePerformerUrl,
};
