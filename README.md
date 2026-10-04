# Mobile Sensor Meter

[English](#english) | [中文](#中文)

---

## English

A PNDS score project that meters what phones expose to the browser — **tilt** (device orientation, α/β/γ), **motion** (acceleration, shake), **microphone level** (RMS / peak / dBFS) and **hand pose** (local ml5.js HandPose keypoints) — end to end: the phone captures and processes its own sensor data, displays it live, and streams the processed values to the monitor over Socket.IO. The monitor shows every device's values, permissions, connection and data freshness side by side, keyed by a stable device identity that survives reconnects.

Network-only on the server: no audio engine, no SuperCollider; the server always runs with audio disabled (`none` mode). No camera; the camera and microphone are used only after the user's explicit Enable taps, processed on-device (hand keypoints, level numbers), and never recorded or played back — no raw media of any kind leaves the phone, only processed numbers. No cloud inference either: the handpose leg's ml5.js bundle and both TFJS models are served from this project's own origin (below). No hub, no cloud. Stack: Node.js, Express, Socket.IO.

Adapted to the App's trusted-HTTPS entry contract (`scoreServer.supportsPerformerUrl: true`): the same project runs unchanged over plain HTTP, over the App's HTTPS entry, or over a standalone HTTPS trial (below).

### What it verifies

- **Tilt**: the α / β / γ angles the browser actually provides, in degrees, as provided — not a calibrated compass bearing. Missing fields read "unavailable", never 0°.
- **Motion**: the acceleration the browser provides (X/Y/Z, m/s²) with an explicit **incl. gravity / user-accel-only** flag, a motion-intensity magnitude (m/s², smoothed), and a **shake counter** (a threshold crossing with a cooldown — one shake is one).
- **Microphone level** (#143): the phone analyzes the mic locally — RMS and peak over the newest 2048-sample window (~43–46 ms, polled at ≤60 Hz) and a level in dBFS — and sends only those numbers. **Uncalibrated meter values**: FS is the fraction of digital full scale and the level is dBFS floored at −90; nothing here is or claims to be physical dB SPL. A silent room reads REAL zeros (0.0000 FS) with the level at its floor — never "unavailable".
- **The phone shows what the monitor receives**: the readout on the phone binds to the sample it SENDS — the same values. A reconnect (same origin, same claim token) recovers the same device id; data never crosses devices.
- **Honest freshness**: "live" derives from actual sample timestamps only. A heartbeat can never dress stale data as live; a backgrounded page reads "paused"; a sensor that stopped updating reads "stopped updating"; authorized-but-sampleless reads "waiting for samples".
- **Deliberate capture**: each sensor is enabled by an explicit tap (iOS requires the permission prompt inside a user gesture) and has an explicit stop. Late permission results and late sensor events after a stop never restart or mutate a stopped capture — a getUserMedia grant landing after the user stopped releases its stream immediately and reports the fact only.
- **The mic is released, not paused**: the microphone is an exclusive resource, so Stop, page-leave and backgrounding all release the stream and the analysis graph (tracks stopped, AudioContext closed) — the phone's mic indicator goes dark. Returning to the foreground silently re-acquires if the user had left it on; a stopped capture never restarts itself. The captured audio is never played back (the analysis graph never connects to a destination) and never leaves the phone.
- **Hand pose, fully local (#144)**: the phone runs ml5.js 1.4.0's HandPose (tfjs runtime, WebGL — Safari WebGPU not required) with the **lite** palm-detector and landmark models, all served from THIS project's origin (`public/vendor/`, pinned by `npm run fetch:handpose`) — **zero CDN requests at runtime**. The camera and the model are separate stages with separate failures: the preview can be live while the model is missing, and a loaded model is not a completed inference. The model never reads the video element: each tick copies the frame to an offscreen 2d canvas first (tfjs 4.22's GPU video uploads are broken — WebGPU uploads blanks, WebGL's poisons the GL state into NaN and a phantom hand), and the backend is pinned to WebGL (CPU fallback) before the weights load. Every failure SPEAKS: model and inference failures show the underlying reason verbatim on the card (a WebGL-less page — e.g. iOS Low Power Mode — is probed first and named, saving the 4.5 MB download), and the `npm run fetch:handpose` advice appears only when the assets inventory actually reports files missing. **No hand is a result** (hands: 0), never an error; an inference that throws is its own state. The camera is released on Stop / page-leave / backgrounding while the model stays loaded for a fast, silent resume; only the latest processed result rides the wire — never video.
- **Bounded rates, fluid display**: capture ≤60 Hz and send ≤30 Hz — two independent gates; only the latest processed sample is ever sent, so a disconnect never replays history. The monitor renders at frame rate (`requestAnimationFrame`), each value exponentially approaching the newest sample — the SuperCollider control-rate idea: low-rate computation, continuous presentation. No rate counters anywhere — with one deliberate exception (#144): the handpose card shows its inference duration and update rate, because there they ARE the measurement.
- **No ghost devices**: a device that disconnects stays on the monitor for a short grace window (a network blip must not flicker its card), then leaves the roster — a stray tab or link preview that joined once never sits there forever. Identity is unaffected: the returning phone recovers its device id.

### Units, permissions and states (the short manual)

| Thing | Unit | Notes |
| --- | --- | --- |
| Tilt α / β / γ | degrees (°) | As the browser reports them; `null` renders "unavailable" |
| Acceleration X / Y / Z | m/s² | Gravity flag says which block the browser provided |
| Motion intensity | m/s² | Smoothed magnitude of user acceleration |
| Shake count | count | One per threshold crossing, 600 ms cooldown |
| Mic RMS / peak | FS (fraction of full scale, [0, 1]) | Uncalibrated; `null` renders "unavailable" |
| Mic level | dBFS (floor −90) | 20·log10 of RMS, floored; NOT physical dB SPL |
| Mic sample rate | Hz | The phone's AudioContext rate for this capture |
| Hand keypoints x / y | normalized [0, 1] | Origin top-left, x right, y down, UNmirrored (the model's frame — the selfie preview mirrors only visually); 21 MediaPipe landmarks, canonical order |
| Hand count | count | 0 = "no hand detected" — a RESULT, never an error |
| Hand confidence | model score | What the model provided; `null` renders "unavailable" |
| Inference duration | ms | One detect() round-trip on the phone |
| Update rate | Hz | Completions per second over a 2 s rolling window — actual inferences only |

Permissions: on iOS 13+ each motion sensor asks once per origin inside the Enable tap. The microphone and the handpose camera ask via getUserMedia — which requires a **secure context**: over plain HTTP `navigator.mediaDevices` does not exist, and the card reads "unsupported — needs a secure (HTTPS) context" rather than failing silently. "granted", "denied", "unsupported" and "not asked" all render distinctly on the monitor; denial is a diagnosable result, not an error. For diagnostics, every browser "enhancement" (echo cancellation, noise suppression, AGC) is disabled on the mic stream — the meter must see the raw input.

Device states on the monitor: `live` / `waiting for samples` / `stopped updating` / `paused` / `off` / `disconnected` — per sensor, plus the permission chip. A disconnected device's card leaves the roster after a 10 s grace window. The handpose card carries a persistent **mini skeleton window**: the hand's latest keypoints drawn on a dark ground, mirrored x like the phone's selfie preview (the numeric coordinate table stays unmirrored — the model frame), repainted only on newer samples in place; an empty hand clears the window.

### Getting Started

```sh
npm install
npm start    # performer: http://<Host-LAN-IP>:6868/ · monitor: http://<Host-LAN-IP>:6869/
```

Scan the QR on the monitor with a phone, tap Enable on a sensor, tilt, shake — for the mic, speak (or hold a silent room and watch the REAL zeros); for the hand, show it to the camera.

### The local handpose assets

Everything the handpose leg loads at runtime comes from this server's own origin — `public/vendor/` is committed and pinned:

```
public/vendor/ml5.min.js                        ml5.js 1.4.0 (bundles TFJS)
public/vendor/handpose/detector/model.json      MediaPipe hand detector (lite)
public/vendor/handpose/detector/group1-shard1of1.bin
public/vendor/handpose/landmark/model.json      hand landmark model (lite)
public/vendor/handpose/landmark/group1-shard1of1.bin
public/vendor/handpose/PINNED.json              sources + sha256 provenance
```

`npm run fetch:handpose` re-verifies every file against its pinned sha256 and re-downloads only what changed (upstream changes fail loudly — re-pin deliberately). `GET /handpose/assets.json` reports the live inventory — including every shard name each model.json declares — and the phone's hand card names exactly what is missing instead of failing silently. Model/inference failures on the card carry the UNDERLYING reason verbatim (script fetch, tfjs init, WebGL absence); the fetch-script advice belongs to the one failure where it is true — an inventory with files actually missing. `npm install && npm start` is fully offline: nothing here talks to a CDN at runtime.

**Real-device outcome** (trials 1–2): the pipeline works — same-origin assets confirmed byte-identical through the App's HTTPS entry, model weights fetch with zero CDN requests. Two defects surfaced and are fixed: (1) every model failure used to say "run npm run fetch:handpose" even when the assets were present — the card now shows the real reason, and a WebGL-less page is probed and named before any download; (2) the REAL blocker: ml5 1.4.0, with no p5 on the page, replaces every factory with a promise-returning one, so `handPose(config)` resolves to the instance instead of returning it — the wrapper now accepts both shapes, and the vm tests drive the promise shape (the one the phone actually runs). (3) Trial 2's hands-always-0, then a phantom hand (constant 1 regardless of content): the model must NEVER read the video element on tfjs 4.22 — WebGPU uploads video frames as blank textures (zero hands), and WebGL's video texture poisons the GL state so every later inference returns NaN, whose scores bypass the 0.5 threshold (a constant phantom hand; the corruption survives a backend switch because the weights read back NaN). The fix: each tick copies the frame to an offscreen 2d canvas (pixel-verified honest on every engine, ~1–2 ms at 640×480) and the model runs on that, with the backend pinned to WebGL — CPU fallback — before the weights load. Remaining for the next trial: the mirrored-preview/keypoint alignment in both orientations (portrait/landscape), the portrait coordinate mapping, and the achievable inference rate / duration on target devices.

### Standalone trusted-HTTPS trial

The point of this project is to prove sensor capture works in a **trusted secure context** — iOS Safari only exposes the motion sensors there, and getUserMedia (the microphone) requires a secure context everywhere. Two ways to run it that way; **neither ever installs a certificate on the phone**:

**Option A — inside the PNDS App (recommended once #139–#141 are set up)**: prepare the App's trusted-HTTPS entry once (real DNS domain, public-CA certificate imported, entry switch on — see the App's `docs/zh-CN/reference/https.md`), then start this project from the App. The App's TLS gateway serves the performer page; the QR the monitor shows is the entry URL.

**Option B — standalone, without the App**:

1. **Preconditions** (the same three the App requires):
   - a **real DNS domain** you control (e.g. `sensor.example.org`) — IP literals and `.local` names cannot get a public-CA certificate;
   - a **public-CA certificate** for it (full chain + key, e.g. via Let's Encrypt **DNS-01** — issuance needs no public server);
   - **local DNS** on the venue router (or any DNS the phones receive via DHCP) resolving the domain to this Mac's LAN address.
2. Run a local TLS terminator in front of the performer port — e.g. Caddy: `sensor.example.org:8443 { tls /path/fullchain.pem /path/privkey.pem; reverse_proxy 127.0.0.1:6868 }`.
3. Start the project with the entry URL so the QR, the copyable address and the page config all agree:

   ```sh
   PNDS_HOST_IP=<LAN-IP> PNDS_PERFORMER_URL=https://sensor.example.org:8443/ npm start
   ```

4. Phones scan the QR: secure context, no certificate warning, no profile to install.

Self-signed certificates and private CAs are **not** a success path — phones do not trust them. What this trial proves is the phone-side pipeline (permission, capture, processing, LAN Socket.IO); it does not by itself prove the App's gateway — that is the App-integration acceptance's business.

### Structure

```
server.js       Entry: HTTP (both ports) + Socket.IO + health/shutdown
lib/            Server core (config incl. performer-URL resolution, players
                with durable claims, sensor hub, health, QR, lifecycle,
                handpose asset inventory)
public/         Browser side (dual-role single page + sensor-logic,
                mic-logic and handpose-logic — the capture/processing/
                controller code the tests drive)
public/vendor/  The pinned local handpose assets (ml5 + both models)
scripts/        fetch-handpose.mjs — pin/verify the vendor assets
test/           Behavior tests (API stand-ins + real Socket.IO integration)
docs/           The standalone HTTPS trial notes (https-trial.md)
```

### Tests

```sh
npm run check   # syntax gate over every JS file
npm test        # node --test: behavior + integration tests
```

The integration tests shrink the freshness window via
`SENSOR_STALE_AFTER_MS` (production default: 2000 ms, `lib/sensors.js`)
so staleness assertions run in wall-clock seconds.

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

PNDS 仪表工程（Mobile Sensor Meter）：检验手机浏览器提供的传感器——**倾斜**（设备方向 α/β/γ）、**运动**（加速度、摇动）、**麦克风电平**（RMS / 峰值 / dBFS）与**手部姿态**（本地 ml5.js HandPose 关键点）——的完整链路。手机在自己本地采集与处理、实时显示自身数值，并把处理后的数值经 Socket.IO 送达 monitor；monitor 按稳定设备标识逐台显示数值、权限、连接与数据新鲜度，重连不串设备。

服务端纯网络：无音频引擎、无 SuperCollider，始终以 `none` 模式运行。无摄像头作为数据；摄像头与麦克风只在用户主动点「启用」后使用、在手机本地处理（手部关键点、电平数值），从不录音、从不回放——任何原始媒体都不离开手机，只传处理后的数值。也无云推理：handpose 的 ml5.js 与两份 TFJS 模型全部由本工程自己的 origin 提供（见下）。不依赖 hub 或云。

已适配 App 的可信 HTTPS 入口契约（`scoreServer.supportsPerformerUrl: true`）：同一份代码在纯 HTTP、App HTTPS 入口、独立 HTTPS 试验（见下）下行为一致。

### 验证什么

- **倾斜**：浏览器实际提供的 α / β / γ 角度（度），照原样显示——不是校准过的罗盘方向；缺失字段显示「不可用」，绝不补 0°。
- **运动**：浏览器提供的加速度 XYZ（m/s²）+ 明确的**含重力 / 仅用户加速度**标志、运动强度（m/s²，平滑）、**摇动计数**（阈值 + 冷却，摇一下计一下）。
- **麦克风电平**（#143）：手机本地分析——对最新 2048 采样窗（约 43–46 ms，≤60 Hz 轮询）算 RMS 与峰值，电平为 dBFS——线上只传这几个数。**未经校准的表值**：FS 是数字满幅比例、电平是 dBFS（地板 −90）；不是、也不冒充物理声压级 dB SPL。安静的房间读到**真实的零**（0.0000 FS）、电平停在地板上——绝不显示「不可用」。
- **手机显示的就是 monitor 收到的**：手机读数绑定它**发送**的那个样本——数值完全相同。断线重连（同 origin、同 claim token）恢复同一设备号，数据不串设备。
- **诚实的新鲜度**：「实时」只由真实样本时间戳决定——心跳冒充不了新样本；页面后台显示「已暂停」；停止更新显示「已停止更新」；授权了但没样本显示「等待样本」。
- **主动采集**：每个传感器由用户点击启用（iOS 要求权限弹窗在用户手势内触发）、显式停止；停止后的迟到授权结果与迟到事件不会重启或改写已停止的采集——用户停止后才到达的 getUserMedia 授权会**立刻释放它带来的流**、只报告事实。
- **麦克风是释放、不是暂停**：麦克风是独占资源，停止、离开页面、后台都**释放**流与分析图（停轨道、关 AudioContext）——手机的话筒指示灯熄灭。回到前台时若用户此前开着，则静默重新获取；已停止的采集绝不自行重启。采到的声音从不回放（分析图永不连 destination）、从不离开手机。
- **手部姿态，完全本地（#144）**：手机运行 ml5.js 1.4.0 的 HandPose（tfjs runtime、WebGL——不要求 Safari WebGPU）与 **lite** 掌部检测 / 关键点模型，全部由**本工程自己的 origin** 提供（`public/vendor/`，`npm run fetch:handpose` 固定）——**运行时零 CDN 请求**。摄像头与模型是两个阶段、两种失败：预览可以活着而模型缺失，模型就绪也不等于推理完成。模型绝不直接读视频元素：每个 tick 先把帧拷贝到离屏 2d canvas（tfjs 4.22 的 GPU 视频上传是坏的——WebGPU 上传空白、WebGL 毒化 GL 状态成 NaN 幻影手），并在权重加载前把后端钉到 WebGL（CPU 兜底）。每种失败都会**说话**：模型与推理失败在卡片上原样显示底层原因（先探测 WebGL——例如 iOS 低电量模式会禁用——并点名，省掉 4.5 MB 下载），而 `npm run fetch:handpose` 的建议只在资产清单确实缺文件时出现。**未检测到手是结果**（hands: 0），不是错误；推理抛错自成一态。摄像头在停止 / 离开页面 / 后台时释放，模型则保留供回前台快速静默恢复；线上只传最新处理结果——绝不传视频。
- **限频有界、显示流畅**：采集 ≤60 Hz、发送 ≤30 Hz 两级独立限频；只发送最新处理值，断线不重放历史。monitor 以帧率（`requestAnimationFrame`）渲染，每个数值向最新样本指数逼近——SuperCollider control rate 的思路：低速率计算、连续呈现。页面各处不显示任何速率计数——唯一有意的例外是手部卡（#144）：它显示推理耗时与更新率，因为那正是被测的量。
- **不留幽灵设备**：设备断开后卡片保留一个短暂宽限期（网络抖动不闪烁），随后从名册消失——误入的标签页或链接预览不会永远占着控制台。身份不受影响：回来的手机恢复原设备号。

### 单位、权限与状态（速查）

| 项目 | 单位 | 说明 |
| --- | --- | --- |
| 倾斜 α / β / γ | 度（°） | 浏览器原样提供；缺失显示「不可用」 |
| 加速度 X / Y / Z | m/s² | 重力标志说明浏览器给的是哪一种 |
| 运动强度 | m/s² | 用户加速度的平滑幅值 |
| 摇动计数 | 次 | 阈值触发 + 600 ms 冷却 |
| 麦克风 RMS / 峰值 | FS（满幅比例，[0, 1]） | 未经校准；缺失显示「不可用」 |
| 麦克风电平 | dBFS（地板 −90） | RMS 的 20·log10，取地板；不是物理 dB SPL |
| 麦克风采样率 | Hz | 本次采集的 AudioContext 采样率 |
| 手部关键点 x / y | 归一化 [0, 1] | 原点左上、x 向右、y 向下，**未镜像**（模型坐标系；自拍预览仅视觉镜像）；21 个 MediaPipe 关键点、固定顺序 |
| 手数 | 个 | 0 =「未检测到手」——是结果，不是错误 |
| 手部置信度 | 模型分数 | 模型提供什么显示什么；缺失显示「不可用」 |
| 推理耗时 | ms | 手机上一次 detect() 往返 |
| 更新率 | Hz | 2 秒滚动窗口内的完成次数——只统计真实推理完成 |

权限：iOS 13+ 运动传感器每个 origin 在「启用」点击时询问一次；麦克风与手部摄像头经 getUserMedia 请求——它**要求安全上下文**：纯 HTTP 下 `navigator.mediaDevices` 不存在，卡片会显示「需要 HTTPS 安全上下文」而不是无说明地失败。「已授权 / 被拒绝 / 不支持 / 未询问」在 monitor 上分别显示——拒绝是可诊断的结果，不是错误。为做诊断，麦克风流关闭了浏览器全部「增强」（回声消除、降噪、自动增益）——表必须看到原始输入。

设备状态：`实时 / 等待样本 / 已停止更新 / 已暂停 / 未采集 / 已断开`（每传感器一列）+ 权限标志。已断开设备的卡片在 10 秒宽限期后从名册消失。手部卡片带一个常驻的**骨架小窗**：把最新关键点画在深色底上，x 方向镜像、与手机自拍预览一致（数值坐标表保持未镜像——模型坐标系）；只在有更新样本时原位重绘，无手时窗口清空。

### 快速开始

```sh
npm install
npm start    # performer: http://<Host-LAN-IP>:6868/ · monitor: http://<Host-LAN-IP>:6869/
```

用手机扫 monitor 上的二维码，点「启用」，倾斜、摇动；麦克风则对它说话（或对着安静的房间，看真实的零）；手部则把手伸到摄像头前。

### 手部姿态的本地资产

handpose 运行时加载的一切都来自本服务器自己的 origin——`public/vendor/` 已提交并固定：

```
public/vendor/ml5.min.js                        ml5.js 1.4.0（内含 TFJS）
public/vendor/handpose/detector/model.json      MediaPipe 掌部检测（lite）
public/vendor/handpose/detector/group1-shard1of1.bin
public/vendor/handpose/landmark/model.json      手部关键点模型（lite）
public/vendor/handpose/landmark/group1-shard1of1.bin
public/vendor/handpose/PINNED.json              来源与 sha256 溯源
```

`npm run fetch:handpose` 逐文件核对固定 sha256、只重下载有变化的（上游变化会显式失败——换版本必须有意重固定）。`GET /handpose/assets.json` 报告实时清单——包括每份 model.json 声明的全部分片名——手机端的手部卡片会点名缺了什么，而不是无说明地失败。卡片上的模型 / 推理失败携带**底层原因原文**（脚本拉取、tfjs 初始化、WebGL 缺失）；fetch 脚本的建议只属于唯一成立的失败——清单里真有文件缺失。`npm install && npm start` 完全离线可用：运行时不与任何 CDN 通信。

**实机记录**(第 1–2 轮)：链路可用——同源资产经 App 的 HTTPS 入口逐字节核对一致，模型权重零 CDN 拉取。暴露并修复了两个缺陷：(1) 此前任何模型失败都提示「运行 npm run fetch:handpose」，即使资产齐全——现在卡片显示真实原因，且无 WebGL 的页面会先被探测并点名，不再白下任何东西；(2) **真正的拦路虎**：ml5 1.4.0 在页面没有 p5 时会把所有工厂替换成返回 Promise 的版本，`handPose(config)` 是「resolve 出实例」而非直接返回实例——包装层现在两种形状都接住，替身测试默认驱动 Promise 形状（手机实际运行的那条路径）。（3）第 2 轮的「手数恒 0」及其后的「幻影手」（无论有无手恒为 1）：模型绝不能直接读视频元素——tfjs 4.22 的 WebGPU 把视频帧上传成空白纹理（恒 0 手），WebGL 的视频纹理上传会毒化 GL 状态，此后一切推理返回 NaN，而 NaN 分数绕过 0.5 阈值（恒 1 幻影手；换后端也无法恢复，因为权重读回即 NaN）。修复：每个 tick 先把帧拷贝到离屏 2d canvas（逐像素验证各引擎均诚实，640×480 约 1–2 ms），模型只吃 canvas,并在权重加载前把后端钉到 WebGL（CPU 兜底）。待下一轮实机核实：镜像预览与关键点叠加在竖屏 / 横屏两种方向下的对齐、竖屏坐标映射、以及目标设备上实际可达的推理速率 / 耗时。

### 独立可信 HTTPS 试验

本工程的意义在于证明**可信安全上下文**里的传感器链路——iOS Safari 只在那里开放运动传感器，而 getUserMedia（麦克风）在任何浏览器都要求安全上下文。两种方式，**都不要求手机安装任何证书**：

**方式 A —— 在 PNDS App 内（#139–#141 就绪后推荐）**：一次性准备好 App 的可信 HTTPS 入口（真实 DNS 域名、导入公有 CA 证书、打开入口开关——见 App 的 `docs/zh-CN/reference/https.md`），从 App 启动本工程。App 的 TLS 网关服务 performer 页面，monitor 上的二维码即入口 URL。

**方式 B —— 独立运行，不经 App**：

1. **前置条件**（与 App 相同的三样）：
   - 你控制的**真实 DNS 域名**（如 `sensor.example.org`）——IP 地址与 `.local` 拿不到公有 CA 证书；
   - 该域名的**公有 CA 证书**（完整链 + 私钥；Let's Encrypt **DNS-01** 签发无需公网服务器）；
   - 场地路由器（或手机经 DHCP 获得的任一 DNS）的**本地解析**把域名指到这台 Mac 的局域网地址。
2. 在 performer 端口前放一个本地 TLS 终结——例如 Caddy：`sensor.example.org:8443 { tls /path/fullchain.pem /path/privkey.pem; reverse_proxy 127.0.0.1:6868 }`。
3. 以入口 URL 启动，让二维码、可复制地址与页面配置一致：

   ```sh
   PNDS_HOST_IP=<LAN-IP> PNDS_PERFORMER_URL=https://sensor.example.org:8443/ npm start
   ```

4. 手机扫码：安全上下文、无证书警告、无需安装描述文件。

自签证书与私有 CA **不是**成功路径——手机不信任它们。本试验证明的是手机侧链路（权限、采集、处理、局域网 Socket.IO 送达）；它不等于 App 网关的验收——那是 App 集成验收的事。

### 结构

```
server.js       入口：双端口 HTTP + Socket.IO + health/关停
lib/            服务端核心（含 performer URL 解析的 config、持久 claim 的
                players、sensor hub、health、QR、lifecycle、handpose 资产清单）
public/         浏览器侧（双角色单页 + sensor-logic / mic-logic /
                handpose-logic——测试驱动的采集/处理/控制器代码）
public/vendor/  固定的本地 handpose 资产（ml5 + 两份模型）
scripts/        fetch-handpose.mjs——固定/校验 vendor 资产
test/           行为测试（API 替身 + 真实 Socket.IO 集成）
docs/           独立 HTTPS 试验说明（https-trial.md）
```

### 测试

```sh
npm run check   # 全部 JS 的语法门
npm test        # node --test：行为 + 集成测试
```

集成测试用 `SENSOR_STALE_AFTER_MS` 缩小新鲜度窗口（生产默认 2000 ms，
见 `lib/sensors.js`），让过期断言按秒级墙钟运行。

### 许可

MIT —— 见 [LICENSE](LICENSE)。
