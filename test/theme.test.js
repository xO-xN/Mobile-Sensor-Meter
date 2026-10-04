const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const theme = require("../public/theme");

function luminance(hex) {
  return [0.2126, 0.7152, 0.0722].reduce((sum, coefficient, i) => {
    const value = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return (
      sum +
      coefficient *
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}
function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("App surfaces keep readouts and permission/freshness words readable in every theme", () => {
  for (const [name, palette] of Object.entries(theme.THEME_PALETTES)) {
    const variables = theme.variablesFromPalette(palette);
    for (const key of [
      "--text",
      "--muted",
      "--green",
      "--yellow",
      "--red",
      "--gray",
    ]) {
      assert.ok(
        contrast(variables[key], variables["--card"]) >= 4.5,
        name + " " + key,
      );
    }
  }
  assert.equal(theme.initialTheme("?theme=pond"), "pond");
  for (const malformed of [
    null,
    {},
    [],
    { type: "pnds:theme", version: 2, palette: {} },
  ]) {
    assert.equal(theme.variablesFromMessage(malformed), null);
  }
});

test("monitor follows first-frame colors, live theme geometry and ignores unrelated messages", () => {
  const variables = new Map();
  const attributes = new Map();
  const listeners = [];
  const page = {
    document: {
      documentElement: {
        style: { setProperty: (key, value) => variables.set(key, value) },
        setAttribute: (key, value) => attributes.set(key, value),
      },
    },
    location: { search: "?theme=brutal" },
    addEventListener: (type, fn) => listeners.push(fn),
  };
  page.self = page;
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../public/theme.js"), "utf8"),
    vm.createContext(page),
  );
  assert.equal(attributes.get("data-utility-theme"), "brutal");
  listeners[0]({
    data: {
      type: "pnds:theme",
      version: 1,
      theme: "stage",
      palette: theme.THEME_PALETTES.stage,
    },
  });
  assert.equal(attributes.get("data-utility-theme"), "stage");
  assert.equal(variables.get("--bg"), theme.THEME_PALETTES.stage.bg);
  listeners[0]({ data: { type: "other", theme: "brutal" } });
  assert.equal(attributes.get("data-utility-theme"), "stage");
});

test("only the monitor role loads the theme bridge", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../public/index.html"),
    "utf8",
  );
  const roleBranch = html.slice(
    html.lastIndexOf("if (window.PNDS_IS_MONITOR)"),
  );
  const [monitor, performer] = roleBranch.split("} else {");
  assert.match(monitor, /src="theme\.js"/);
  assert.doesNotMatch(performer, /src="theme\.js"/);
});
