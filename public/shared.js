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

    // The sensors this tool meters. The mic (#143) and handpose (#144)
    // are exclusive-resource sensors: their captures release on stop /
    // pagehide / background, and their samples carry processed values
    // only (levels, keypoints) — never audio or video.
    sensorIds: { tilt: "tilt", motion: "motion", mic: "mic", handpose: "handpose" },

    // The 21 MediaPipe hand landmarks, in the canonical wire order. The
    // handpose samples carry {x, y} pairs in exactly this order; the
    // names live here once and both pages label from this table.
    keypointNames: [
      "wrist",
      "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip",
      "index_finger_mcp", "index_finger_pip", "index_finger_dip", "index_finger_tip",
      "middle_finger_mcp", "middle_finger_pip", "middle_finger_dip", "middle_finger_tip",
      "ring_finger_mcp", "ring_finger_pip", "ring_finger_dip", "ring_finger_tip",
      "pinky_finger_mcp", "pinky_finger_pip", "pinky_finger_dip", "pinky_finger_tip",
    ],

    // Skeletal connections over keypoint indices (MediaPipe's hand
    // topology) — the phone's overlay draws these, mirrored to match
    // the selfie-view preview.
    handConnections: [
      [0, 1], [1, 2], [2, 3], [3, 4],
      [0, 5], [5, 6], [6, 7], [7, 8],
      [5, 9], [9, 10], [10, 11], [11, 12],
      [9, 13], [13, 14], [14, 15], [15, 16],
      [13, 17], [17, 18], [18, 19], [19, 20],
      [0, 17],
    ],

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
          micTitle: "Microphone (level)",
          alpha: "α", beta: "β", gamma: "γ",
          withGravity: "incl. gravity",
          withoutGravity: "user accel only",
          intensity: "Intensity",
          shake: "Shakes",
          rms: "RMS",
          peak: "Peak",
          level: "Level",
          sampleRate: "Sample rate",
          micUnsupported: "Microphone needs a secure (HTTPS) context — or is unsupported here",
          micMeterNote: "Uncalibrated: FS = fraction of digital full scale; level is dBFS, floor −90",
          handposeTitle: "Hand (ml5 HandPose)",
          hands: "Hands",
          confidence: "Confidence",
          inferMs: "Inference",
          rateHz: "Update rate",
          keypointsLabel: "Keypoints",
          noHand: "No hand detected",
          modelLoading: "Camera live — loading local model…",
          cameraAsk: "Tap Enable to grant camera access",
          handposeUnsupported: "Camera needs a secure (HTTPS) context — or is unsupported here",
          modelError: "Model failed to load — run npm run fetch:handpose on the host",
          modelFailedPrefix: "Model load failed:",
          inferenceError: "Inference failed — try enabling again",
          inferenceFailedPrefix: "Inference failed:",
          webglUnavailable:
            "WebGL unavailable on this page — the hand model needs GPU access (iOS Low Power Mode disables WebGL)",
          handposeConvention: "Keypoints normalized [0, 1], origin top-left, unmirrored (model frame)",
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
          mic: "Microphone",
          rms: "RMS",
          peak: "Peak",
          level: "Level",
          sampleRate: "Sample rate",
          micMeterNote: "Uncalibrated: FS = fraction of digital full scale; level is dBFS, floor −90",
          handpose: "Hand",
          hands: "Hands",
          confidence: "Confidence",
          inferMs: "Inference",
          rateHz: "Update rate",
          keypointsLabel: "Keypoints",
          noHand: "No hand detected",
          handposeConvention: "Keypoints normalized [0, 1], origin top-left, unmirrored (model frame)",
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
          micTitle: "麦克风（电平）",
          alpha: "α", beta: "β", gamma: "γ",
          withGravity: "含重力",
          withoutGravity: "仅用户加速度",
          intensity: "运动强度",
          shake: "摇动次数",
          rms: "RMS",
          peak: "峰值",
          level: "电平",
          sampleRate: "采样率",
          micUnsupported: "麦克风需要 HTTPS 安全上下文——或此浏览器不支持",
          micMeterNote: "未经校准：FS 为数字满幅比例；电平为 dBFS，地板 −90",
          handposeTitle: "手部（ml5 HandPose）",
          hands: "手数",
          confidence: "置信度",
          inferMs: "推理耗时",
          rateHz: "更新率",
          keypointsLabel: "关键点",
          noHand: "未检测到手",
          modelLoading: "摄像头已就绪——正在加载本地模型…",
          cameraAsk: "点「启用」授予摄像头权限",
          handposeUnsupported: "摄像头需要 HTTPS 安全上下文——或此浏览器不支持",
          modelError: "模型加载失败——请在 Host 上运行 npm run fetch:handpose",
          modelFailedPrefix: "模型加载失败：",
          inferenceError: "推理失败——请重新启用",
          inferenceFailedPrefix: "推理失败：",
          webglUnavailable:
            "此页面无法使用 WebGL——手部模型需要 GPU（iOS 低电量模式会禁用 WebGL）",
          handposeConvention: "关键点归一化 [0, 1]，原点左上，未镜像（模型坐标系）",
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
          mic: "麦克风",
          rms: "RMS",
          peak: "峰值",
          level: "电平",
          sampleRate: "采样率",
          micMeterNote: "未经校准：FS 为数字满幅比例；电平为 dBFS，地板 −90",
          handpose: "手部",
          hands: "手数",
          confidence: "置信度",
          inferMs: "推理耗时",
          rateHz: "更新率",
          keypointsLabel: "关键点",
          noHand: "未检测到手",
          handposeConvention: "关键点归一化 [0, 1]，原点左上，未镜像（模型坐标系）",
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
