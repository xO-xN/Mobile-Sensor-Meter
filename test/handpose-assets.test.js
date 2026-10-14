// The server-side handpose asset inventory (lib/handpose-assets.js):
// what the phone would request from /vendor/ must be verifiably HERE —
// ml5 itself, both model.json files and every shard their manifests
// declare. These tests drive the same reader the endpoint serves,
// against fixture directories built in a temp dir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readHandposeAssets } = require("../lib/handpose-assets");

function modelJson(shards) {
  return JSON.stringify({
    format: "graph-model",
    weightsManifest: shards.map((name) => ({ paths: [name] })),
  });
}

function writeVendor(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-assets-"));

  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  return dir;
}

test("a complete vendor tree reads ok, with the declared shards listed", () => {
  const dir = writeVendor({
    "ml5.min.js": "/* bundle */",
    "handpose/detector/model.json": modelJson(["group1-shard1of1.bin"]),
    "handpose/detector/group1-shard1of1.bin": "weights",
    "handpose/landmark/model.json": modelJson(["group1-shard1of2.bin", "group1-shard2of2.bin"]),
    "handpose/landmark/group1-shard1of2.bin": "w1",
    "handpose/landmark/group1-shard2of2.bin": "w2",
  });

  const assets = readHandposeAssets(dir);

  assert.equal(assets.ok, true);
  assert.deepEqual(assets.missing, []);
  assert.equal(assets.ml5.present, true);
  assert.deepEqual(assets.detector.declaredShards, ["group1-shard1of1.bin"]);
  assert.deepEqual(assets.landmark.declaredShards, [
    "group1-shard1of2.bin",
    "group1-shard2of2.bin",
  ]);
  assert.equal(assets.runtime, "tfjs");
});

test("a missing shard is named exactly — the diagnosis says which file", () => {
  const dir = writeVendor({
    "ml5.min.js": "x",
    "handpose/detector/model.json": modelJson(["group1-shard1of1.bin"]),
    // The shard itself absent.
    "handpose/landmark/model.json": modelJson(["group1-shard1of1.bin"]),
    "handpose/landmark/group1-shard1of1.bin": "w",
  });

  const assets = readHandposeAssets(dir);

  assert.equal(assets.ok, false);
  assert.deepEqual(assets.missing, ["handpose/detector/group1-shard1of1.bin"]);
  assert.equal(assets.detector.shards[0].present, false);
  assert.equal(assets.landmark.shards[0].present, true);
});

test("missing ml5, missing model.json and an unparseable manifest are each diagnosable", () => {
  const noMl5 = writeVendor({
    "handpose/detector/model.json": modelJson(["group1-shard1of1.bin"]),
    "handpose/detector/group1-shard1of1.bin": "w",
    "handpose/landmark/model.json": modelJson(["group1-shard1of1.bin"]),
    "handpose/landmark/group1-shard1of1.bin": "w",
  });
  assert.deepEqual(readHandposeAssets(noMl5).missing, ["ml5.min.js"]);

  const noManifest = writeVendor({
    "ml5.min.js": "x",
    "handpose/detector/group1-shard1of1.bin": "w",
    "handpose/landmark/model.json": modelJson(["group1-shard1of1.bin"]),
    "handpose/landmark/group1-shard1of1.bin": "w",
  });
  assert.deepEqual(readHandposeAssets(noManifest).missing, [
    "handpose/detector/model.json",
  ]);

  const broken = writeVendor({
    "ml5.min.js": "x",
    "handpose/detector/model.json": "{ not json",
    "handpose/landmark/model.json": modelJson(["group1-shard1of1.bin"]),
    "handpose/landmark/group1-shard1of1.bin": "w",
  });
  assert.deepEqual(readHandposeAssets(broken).missing, [
    "handpose/detector/model.json (unparseable)",
  ]);
});

test("an empty vendor tree reports everything missing, without throwing", () => {
  const dir = writeVendor({});
  const assets = readHandposeAssets(dir);

  assert.equal(assets.ok, false);
  assert.deepEqual(assets.missing, [
    "ml5.min.js",
    "handpose/detector/model.json",
    "handpose/landmark/model.json",
  ]);
});

test("the committed vendor tree of THIS project reads ok (the real assets)", () => {
  const assets = readHandposeAssets(
    path.join(__dirname, "..", "public", "vendor"),
    fs,
    require.resolve("ml5/dist/ml5.min.js"),
  );

  assert.equal(assets.ok, true);
  assert.ok(assets.ml5.bytes > 1_000_000); // the pinned ml5 bundle
  assert.ok(assets.detector.modelJson.bytes > 1000);
  assert.deepEqual(assets.detector.declaredShards, ["group1-shard1of1.bin"]);
  assert.deepEqual(assets.landmark.declaredShards, ["group1-shard1of1.bin"]);
});

test("shared ml5 is checked separately while both models remain in the project", t => {
  const dir = writeVendor({
    "handpose/detector/model.json": modelJson(["detector.bin"]),
    "handpose/detector/detector.bin": "weights",
    "handpose/landmark/model.json": modelJson(["landmark.bin"]),
    "handpose/landmark/landmark.bin": "weights",
  });
  const library = path.join(dir, "shared-ml5.js");
  fs.writeFileSync(library, "/* fixed shared runtime */");
  const assets = readHandposeAssets(dir, fs, library);
  assert.equal(assets.ok, true);
  assert.equal(assets.ml5.file, "/__pnds/shared/ml5.js");
  fs.unlinkSync(library);
  const missing = readHandposeAssets(dir, fs, library);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["/__pnds/shared/ml5.js"]);
  assert.deepEqual(missing.detector.missing, []);
  assert.deepEqual(missing.landmark.missing, []);
});
