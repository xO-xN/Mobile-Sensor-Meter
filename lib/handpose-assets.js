// Server-side handpose asset inventory (#144).
//
// The handpose leg serves the shared ml5 library and BOTH project-owned
// tfjs models from this project's own origin (models populated by
// scripts/fetch-handpose.mjs, never fetched from a CDN at runtime).
// This module reads the directory and answers one question honestly:
// is everything the phone will request actually here, with the shard
// names each model.json declares? Pure filesystem logic with an
// injectable fs — the endpoint and the tests drive the same code.

const path = require("node:path");

// The runtime layout the phone loads from (same-origin paths under
// public/, which express serves statically). The model URLs handed to
// ml5.handPose end in model.json; tfjs resolves the shard names the
// manifest declares relative to that file.
const ASSET_LAYOUT = {
  ml5: { file: "ml5.min.js" },
  detector: { dir: "handpose/detector" },
  landmark: { dir: "handpose/landmark" },
};

function statFile(fs, absolutePath) {
  try {
    return fs.statSync(absolutePath);
  } catch {
    return null;
  }
}

function fileFact(fs, vendorDir, relativePath) {
  const stat = statFile(fs, path.join(vendorDir, relativePath));
  return {
    file: relativePath,
    present: stat !== null && stat.isFile(),
    bytes: stat !== null && stat.isFile() ? stat.size : 0,
  };
}

// One model's facts: the model.json, plus every shard its
// weightsManifest declares — each checked for presence. `declared` is
// the manifest's own list (the names tfjs will request); `missing`
// names exactly what is absent, so the diagnostic can say which file,
// not just "model error".
function modelFact(fs, vendorDir, relativeDir) {
  const modelJson = fileFact(fs, vendorDir, `${relativeDir}/model.json`);
  const fact = {
    dir: relativeDir,
    modelJson,
    declaredShards: [],
    shards: [],
    missing: [],
  };

  if (!modelJson.present) {
    fact.missing.push(`${relativeDir}/model.json`);
    return fact;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, relativeDir, "model.json"), "utf8"));
  } catch {
    fact.missing.push(`${relativeDir}/model.json (unparseable)`);
    return fact;
  }

  fact.declaredShards = [
    ...new Set(
      (manifest.weightsManifest || []).flatMap((group) => group.paths || []),
    ),
  ];

  for (const shard of fact.declaredShards) {
    const shardFact = fileFact(fs, vendorDir, `${relativeDir}/${shard}`);
    fact.shards.push(shardFact);

    if (!shardFact.present) {
      fact.missing.push(`${relativeDir}/${shard}`);
    }
  }

  return fact;
}

// The whole inventory: { ok, ml5, detector, landmark }. `ok` is true
// only when every declared shard of both models AND ml5 itself are on
// disk — the page treats ok:false as "model resources missing", a
// diagnosable state, never a silent fallback to a CDN.
function readHandposeAssets(vendorDir, fs = require("node:fs"), libraryFile) {
  const libraryName = libraryFile === undefined ? ASSET_LAYOUT.ml5.file : "/__pnds/shared/ml5.js";
  const ml5 = libraryFile === undefined
    ? fileFact(fs, vendorDir, libraryName)
    : (() => {
        const stat = statFile(fs, libraryFile);
        return { file: libraryName, present: Boolean(stat?.isFile()), bytes: stat?.isFile() ? stat.size : 0 };
      })();
  const detector = modelFact(fs, vendorDir, ASSET_LAYOUT.detector.dir);
  const landmark = modelFact(fs, vendorDir, ASSET_LAYOUT.landmark.dir);

  const ok =
    ml5.present &&
    detector.missing.length === 0 &&
    landmark.missing.length === 0;

  return {
    ok,
    runtime: "tfjs",
    ml5,
    detector,
    landmark,
    missing: [
      ...(!ml5.present ? [libraryName] : []),
      ...detector.missing,
      ...landmark.missing,
    ],
  };
}

module.exports = { readHandposeAssets };
