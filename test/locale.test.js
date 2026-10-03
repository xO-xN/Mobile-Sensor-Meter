// Locale: the bridge message shape, the performer's device-language
// pick, and the copy tables' shape parity (every key in "en" exists in
// "zh-CN" and vice versa — a missing key would render as undefined on
// one language).

const assert = require("node:assert/strict");
const test = require("node:test");

const locale = require("../public/locale");
const shared = require("../public/shared");

test("locale messages validate type, version and code exactly", () => {
  assert.equal(
    locale.localeFromMessage({ type: "pnds:locale", version: 1, locale: "zh-CN" }),
    "zh-CN",
  );
  assert.equal(
    locale.localeFromMessage({ type: "pnds:locale", version: 1, locale: "en" }),
    "en",
  );
  assert.equal(locale.localeFromMessage(null), null);
  assert.equal(locale.localeFromMessage("pnds:locale"), null);
  assert.equal(
    locale.localeFromMessage({ type: "pnds:locale", version: 2, locale: "en" }),
    null,
  );
  assert.equal(
    locale.localeFromMessage({ type: "other", version: 1, locale: "en" }),
    null,
  );
  assert.equal(
    locale.localeFromMessage({ type: "pnds:locale", version: 1, locale: "fr" }),
    null,
  );
});

test("?lang seeds only supported codes", () => {
  assert.equal(locale.initialLocale("?lang=zh-CN"), "zh-CN");
  assert.equal(locale.initialLocale("?x=1&lang=en"), "en");
  assert.equal(locale.initialLocale("?lang=fr"), null);
  assert.equal(locale.initialLocale(""), null);
});

test("the performer page picks its locale from the device language", () => {
  assert.equal(locale.pickLocale("zh-CN"), "zh-CN");
  assert.equal(locale.pickLocale("zh-Hans-CN"), "zh-CN");
  assert.equal(locale.pickLocale("zh-TW"), "zh-CN");
  assert.equal(locale.pickLocale("en-US"), "en");
  assert.equal(locale.pickLocale("ja-JP"), "en");
  assert.equal(locale.pickLocale(null), "en");
  assert.equal(locale.pickLocale(42), "en");
});

test("copy tables share one shape across locales", () => {
  const shape = (value) => {
    if (value === null || typeof value !== "object") {
      return typeof value;
    }

    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape(value[key])]),
    );
  };

  assert.deepEqual(
    shape(shared.copy.en),
    shape(shared.copy["zh-CN"]),
    "en and zh-CN copy tables must expose identical key shapes",
  );
});
