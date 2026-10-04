// The offline guarantee as a repeatable gate (#145): every text asset
// the phone's browser loads from this origin — pages, scripts, styles,
// everything in public/ EXCEPT the vendored ml5/models (upstream
// bundles; their runtime wiring is pinned by the /vendor/ model-URL
// tests and the PINNED.json provenance) — must reference only
// same-origin paths. An absolute http(s) URL is allowed only for
// localhost / 127.0.0.1, or when the host is built at runtime from
// location.hostname (the monitor's internal cross-port leg — which may
// wrap across lines, so the rule reads the file as one text, not per
// line). Any other absolute URL — a CDN script, a model fetch, a
// stylesheet — fails the offline first-join acceptance, so it fails
// here, with file:line.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const URL_RE = /https?:\/\/[^"'\s)]*/g;

function listTextAssets(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // The vendored ml5 bundle and model files are not ours to audit.
      if (entry.name === "vendor") continue;
      files.push(...listTextAssets(full));
    } else if (/\.(html|js|css|json)$/.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

function externalReferences(dir) {
  const offenders = [];

  for (const file of listTextAssets(dir)) {
    const text = fs.readFileSync(file, "utf8");

    for (const match of text.matchAll(URL_RE)) {
      const url = match[0];
      const host = url.replace(/^https?:\/\//, "").split(/[:/]/)[0];

      // Static internal hosts.
      if (host === "localhost" || host === "127.0.0.1") continue;

      // Same-host dynamic construction: the scheme literal ends and
      // the host is concatenated from location.hostname just after.
      if (url.endsWith("//") && /location\.hostname/.test(text.slice(match.index + url.length, match.index + url.length + 80))) {
        continue;
      }

      const line = text.slice(0, match.index).split("\n").length;
      offenders.push(`${path.relative(dir, file)}:${line}: ${url}`);
    }
  }

  return offenders;
}

test("the served surface references no external origin — offline first join loads only from here", () => {
  const offenders = externalReferences(PUBLIC_DIR);

  assert.deepEqual(
    offenders,
    [],
    "absolute URLs outside this origin found in public/ (offline acceptance blocker):\n" +
      offenders.join("\n"),
  );
});

test("the rule itself catches a planted CDN reference (and spares the same-host legs)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-surface-"));
  fs.writeFileSync(
    path.join(dir, "page.html"),
    [
      '<script src="https://cdn.example.test/ml5.min.js"></script>',
      "<script>const s = io(\"http://' + location.hostname + ':6868');</script>",
      '<link rel="stylesheet" href="http://127.0.0.1:6868/x.css" />',
    ].join("\n"),
  );

  assert.deepEqual(externalReferences(dir), ["page.html:1: https://cdn.example.test/ml5.min.js"]);
});
