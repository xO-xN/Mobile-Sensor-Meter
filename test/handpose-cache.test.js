const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("verifying complete pinned local models leaves their provenance and bytes unchanged", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-cached-models-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(__dirname, "../scripts/fetch-handpose.mjs"), path.join(root, "scripts/fetch-handpose.mjs"));
  const target = path.join(root, "public/vendor/handpose");
  fs.cpSync(path.join(__dirname, "../public/vendor/handpose"), target, {recursive: true});
  const pin = path.join(target, "PINNED.json");
  const before = fs.readFileSync(pin);
  const output = execFileSync(process.execPath, [path.join(root, "scripts/fetch-handpose.mjs")], {encoding: "utf8", timeout: 10000});
  assert.match(output, /done: 4 assets/);
  assert.deepEqual(fs.readFileSync(pin), before);
});
