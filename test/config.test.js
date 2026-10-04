// Configuration resolution: ports, the full performer URL contract
// (runtime-contract §15) and the manifest's declarations.

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  loadManifest,
  parseCliOptions,
  resolveServerConfig,
  resolvePerformerUrl,
} = require("../lib/config");

const PROJECT_ROOT = path.join(__dirname, "..");

test("manifest declares the meter project shape", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(manifest.id, "mobile-sensor-meter");
  // Full performer URL adaptation (§15): without the declaration the
  // App's HTTPS entry never applies to this project.
  assert.equal(manifest.scoreServer.supportsPerformerUrl, true);
  // Local audio mode None.
  assert.equal(manifest.audio.defaultMode, "none");
  assert.deepEqual(manifest.audio.supportedModes, ["none"]);
});

test("resolveServerConfig reads ports and rejects equals", () => {
  const config = resolveServerConfig(loadManifest(PROJECT_ROOT));

  assert.equal(config.performerPort, 6868);
  assert.equal(config.monitorPort, 6869);
  assert.equal(config.entry, "server.js");

  assert.throws(
    () =>
      resolveServerConfig({
        scoreServer: { performerPort: 1, monitorPort: 1 },
      }),
    /must be different/,
  );
  assert.throws(
    () =>
      resolveServerConfig({
        scoreServer: { performerPort: 0, monitorPort: 1 },
      }),
    /performerPort/,
  );
});

test("PNDS_PERFORMER_PORT / PNDS_MONITOR_PORT override the manifest (test-suite scratch ports)", () => {
  const config = resolveServerConfig(loadManifest(PROJECT_ROOT), {
    PNDS_PERFORMER_PORT: "46901",
    PNDS_MONITOR_PORT: "46902",
  });

  assert.equal(config.performerPort, 46901);
  assert.equal(config.monitorPort, 46902);

  // The overrides are validated like everything else.
  assert.throws(
    () =>
      resolveServerConfig(loadManifest(PROJECT_ROOT), {
        PNDS_PERFORMER_PORT: "not-a-port",
      }),
    /PNDS_PERFORMER_PORT/,
  );
  assert.throws(
    () =>
      resolveServerConfig(loadManifest(PROJECT_ROOT), {
        PNDS_PERFORMER_PORT: "46901",
        PNDS_MONITOR_PORT: "46901",
      }),
    /must be different/,
  );
});

test("performer URL falls back to the LAN HTTP spelling without the env", () => {
  assert.equal(
    resolvePerformerUrl({}, "192.168.1.10", 6868),
    "http://192.168.1.10:6868/",
  );
});

test("PNDS_PERFORMER_URL wins and is normalized to a rooted href", () => {
  assert.equal(
    resolvePerformerUrl(
      { PNDS_PERFORMER_URL: "https://show.example.org:8443" },
      "192.168.1.10",
      6868,
    ),
    "https://show.example.org:8443/",
  );
  assert.equal(
    resolvePerformerUrl(
      { PNDS_PERFORMER_URL: "https://show.example.org:8443/" },
      "192.168.1.10",
      6868,
    ),
    "https://show.example.org:8443/",
  );
});

test("an unparsable or non-http(s) performer URL fails the start", () => {
  assert.throws(
    () => resolvePerformerUrl({ PNDS_PERFORMER_URL: "not a url" }, "ip", 1),
    /not a valid URL/,
  );
  assert.throws(
    () => resolvePerformerUrl({ PNDS_PERFORMER_URL: "ftp://x/" }, "ip", 1),
    /plain http\(s\) URL/,
  );
  assert.throws(
    () =>
      resolvePerformerUrl({ PNDS_PERFORMER_URL: "https://u:p@x/" }, "ip", 1),
    /plain http\(s\) URL/,
  );
});

test("CLI accepts --audio-mode for App compatibility and ignores it", () => {
  assert.deepEqual(parseCliOptions(["--audio-mode", "none"]), {
    audioMode: "none",
  });
  assert.deepEqual(parseCliOptions(["--audio-mode=internal"]), {
    audioMode: "internal",
  });
  assert.deepEqual(parseCliOptions(["-h"]), { help: true });
});
