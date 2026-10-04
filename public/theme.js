// Mobile Sensor Meter — theme following (monitor page only).
//
// PNDS App ≥ v1.2.3 pushes its current theme into the monitor iframe
// over cross-origin postMessage (score project spec §5.3 "Theme
// Following"):
//
//   { type: "pnds:theme", version: 1, theme: "<name>", palette: { … } }
//
// Delivery is best-effort, latest-value-wins: the App re-pushes on
// iframe load, on theme switches and on window focus regain, so applying
// a message must be idempotent — every value is simply written into the
// page's own CSS variables, nothing else. Unknown or malformed messages
// are ignored silently; the page never errors.
//
// Only the monitor branch of index.html loads this file. The performer
// page never runs it and always keeps the project's own colors.

(function (root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PNDS_THEME = api;

    // Browser wiring (monitor page): paint the first frame from
    // ?theme=<name> when present, then follow every theme message.
    const applyVariables = (variables, theme) => {
      for (const name of Object.keys(variables)) {
        root.document.documentElement.style.setProperty(name, variables[name]);
      }
      root.document.documentElement.setAttribute("data-utility-theme", theme);
    };

    const initial = api.initialVariables(root.location.search);
    if (initial) {
      applyVariables(initial, api.initialTheme(root.location.search));
    }

    root.addEventListener("message", (event) => {
      const variables = api.variablesFromMessage(event.data);
      if (variables) {
        applyVariables(
          variables,
          typeof event.data.theme === "string" ? event.data.theme : "",
        );
      }
    });
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The message protocol (spec §5.3).
  const MESSAGE_TYPE = "pnds:theme";
  const MESSAGE_VERSION = 1;

  // App palette keys (kebab-case semantic tokens) → the page CSS
  // variables they drive. Palette keys with no page counterpart
  // (sidebar-bg, the *-hover / *-foreground fills) are simply not
  // consumed.
  const SURFACE_VARIABLES = {
    bg: "--bg",
    card: "--card",
    text: "--text",
    "text-secondary": "--muted",
    accent: "--accent",
    danger: "--danger",
    pill: "--track",
  };

  // Status colors have no App counterpart: the App's warning/danger
  // tokens are FILL colors paired with their own label tokens, while
  // this page paints status as text directly on cards. They are derived
  // per palette instead — one light-tuned and one dark-tuned set, each
  // ≥4.5:1 on its theme's card surface (asserted by test/theme.test.js).
  // Red is the exception: the App guarantees its danger token already
  // reads ≥4.5:1 as text on the card, so it maps directly.
  const STATUS_LIGHT = { green: "#15803d", yellow: "#b45309", gray: "#6b7186" };
  const STATUS_DARK = { green: "#86efac", yellow: "#fcd34d", gray: "#d8d3c4" };

  // WCAG relative luminance of a #rrggbb value; null when unparseable
  // (future themes may ship colors in other notations — those fall back
  // to the light status set, matching the page's default look).
  function relativeLuminance(hex) {
    if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) {
      return null;
    }

    const COEFFICIENTS = [0.2126, 0.7152, 0.0722];
    let total = 0;

    for (let channel = 0; channel < 3; channel += 1) {
      const value =
        parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16) / 255;
      const linear =
        value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      total += COEFFICIENTS[channel] * linear;
    }

    return total;
  }

  // The light/dark fork for the derived status set. Sand (#5c5344 ≈ 0.09)
  // and Stage (#16181f ≈ 0.01) cards fall below the threshold; Lavender
  // and Brutal cards are white.
  function hasDarkCard(palette) {
    const luminance = relativeLuminance(palette.card);
    return luminance !== null && luminance < 0.2;
  }

  // The CSS variables for one palette. A pure function of the input —
  // applying it any number of times leaves the same values in place.
  function variablesFromPalette(palette) {
    const variables = {};

    for (const key of Object.keys(SURFACE_VARIABLES)) {
      const value = palette[key];
      if (typeof value === "string" && value !== "") {
        variables[SURFACE_VARIABLES[key]] = value;
      }
    }

    const status = hasDarkCard(palette) ? STATUS_DARK : STATUS_LIGHT;
    variables["--green"] = status.green;
    variables["--yellow"] = status.yellow;
    variables["--gray"] = status.gray;

    if (typeof palette.danger === "string" && palette.danger !== "") {
      variables["--red"] = palette.danger;
    }

    return variables;
  }

  // The palette of a theme message, or null for anything the page must
  // ignore (unknown type, unknown version, malformed shape).
  function paletteFromMessage(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    if (data.type !== MESSAGE_TYPE || data.version !== MESSAGE_VERSION) {
      return null;
    }
    if (
      data.palette === null ||
      typeof data.palette !== "object" ||
      Array.isArray(data.palette)
    ) {
      return null;
    }

    return data.palette;
  }

  function variablesFromMessage(data) {
    const palette = paletteFromMessage(data);
    return palette ? variablesFromPalette(palette) : null;
  }

  // ?theme=<name> first-frame initial values (spec §5.3 — the App does
  // not send the parameter yet; its absence keeps the page's own
  // colors). Values copied from the App's theme set
  // (src/theme-variables.css); when the App's message arrives it
  // overwrites them verbatim.
  const THEME_PALETTES = {
    lavender: {
      bg: "#eef0f8",
      "sidebar-bg": "#e2e5f3",
      card: "#ffffff",
      pill: "#e8ebf7",
      accent: "#5a4ff3",
      "accent-hover": "#4a3fe0",
      "accent-foreground": "#ffffff",
      text: "#171a2b",
      "text-secondary": "#5d6484",
      danger: "#e11d48",
      "danger-hover": "#c2143c",
      "danger-foreground": "#ffffff",
      warning: "#ffb020",
      "warning-hover": "#f0a20c",
      "warning-foreground": "#171a2b",
    },
    sand: {
      bg: "#474036",
      "sidebar-bg": "#4e463b",
      card: "#5c5344",
      pill: "#544a3e",
      accent: "#d97706",
      "accent-hover": "#e8871a",
      "accent-foreground": "#241d12",
      text: "#fff8ec",
      "text-secondary": "#e5dcca",
      danger: "#ffbcc0",
      "danger-hover": "#ffada1",
      "danger-foreground": "#2b1210",
      warning: "#ffc46b",
      "warning-hover": "#f5b455",
      "warning-foreground": "#241d12",
    },
    stage: {
      bg: "#0b0c10",
      "sidebar-bg": "#101218",
      card: "#16181f",
      pill: "#12151d",
      accent: "#34d399",
      "accent-hover": "#10b981",
      "accent-foreground": "#06281a",
      text: "#eceef5",
      "text-secondary": "#99a1b5",
      danger: "#f43f5e",
      "danger-hover": "#fb7185",
      "danger-foreground": "#2b0a12",
      warning: "#fcd34d",
      "warning-hover": "#fde68a",
      "warning-foreground": "#241c06",
    },
    brutal: {
      bg: "#fff1c9",
      "sidebar-bg": "#ffc107",
      card: "#ffffff",
      pill: "#ffe58f",
      accent: "#ff5722",
      "accent-hover": "#e64a19",
      "accent-foreground": "#000000",
      text: "#000000",
      "text-secondary": "#4a4028",
      danger: "#c2103c",
      "danger-hover": "#a80d33",
      "danger-foreground": "#ffffff",
      warning: "#ffb020",
      "warning-hover": "#f0a20c",
      "warning-foreground": "#000000",
    },
  };

  // Pond is the current App name; Lavender remains a compatibility alias.
  THEME_PALETTES.pond = THEME_PALETTES.lavender;

  function initialTheme(search) {
    const match = /[?&]theme=([a-z0-9-]+)/.exec(search || "");
    const name = match && match[1];
    return name && THEME_PALETTES[name] ? name : null;
  }

  function initialVariables(search) {
    const name = initialTheme(search);
    return name ? variablesFromPalette(THEME_PALETTES[name]) : null;
  }

  return {
    paletteFromMessage,
    variablesFromMessage,
    variablesFromPalette,
    initialTheme,
    initialVariables,
    THEME_PALETTES,
  };
});
