# Mobile Sensor Diagnostics

[English](#english) | [中文](#中文)

---

## English

A PNDS score project that diagnoses the two motion sensors phones expose to the browser — **tilt** (device orientation, α/β/γ) and **motion** (acceleration, shake) — end to end: the phone captures and processes its own sensor data, displays it live, and streams the processed values to the monitor over Socket.IO. The monitor shows every device's values, permissions, connection and data freshness side by side, keyed by a stable device identity that survives reconnects.

Network-only: no audio, no SuperCollider; the server always runs with audio disabled (`none` mode). No camera, no microphone, no raw media of any kind — only processed numbers. No hub, no cloud. Stack: Node.js, Express, Socket.IO.

Adapted to the App's trusted-HTTPS entry contract (`scoreServer.supportsPerformerUrl: true`): the same project runs unchanged over plain HTTP, over the App's HTTPS entry, or over a standalone HTTPS trial (below).

### What it verifies

- **Tilt**: the α / β / γ angles the browser actually provides, in degrees, as provided — not a calibrated compass bearing. Missing fields read "unavailable", never 0°.
- **Motion**: the acceleration the browser provides (X/Y/Z, m/s²) with an explicit **incl. gravity / user-accel-only** flag, a motion-intensity magnitude (m/s², smoothed), and a **shake counter** (a threshold crossing with a cooldown — one shake is one).
- **The phone shows what the monitor receives**: the readout on the phone binds to the sample it SENDS — the same values. A reconnect (same origin, same claim token) recovers the same device id; data never crosses devices.
- **Honest freshness**: "live" derives from actual sample timestamps only. A heartbeat can never dress stale data as live; a backgrounded page reads "paused"; a sensor that stopped updating reads "stopped updating"; authorized-but-sampleless reads "waiting for samples".
- **Deliberate capture**: each sensor is enabled by an explicit tap (iOS requires the permission prompt inside a user gesture) and has an explicit stop. Late permission results and late sensor events after a stop never restart or mutate a stopped capture.
- **Bounded rates, fluid display**: capture ≤60 Hz and send ≤30 Hz — two independent gates; only the latest processed sample is ever sent, so a disconnect never replays history. The monitor renders at frame rate (`requestAnimationFrame`), each value exponentially approaching the newest sample — the SuperCollider control-rate idea: low-rate computation, continuous presentation. No rate counters are shown anywhere.
- **No ghost devices**: a device that disconnects stays on the monitor for a short grace window (a network blip must not flicker its card), then leaves the roster — a stray tab or link preview that joined once never sits there forever. Identity is unaffected: the returning phone recovers its device id.

### Units, permissions and states (the short manual)

| Thing | Unit | Notes |
| --- | --- | --- |
| Tilt α / β / γ | degrees (°) | As the browser reports them; `null` renders "unavailable" |
| Acceleration X / Y / Z | m/s² | Gravity flag says which block the browser provided |
| Motion intensity | m/s² | Smoothed magnitude of user acceleration |
| Shake count | count | One per threshold crossing, 600 ms cooldown |

Permissions: on iOS 13+ each sensor asks once per origin inside the Enable tap — "granted", "denied", "unsupported" and "not asked" all render distinctly on the monitor. Denial is a diagnosable result, not an error.

Device states on the monitor: `live` / `waiting for samples` / `stopped updating` / `paused` / `off` / `disconnected` — per sensor, plus the permission chip. A disconnected device's card leaves the roster after a 10 s grace window.

### Getting Started

```sh
npm install
npm start    # performer: http://<Host-LAN-IP>:6868/ · monitor: http://<Host-LAN-IP>:6869/
```

Scan the QR on the monitor with a phone, tap Enable on a sensor, tilt and shake.

### Standalone trusted-HTTPS trial

The point of this project is to prove sensor capture works in a **trusted secure context** — iOS Safari only exposes motion sensors there. Two ways to run it that way; **neither ever installs a certificate on the phone**:

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
                with durable claims, sensor hub, health, QR, lifecycle)
public/         Browser side (dual-role single page + sensor-logic, the
                capture/processing/controller code the tests drive)
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

