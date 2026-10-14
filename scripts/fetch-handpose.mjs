// Fetches and pins every project-owned model asset the handpose leg (#144) serves
// from THIS project's own origin — no CDN at runtime:
//
//   ml5.js 1.4.0 is provided by the fixed Host shared reference.
//   public/vendor/handpose/detector/model.json       MediaPipe hand
//   public/vendor/handpose/detector/group1-shard1of1.bin   detector (lite)
//   public/vendor/handpose/landmark/model.json       hand landmark (lite)
//   public/vendor/handpose/landmark/group1-shard1of1.bin
//   public/vendor/handpose/PINNED.json               provenance record
//
// Sources are install-time only (the same URLs the libraries would
// fetch at runtime if left unpinned); everything the PHONE loads at
// runtime comes from this server. Idempotent: files whose sha256
// already matches are left untouched, so re-running is free.
//
// Usage: npm run fetch:handpose

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const PROJECT_ROOT = path.join(import.meta.dirname, "..");
const VENDOR_DIR = path.join(PROJECT_ROOT, "public", "vendor");
const HANDPOSE_DIR = path.join(VENDOR_DIR, "handpose");

const ML5_VERSION = "1.4.0";

// Every asset with its source URL and pinned sha256. The model files
// follow tfhub.dev redirects to the current Kaggle-hosted storage —
// the query string is what tfjs itself sends (?tfjs-format=file).
const PINNED = {
  ml5Version: ML5_VERSION,
  runtime: "tfjs",
  modelType: "lite",
  files: {
    "handpose/detector/model.json": {
      url: "https://tfhub.dev/mediapipe/tfjs-model/handpose_3d/detector/lite/1/model.json?tfjs-format=file",
      sha256: "2de2e139e240169c9794c21676b8ca94da2bbc0146a3e0664133ce66e021b1a5",
    },
    "handpose/detector/group1-shard1of1.bin": {
      url: "https://tfhub.dev/mediapipe/tfjs-model/handpose_3d/detector/lite/1/group1-shard1of1.bin?tfjs-format=file",
      sha256: "8ba46d2152f48320cdb8835854f53d469dc6a33933099ff89929755ca1a88d51",
    },
    "handpose/landmark/model.json": {
      url: "https://tfhub.dev/mediapipe/tfjs-model/handpose_3d/landmark/lite/1/model.json?tfjs-format=file",
      sha256: "2d6bd4d3b34a684e96293ff71e31f9fbc1b4922e0a88d82184cb584055ff3783",
    },
    "handpose/landmark/group1-shard1of1.bin": {
      url: "https://tfhub.dev/mediapipe/tfjs-model/handpose_3d/landmark/lite/1/group1-shard1of1.bin?tfjs-format=file",
      sha256: "444bee1c7d6d330991bd3ce840a95d0c0afcc3a3fcec47c0c3b7f66a3f3533b0",
    },
  },
};

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fetchPinned(relative, pin) {
  const target = path.join(VENDOR_DIR, relative);

  try {
    const existing = await readFile(target);
    if (sha256(existing) === pin.sha256) {
      return { file: relative, status: "present", bytes: existing.length };
    }
    console.warn(`[fetch:handpose] ${relative}: checksum mismatch — re-fetching`);
  } catch {
    // Not present yet.
  }

  const response = await fetch(pin.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${relative}: HTTP ${response.status} from ${pin.url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = sha256(buffer);
  if (actual !== pin.sha256) {
    throw new Error(
      `${relative}: sha256 ${actual} does not match pinned ${pin.sha256} — the upstream asset changed; re-pin deliberately.`,
    );
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, buffer);
  console.log(`[fetch:handpose] ${relative}: ${buffer.length} bytes ✓ pinned`);

  return { file: relative, status: "fetched", bytes: buffer.length };
}

async function main() {
  const outcomes = [];

  for (const [relative, pin] of Object.entries(PINNED.files)) {
    outcomes.push(await fetchPinned(relative, pin));
  }

  // Shard-name consistency: every path each model.json declares must be
  // one of the pinned files (and thus present on disk).
  for (const model of ["detector", "landmark"]) {
    const manifest = JSON.parse(
      await readFile(path.join(HANDPOSE_DIR, model, "model.json"), "utf8"),
    );
    const declared = [
      ...new Set(manifest.weightsManifest.flatMap((group) => group.paths || [])),
    ];
    const known = Object.keys(PINNED.files)
      .filter((file) => file.startsWith(`handpose/${model}/`))
      .map((file) => path.basename(file));

    for (const shard of declared) {
      if (!known.includes(shard)) {
        throw new Error(
          `handpose/${model}/model.json declares shard "${shard}" that the pin does not carry — extend the pin.`,
        );
      }
    }

    console.log(`[fetch:handpose] handpose/${model}: shards ${declared.join(", ")} consistent`);
  }

  await writeFile(
    path.join(HANDPOSE_DIR, "PINNED.json"),
    JSON.stringify({ ...PINNED, fetchedAt: new Date().toISOString() }, null, 2) + "\n",
  );

  const total = outcomes.reduce((sum, { bytes }) => sum + bytes, 0);
  console.log(
    `[fetch:handpose] done: ${outcomes.length} assets, ${(total / 1024 / 1024).toFixed(1)} MiB total`,
  );
}

main().catch((error) => {
  console.error(`[fetch:handpose] failed: ${error.message}`);
  process.exitCode = 1;
});
