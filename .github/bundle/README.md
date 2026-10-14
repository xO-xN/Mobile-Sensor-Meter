# Mobile Sensor Meter

[中文](README.zh-CN.md) | **English**

A PNDS utility that meters a phone's sensors live: each joined phone captures its own tilt, motion, microphone level and hand pose — the hand model runs on the phone itself, so only numbers ever leave the device — and the monitor shows every device's readings in real time. Network-only: no audio, no SuperCollider; the project always runs with audio disabled (`none` mode).

## How to use

1. In the PNDS App, press **⌘O** (Open) and select this `.pnds` bundle or its
   unzipped folder, then **Load** it. Don't have the App yet? Download it from
   https://github.com/xO-xN/PNDS-App/releases/latest (macOS) — no Node.js
   installation is required, the App bundles everything this tool needs.
2. Put the Mac and the phones on the same network. The camera and the
   microphone need HTTPS: start the App's trusted HTTPS entry (a real domain
   with a public certificate) and let the router's DNS resolve that domain to
   this Mac, then the QR code carries the trusted `https://` address. Over
   plain HTTP those two cards read "unsupported" — by design.

   This tool explicitly declares `needsHttps: true` because of its sensor
   APIs; ordinary touch and QR projects use HTTP by default. The App chooses
   the address shared by the QR and page connection configuration.
3. Expand **Join devices** at the bottom of the monitor and scan the QR code on
   each phone; keep the page open.
4. On the phone, enable the cards you need — tilt & motion, microphone, hand
   pose. Every permission is requested inside your tap; a denied or late
   permission is reported as it happened, never retried silently. The monitor
   shows each device's live values.

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


Runtime requirements: PNDS App v1.6.2 or a Host supporting the exact shared libraries in manifest.json. The project bundle carries references and project assets; standalone development can still use npm ci. See docs/shared-libraries.md in the source repository.