PNDS 诊断工程：检验手机浏览器提供的两个运动传感器——**倾斜**（设备方向 α/β/γ）与**运动**（加速度、摇动）——的完整链路。手机在自己本地采集与处理、实时显示自身数值，并把处理后的数值经 Socket.IO 送达 monitor；monitor 按稳定设备标识逐台显示数值、权限、连接与数据新鲜度，重连不串设备。

纯网络工程：无音频、无 SuperCollider，始终以 `none` 模式运行。无摄像头、无麦克风、不录不传任何原始媒体——只传处理后的数值。不依赖 hub 或云。

已适配 App 的可信 HTTPS 入口契约（`scoreServer.supportsPerformerUrl: true`）：同一份代码在纯 HTTP、App HTTPS 入口、独立 HTTPS 试验（见下）下行为一致。

### 验证什么

- **倾斜**：浏览器实际提供的 α / β / γ 角度（度），照原样显示——不是校准过的罗盘方向；缺失字段显示「不可用」，绝不补 0°。
- **运动**：浏览器提供的加速度 XYZ（m/s²）+ 明确的**含重力 / 仅用户加速度**标志、运动强度（m/s²，平滑）、**摇动计数**（阈值 + 冷却，摇一下计一下）。
- **手机显示的就是 monitor 收到的**：手机读数绑定它**发送**的那个样本——数值完全相同。断线重连（同 origin、同 claim token）恢复同一设备号，数据不串设备。
- **诚实的新鲜度**：「实时」只由真实样本时间戳决定——心跳冒充不了新样本；页面后台显示「已暂停」；停止更新显示「已停止更新」；授权了但没样本显示「等待样本」。
- **主动采集**：每个传感器由用户点击启用（iOS 要求权限弹窗在用户手势内触发）、显式停止；停止后的迟到授权结果与迟到事件不会重启或改写已停止的采集。
- **限频有界、显示流畅**：采集 ≤60 Hz、发送 ≤30 Hz 两级独立限频；只发送最新处理值，断线不重放历史。monitor 以帧率（`requestAnimationFrame`）渲染，每个数值向最新样本指数逼近——SuperCollider control rate 的思路：低速率计算、连续呈现。页面各处不显示任何速率计数。
- **不留幽灵设备**：设备断开后卡片保留一个短暂宽限期（网络抖动不闪烁），随后从名册消失——误入的标签页或链接预览不会永远占着控制台。身份不受影响：回来的手机恢复原设备号。

### 单位、权限与状态（速查）

| 项目 | 单位 | 说明 |
| --- | --- | --- |
| 倾斜 α / β / γ | 度（°） | 浏览器原样提供；缺失显示「不可用」 |
| 加速度 X / Y / Z | m/s² | 重力标志说明浏览器给的是哪一种 |
| 运动强度 | m/s² | 用户加速度的平滑幅值 |
| 摇动计数 | 次 | 阈值触发 + 600 ms 冷却 |

权限：iOS 13+ 每个 sensor 每个 origin 在「启用」点击时询问一次；「已授权 / 被拒绝 / 不支持 / 未询问」在 monitor 上分别显示——拒绝是可诊断的结果，不是错误。

设备状态：`实时 / 等待样本 / 已停止更新 / 已暂停 / 未采集 / 已断开`（每传感器一列）+ 权限标志。已断开设备的卡片在 10 秒宽限期后从名册消失。

### 快速开始

```sh
npm install
npm start    # performer: http://<Host-LAN-IP>:6868/ · monitor: http://<Host-LAN-IP>:6869/
```

用手机扫 monitor 上的二维码，点「启用」，倾斜、摇动即可。

### 独立可信 HTTPS 试验

本工程的意义在于证明**可信安全上下文**里的传感器链路——iOS Safari 只在那里开放运动传感器。两种方式，**都不要求手机安装任何证书**：

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
                players、sensor hub、health、QR、lifecycle）
public/         浏览器侧（双角色单页 + sensor-logic——测试驱动的采集/处理/控制器代码）
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
