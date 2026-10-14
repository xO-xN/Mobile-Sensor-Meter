// Development/CI only: describe the exact locally installed candidate libraries.
// The .pnds carries references; this map is never placed in a bundle.
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const manifest = require(path.join(root, "manifest.json"));
const allowed = new Set(["p5", "ml5", "express", "qrcode", "socket.io", "socket.io-client", "osc-min"]);
const libraries = Object.fromEntries(manifest.sharedLibraries.map(({ id, version }) => {
  if (!allowed.has(id)) throw new Error(`Unknown library ${id}`);
  let file;
  const kind = ["p5", "ml5"].includes(id) ? "browser" : "node";
  if (id === "osc-min") file = path.join(root, "node_modules/osc-min/dist/index.js");
  else if (id === "p5") file = path.join(path.dirname(path.dirname(require.resolve("p5"))), "lib/p5.min.js");
  else if (id === "ml5") file = require.resolve("ml5/dist/ml5.min.js");
  else file = require.resolve(id);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing ${id}@${version} entry`);
  const browserPath = id === "socket.io" ? path.join(path.dirname(require.resolve("socket.io/package.json")), "client-dist/socket.io.js") : undefined;
  return [id, { version, kind, path: file, ...(browserPath ? { browserPath } : {}) }];
}));
process.stdout.write(JSON.stringify(libraries));
