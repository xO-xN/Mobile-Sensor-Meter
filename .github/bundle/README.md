# Mobile Sensor Meter

[中文](README.zh-CN.md) | **English**

A PNDS utility that meters a phone's sensors live: each joined phone captures its own tilt, motion, microphone level and hand pose — the hand model runs on the phone itself, so only numbers ever leave the device — and the monitor shows every device's readings in real time. Network-only: no audio, no SuperCollider; the project always runs with audio disabled (`none` mode).

## How to use

1. In the PNDS App, press **⌘O** (Open) and select this `.pnds` bundle or its
   unzipped folder, then **Load** it. Don't have the App yet? Download it from
   https://github.com/xO-xN/PNDS-App/releases/latest (macOS) — no Node.js
   installation is required, the App bundles everything this tool needs.
2. Put the Mac and the phones on the same local network. For browser
   participation, open the bottom network menu's complete public LAN HTTP URL
   or scan its QR, then explicitly enter the displayed performance. This path
   opens the interface and connection diagnostics; it does not authorize
   secure-context sensor or media capture. Keep the page open.
3. For sensor capture, use the separate existing trusted HTTPS performer
   address on a supported device. Prepare the App's real domain, public-CA
   certificate and local DNS resolution to this Mac, enable its HTTPS entry,
   then open the actual trusted `https://` performer URL for this run. The
   bottom public-entry QR remains HTTP, including when HTTPS is configured.
4. On the supported secure page, enable the cards you need — tilt & motion,
   microphone, hand pose. Every permission is requested inside your tap; a
   denied or late permission is reported as it happened, never retried
   silently. The monitor shows values only when actual samples arrive.

This tool retains `needsHttps: true` for its sensor APIs and full performer-URL
compatibility. Neither that declaration nor saving an icon upgrades the public
HTTP entry or grants capture permission. On that HTTP path, unavailable capture
is reported honestly; use the trusted HTTPS path for secure-context capture.

### Readings, permissions and units

- **Tilt** — the screen-plane angles α / β / γ, in degrees (°).
- **Motion** — acceleration per axis in m/s², plus an overall intensity in
  m/s².
- **Microphone** — RMS and peak as a fraction of digital full scale (FS), the
  level in dBFS with a floor of −90. Uncalibrated: never read as dB SPL. The
  stream is analysis-only (never played back) and is released on stop,
  backgrounding or leaving the page.
- **Hand pose** — the camera frames are processed on the phone by a model
  served from this project's own origin (no CDN); only normalized keypoint
  coordinates ([0, 1], origin at the top-left) and inference timings go on the
  wire — never video. Enabling the card lazily downloads the model (~8.7 MB)
  from this project; the camera is released on stop, backgrounding or leaving
  the page.

Zero is a real reading; "unavailable" means missing data — the two are never
merged. Freshness comes only from real sample timestamps. A disconnected
device's card lingers ten seconds before leaving the roster, and the device
reclaims its number on reconnect.

The monitor follows the App's language and theme; the phone page picks its
language from the device.


Runtime requirements: PNDS App v1.6.2 or a Host supporting the exact shared libraries in manifest.json. The project bundle carries references and project assets; standalone development can still use npm ci --ignore-scripts. See docs/shared-libraries.md in the source repository.

## App performer QR migration

The project has no in-page QR interface or `/qr` endpoint. The performance-mode
bottom network menu shares the public HTTP entry and requires explicit entry into
the displayed performance. Trusted HTTPS capture uses its own configured
performer address; this public QR does not switch to it. Creation device tests
keep their separate Performers button and actual test address. Standalone/direct
access remains available without an in-page QR entry.

## Confirmed Host entry (0.4.5)

On a compatible Host, open the complete address in the bottom network menu,
then explicitly enter the displayed performance. Pages, Socket.IO, the actual
hand-recognition Worker, its shared ml5 runtime and local models keep that
performance context. A stopped or replaced performance cannot reconnect to the
replacement through an old page. Browser recovery tokens are separated by Host
and project; native private-origin recovery and direct standalone access remain.
The Host can assign different internal ports without changing this public entry.

The stable LAN entry is HTTP. It grants no secure-context sensor/media APIs;
saving a Home Screen or desktop icon grants no permissions. Use the existing
trusted HTTPS performer address on a supported physical device for capture that
requires it. `needsHttps: true` is retained. Page preparation means the interface
and actual server join are usable, never that capture was permitted or a sample
was collected. Required libraries and model files are local; no WAN is needed
for the entry or supported local operations after preparation.

Device capture, actual iPhone
permissions and signed native media behavior require separate acceptance.
