// Shared constants for both browser pages and the score server.
//
// Works as a plain browser global (window.PNDS) and as a Node module.
//
// Single source of truth:
//   Ports / role / projectId / performerUrl → manifest.json + the server's
//     resolved config (browser gets them via __config.js)
//   Events, sensor ids, status vocabularies → here
//   Copy → here (bilingual tables; the pages pick via public/locale.js)

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory({ readConfig: readManifestConfig });
  } else {
    root.PNDS = factory({
      readConfig: function () {
        var cfg = root.__PNDS_CONFIG__;
        if (!cfg) throw new Error("__PNDS_CONFIG__ not set — ensure __config.js loads before shared.js");
        return cfg;
      },
    });
  }
})(typeof self !== "undefined" ? self : this, function (deps) {
  var config = deps.readConfig();

  return {
    // From manifest.json via the server's __config.js (browser) or a
    // direct manifest read (Node). Change ports ONLY in manifest.json.
    performerPort: config.performerPort,
    monitorPort: config.monitorPort,

    // Page role / project identity / the one full performer URL (§15):
    // the QR, the copyable address and this config are the same value.
    role: config.role || null,
    projectId: config.projectId || null,
    performerUrl: config.performerUrl || null,

    // Client roster cap (id space, PlayerRegistry).
    maxClients: 16,

    // The two sensors this tool diagnoses.
    sensorIds: { tilt: "tilt", motion: "motion" },

    // Freshness vocabulary — mirror of lib/sensors.js FRESHNESS. The
    // monitor renders every one of these distinctly: an
    // authorized-but-sampleless sensor reads "waiting", a backgrounded
    // page reads "paused", and stale data is never painted as live.
    freshness: {
      waiting: "waiting",
      live: "live",
      stale: "stale",
      paused: "paused",
      off: "off",
      disconnected: "disconnected",
    },

    // Permission vocabulary — what the page reported per sensor.
    permission: {
      unknown: "unknown",
      granted: "granted",
      denied: "denied",
      unsupported: "unsupported",
    },

    // Claim token persisted by the performer page so a reconnect recovers
    // the same device id (localStorage key — per-origin by construction).
    tokenKey: "mobile-sensor-meter-token",

    events: {
      join: "join",
      joined: "joined",
      rejected: "rejected",
      state: "state",
      // Sensor path (client → server unless noted):
      //   start/stop    — the phone's explicit enable/stop per sensor
      //   sample        — the LATEST processed values (rate-limited
      //                   client-side; the server keeps newest only)
      //   permission    — a permission fact without a capture change
      //                   (denied, unsupported, late results)
      //   pause/resume  — page visibility (backgrounded tab)
      //   heartbeat     — liveness ONLY, never freshness
      sensorStart: "pnds:sensor:start",
      sensorStop: "pnds:sensor:stop",
      sensorSample: "pnds:sensor:sample",
      sensorPermission: "pnds:sensor:permission",
      sensorPause: "pnds:sensor:pause",
      sensorResume: "pnds:sensor:resume",
      heartbeat: "pnds:sensor:heartbeat",
    },

    // UI copy, per locale. "en" is the fallback table; test/locale.test.js
    // asserts both tables share one shape.
    copy: {
      en: {
        performer: {
          title: "Mobile Sensor Meter",
          sub: "Performer",
          connecting: "Connecting…",
          connected: "Connected",
          rejected: "Rejected: ",
          device: "Device ",
          enable: "Enable",
          stop: "Stop",
          tiltTitle: "Tilt (device orientation)",
          motionTitle: "Motion (acceleration)",
          alpha: "α", beta: "β", gamma: "γ",
          withGravity: "incl. gravity",
          withoutGravity: "user accel only",
          intensity: "Intensity",
          shake: "Shakes",
          unavailable: "unavailable",
          permissionDenied: "Permission denied — enable in browser settings",
          permissionAsk: "Tap Enable to grant sensor access",
          unsupported: "Not supported by this browser",
          error: "Sensor error — try enabling again",
          paused: "Paused — page in background",
          noData: "Capturing — no samples yet",
          stopped: "Stopped",
          gravityField: "gravity",
        },
        monitor: {
          title: "Mobile Sensor Meter",
          sub: "Monitor — sensor test console",
          empty: "No devices yet — scan the QR code below",
          scan: "Scan to join as performer",
          qrAlt: "QR code for the performer page",
          address: "Performer address",
          device: "Device ",
          tilt: "Tilt",
          motion: "Motion",
          freshness: "Data",
          freshnessWord: {
            waiting: "waiting for samples",
            live: "live",
            stale: "stopped updating",
            paused: "paused",
            off: "off",
            disconnected: "disconnected",
          },
          permissionWord: {
            unknown: "not asked",
            granted: "granted",
            denied: "denied",
            unsupported: "unsupported",
          },
          alpha: "α", beta: "β", gamma: "γ",
          withGravity: "incl. gravity",
          withoutGravity: "user accel only",
          gravityField: "gravity",
          intensity: "Intensity",
          shake: "Shakes",
          unavailable: "unavailable",
          ago: { just: "just now", seconds: "s ago", minutes: "m ago" },
        },
      },
      "zh-CN": {
        performer: {
          title: "传感器仪表",
          sub: "演奏者",
          connecting: "连接中…",
          connected: "已连接",
          rejected: "被拒绝：",
          device: "设备 ",
          enable: "启用",
          stop: "停止",
          tiltTitle: "倾斜（设备方向）",
          motionTitle: "运动（加速度）",
          alpha: "α", beta: "β", gamma: "γ",
          withGravity: "含重力",
          withoutGravity: "仅用户加速度",
          intensity: "运动强度",
          shake: "摇动次数",
          unavailable: "不可用",
          permissionDenied: "权限被拒绝 — 请在浏览器设置中允许",
          permissionAsk: "点「启用」授予传感器权限",
          unsupported: "此浏览器不支持",
          error: "传感器错误 — 请重新启用",
          paused: "已暂停 — 页面在后台",
          noData: "采集中 — 暂无样本",
          stopped: "已停止",
          gravityField: "重力",
        },
        monitor: {
          title: "传感器仪表",
          sub: "监视端 — 传感器测试控制台",
          empty: "还没有设备 — 扫描下方二维码加入",
          scan: "扫码加入为测试设备",
          qrAlt: "演奏者页面二维码",
          address: "演奏者地址",
          device: "设备 ",
          tilt: "倾斜",
          motion: "运动",
          freshness: "数据",
          freshnessWord: {
            waiting: "等待样本",
            live: "实时",
            stale: "已停止更新",
            paused: "已暂停",
            off: "未采集",
            disconnected: "已断开",
          },
          permissionWord: {
            unknown: "未询问",
            granted: "已授权",
            denied: "被拒绝",
            unsupported: "不支持",
          },
          alpha: "α", beta: "β", gamma: "γ",
          withGravity: "含重力",
          withoutGravity: "仅用户加速度",
          gravityField: "重力",
          intensity: "运动强度",
          shake: "摇动次数",
          unavailable: "不可用",
          ago: { just: "刚刚", seconds: " 秒前", minutes: " 分钟前" },
        },
      },
    },
  };
});

// Node: read the manifest directly (the single source of truth). The
// browser branch above reads the server-injected __PNDS_CONFIG__ instead.
function readManifestConfig() {
  var fs = require("node:fs");
  var path = require("node:path");
  // shared.js lives in public/; the manifest is one directory up.
  var manifestPath = path.join(__dirname, "..", "manifest.json");
  var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    performerPort: manifest.scoreServer.performerPort,
    monitorPort: manifest.scoreServer.monitorPort,
    role: null,
    projectId: manifest.id,
    performerUrl: null,
  };
}
