// Only the project's declared, exact Host libraries may be used.
const fs = require("node:fs");
const path = require("node:path");
const manifest = require("../manifest.json");
const injected = process.env.PNDS_SHARED_LIBRARIES;
let host;
if (injected !== undefined) {
  try { host = JSON.parse(injected); } catch { throw new Error("PNDS_SHARED_LIBRARIES is invalid JSON."); }
  if (!host || Array.isArray(host) || typeof host !== "object") {
    throw new Error("PNDS_SHARED_LIBRARIES must be a library map.");
  }
}

function hostEntry(id, kind) {
  const reference = manifest.sharedLibraries.find(reference => reference.id === id);
  if (!reference) throw new Error(`Shared library ${id} is not declared by this project.`);
  const label = `${id}@${reference.version}`;
  const entry = host[id];
  if (!entry) throw new Error(`Shared library ${label} is missing from the Host.`);
  if (entry.version !== reference.version || entry.kind !== kind) {
    throw new Error(`Shared library ${label} has a mismatched version or kind.`);
  }
  if (typeof entry.path !== "string" || !path.isAbsolute(entry.path) || !fs.statSync(entry.path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Shared library ${label} entry file is missing.`);
  }
  return entry;
}

function requireLibrary(id) {
  if (!["express", "qrcode", "socket.io", "socket.io-client"].includes(id)) {
    throw new Error(`Shared library ${id} does not have a CommonJS entry.`);
  }
  return require(host === undefined ? id : hostEntry(id, "node").path);
}


async function importLibrary(id) {
  if (id !== "osc-min") throw new Error(`Shared library ${id} does not have this ESM entry.`);
  const { pathToFileURL } = require("node:url");
  return import(host === undefined ? id : pathToFileURL(hostEntry(id, "node").path).href);
}

function browserFile(id) {
  let file;
  if (host !== undefined) {
    const entry = hostEntry(id, id === "socket.io" ? "node" : "browser");
    file = id === "socket.io" ? entry.browserPath : entry.path;
  } else if (id === "p5") {
    file = path.join(path.dirname(path.dirname(require.resolve("p5"))), "lib/p5.min.js");
  } else if (id === "ml5") {
    file = require.resolve("ml5/dist/ml5.min.js");
  } else if (id === "socket.io") {
    file = path.join(path.dirname(require.resolve("socket.io/package.json")), "client-dist/socket.io.js");
  } else {
    throw new Error(`Shared library ${id} has no browser entry.`);
  }
  if (typeof file !== "string" || !path.isAbsolute(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    const version = manifest.sharedLibraries.find(reference => reference.id === id)?.version;
    throw new Error(`Shared library ${id}@${version} browser file is missing.`);
  }
  return file;
}

function attachBrowserRoutes(app) {
  for (const { id } of manifest.sharedLibraries) {
    if (!["p5", "ml5", "socket.io"].includes(id)) continue;
    const file = browserFile(id);
    app.get(`/__pnds/shared/${id}.js`, (_request, response) => {
      response.sendFile(path.basename(file), { root: path.dirname(file) });
    });
  }
}

if (host !== undefined) {
  const kinds = { p5: "browser", ml5: "browser", express: "node", qrcode: "node", "socket.io": "node", "socket.io-client": "node", "osc-min": "node" };
  for (const { id } of manifest.sharedLibraries) {
    if (!Object.hasOwn(kinds, id)) throw new Error(`Unknown shared library ${id}.`);
    hostEntry(id, kinds[id]);
  }
}

module.exports = { requireLibrary, importLibrary, browserFile, attachBrowserRoutes };
