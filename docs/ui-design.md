# Mobile Sensor instrument panels — v0.3.1

The canonical UI is in `public/monitor.js`, `public/performer.js`,
`public/style.css`, and `public/shared.js`. It extends the other PNDS utilities'
fog/teal palette, system typography and SF Mono readings. A full-width device
panel identifies one phone, followed by four sensor sections. The hierarchy is
device identity → capture/permission/freshness → processed readings. Wide screens
use four sensor columns, medium screens two, and narrow screens one.

The header count includes connected devices only; disconnected records retain
the original 10-second grace window. The footer's native Join devices disclosure
contains the QR and the same resolved performer URL used by the server. No new
sample-based summaries, fake meters or third rate gate are introduced. Numeric
zero and zero hands remain results; missing fields still say unavailable.

The monitor-only `theme.js` consumes the same App palette contract as Local
Diagnostics. State chips paint text on the card surface for readable status
colors across all themes. Brutal geometry follows `data-utility-theme`; reduced
motion removes CSS transitions. Phone pages keep the project's default palette
and device-language selection. The camera preview remains CSS-mirrored, while
coordinate data remains unmirrored. Skeletons use a pale green line on the dark
preview surface. All local ml5/models and their pinned hashes remain intact.

Permission/recovery notes are linked to native Enable/Stop buttons with
`aria-describedby`; pressed state follows the existing capture-intent predicate.
No authorization or capture API is called outside the existing user gesture.
The monitor preserves keypoint disclosure openness and keyboard position when
its card shape or locale changes; value frames still never rebuild disclosures.
All controller lifetime/epoch/attempt and resource-release logic is unchanged.

`test/monitor.test.js`, `test/performer.test.js`, and `test/theme.test.js` cover
these behaviors alongside the original sample, permission and resource tests.
Mobile Sensor is still outside the published `utilities.json` release registry;
this UI preview does not change that release/acceptance status.
