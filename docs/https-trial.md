# Standalone trusted-HTTPS trial — preconditions and method

The sensors this project diagnoses are only exposed to a **trusted
secure context** in mobile Safari (and increasingly in Chrome). Running
the page over plain LAN HTTP proves nothing about the real entry path.
This note records how to run the SAME project under a locally trusted
HTTPS origin **without the PNDS App** and, above all, **without
installing any certificate on any phone**.

## Preconditions (all three, or the trial proves nothing)

1. **A real DNS domain you control** — e.g. `sensor.example.org`.
   Public CAs do not issue for IP literals, `.local` names or intranet
   hostnames.
2. **A public-CA certificate for that domain** — full chain
   (`fullchain.pem`: leaf + intermediates) and matching key
   (`privkey.pem`). Let's Encrypt **DNS-01** issuance needs no public
   web server: sign and renew online, then use the files locally. A
   self-signed certificate or a private CA is **not** a success path —
   phones do not trust them, and the point of the trial is a trusted
   context with zero phone-side setup.
3. **Local DNS for the trial network** — the venue router (or whatever
   DNS the phones receive via DHCP) must resolve the domain to this
   Mac's LAN address. Phones must not need per-device DNS edits.

## Method

### 1. TLS terminator in front of the performer port

Any local reverse proxy with TLS works. With Caddy:

```
sensor.example.org:8443 {
  tls /path/to/fullchain.pem /path/to/privkey.pem
  reverse_proxy 127.0.0.1:6868
}
```

WebSocket upgrade must be proxied (Socket.IO's realtime leg); Caddy and
nginx do this by default.

### 2. Start the project with the entry URL

```sh
PNDS_HOST_IP=<this Mac's LAN IP> \
PNDS_PERFORMER_URL=https://sensor.example.org:8443/ \
npm start
```

`PNDS_PERFORMER_URL` is the single source the QR code, the monitor's
copyable address and the browser `__config.js` all read — one spelling,
no drift (runtime-contract §15). The performer page connects
**same-origin**, so it rides the HTTPS origin transparently; the
monitor page stays on its internal plain-HTTP port and connects
cross-port to the performer server, exactly as inside the App.

### 3. Trial checklist

- Scan the QR on the monitor with the target phone: page loads with
  **no certificate warning** and no profile installed.
- Tap **Enable** on Tilt, then on Motion: the iOS permission prompt
  appears inside the tap; grant both.
- Tilt the phone: α/β/γ on the phone and on the monitor move together,
  same sample numbers.
- Shake the phone: the shake counter increments once per shake on both
  ends; the intensity magnitude spikes.
- Background the phone: the monitor flips the device to **paused**;
  return: it resumes (sensors left on) — stopped ones stay stopped.
- Lock/lose the network: the device reads **disconnected**; reconnect
  by re-scanning or reloading: the **same device id** recovers, its
  row does not reset, and no values cross to another device.
- Two phones side by side: two device cards, each showing only its own
  numbers.

## What this trial does and does not prove

It proves the phone-side pipeline: secure-context permissions, capture,
on-device processing, and LAN Socket.IO delivery of processed values.
It does **not** prove the PNDS App's HTTPS gateway (listener lifecycle,
entry states, switching isolation) — that is the App-integration
acceptance, run with the same project inside the App once its trusted
HTTPS entry is prepared (see the App's `docs/zh-CN/reference/https.md`).
