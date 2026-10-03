// Mobile Sensor Diagnostics — locale following.
//
// Monitor page: PNDS App ≥ v1.3.0 pushes its current UI language into
// the monitor iframe over cross-origin postMessage (network reference
// "Locale Following"):
//
//   { type: "pnds:locale", version: 1, locale: "en" | "zh-CN" }
//
// Delivery is best-effort, latest-value-wins; applying is idempotent
// and malformed messages are ignored silently.
//
// Performer page: no App bridge exists (phones scan a QR, they never
// ride inside the App), so the page picks its locale from the device
// language via pickLocale() — the operator-facing copy still follows
// the bridge above.

(function (root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PNDS_LOCALE = api;

    // Browser wiring (monitor page): the current locale starts at the
    // page default, optionally seeded by ?lang=<code> for the first
    // frame, then follows every locale message. Monitor scripts read it
    // via current() and re-render from the shared copy tables on every
    // change.
    let current = api.DEFAULT_LOCALE;
    const listeners = [];

    api.current = () => current;

    api.subscribe = (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    };

    const apply = (locale) => {
      if (locale === current) {
        return;
      }

      current = locale;
      root.document.documentElement.lang = locale;

      for (const listener of [...listeners]) {
        listener(locale);
      }
    };

    const initial = api.initialLocale(root.location.search);
    if (initial) {
      apply(initial);
    }

    root.addEventListener("message", (event) => {
      const locale = api.localeFromMessage(event.data);
      if (locale) {
        apply(locale);
      }
    });
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The message protocol (network reference "Locale Following").
  const MESSAGE_TYPE = "pnds:locale";
  const MESSAGE_VERSION = 1;

  // The languages this page ships copy tables for (public/shared.js).
  const SUPPORTED_LOCALES = ["en", "zh-CN"];

  // The page's own language before any bridge traffic.
  const DEFAULT_LOCALE = "en";

  // The locale of a locale message, or null for anything the page must
  // ignore (unknown type, unknown version, malformed shape, codes the
  // page has no copy table for). Codes compare exactly — the App sends
  // canonical BCP 47 ("zh-CN", not "zh-cn").
  function localeFromMessage(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    if (data.type !== MESSAGE_TYPE || data.version !== MESSAGE_VERSION) {
      return null;
    }
    if (typeof data.locale !== "string") {
      return null;
    }

    return SUPPORTED_LOCALES.includes(data.locale) ? data.locale : null;
  }

  // ?lang=<code> first-frame initial locale; null keeps the default.
  function initialLocale(search) {
    const match = /[?&]lang=([A-Za-z-]+)/.exec(search || "");
    return match && SUPPORTED_LOCALES.includes(match[1]) ? match[1] : null;
  }

  // The performer page's locale from the device language: any Chinese
  // macrolanguage tag (zh, zh-Hans, zh-CN, zh-TW…) maps to the page's
  // "zh-CN" table; everything else keeps English. null/odd input keeps
  // the default too.
  function pickLocale(languageTag) {
    if (typeof languageTag !== "string") {
      return DEFAULT_LOCALE;
    }

    return languageTag.toLowerCase().startsWith("zh") ? "zh-CN" : DEFAULT_LOCALE;
  }

  return {
    localeFromMessage,
    initialLocale,
    pickLocale,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  };
});
