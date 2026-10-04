// Mobile Sensor Meter — shared value rendering (both pages).
//
// The performer readout and the monitor cards render the SAME sample
// shapes (tilt angles, motion values), so the zero-vs-null rule lives
// here exactly once: a real zero renders as a number with its unit, a
// missing field renders as the WORD "unavailable" — never folded.
//
// Works as a plain browser global (window.PNDS_RENDER) and as a Node
// module; the copy table T (shared.js `copy.<locale>.performer|monitor`)
// supplies the words — both tables carry the keys these helpers read.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.PNDS_RENDER = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  function row(label, inner) {
    return (
      '<div class="row"><span class="label">' + label + "</span>" + inner + "</div>"
    );
  }

  function naSpan(text) {
    return '<span class="value na">' + text + "</span>";
  }

  function numOrNa(value, unit, T) {
    if (value === null || value === undefined) {
      return naSpan(T.unavailable);
    }

    return '<span class="value">' + value.toFixed(1) + " " + unit + "</span>";
  }

  // The value rows render whatever block they are handed — the raw wire
  // sample on the phone, or the monitor's smoothed display sample. The
  // zero-vs-null rule is identical for both.
  function tiltRows(tilt, T) {
    return (
      row(T.alpha, numOrNa(tilt.alpha, "°", T)) +
      row(T.beta, numOrNa(tilt.beta, "°", T)) +
      row(T.gamma, numOrNa(tilt.gamma, "°", T))
    );
  }

  function motionRows(motion, T) {
    return (
      row("X", numOrNa(motion.x, "m/s²", T)) +
      row("Y", numOrNa(motion.y, "m/s²", T)) +
      row("Z", numOrNa(motion.z, "m/s²", T)) +
      row(
        T.gravityField,
        motion.includesGravity
          ? '<span class="value">' + T.withGravity + "</span>"
          : '<span class="value">' + T.withoutGravity + "</span>",
      ) +
      row(T.intensity, numOrNa(motion.intensity, "m/s²", T)) +
      row(
        T.shake,
        motion.shakeCount === null
          ? naSpan(T.unavailable)
          : '<span class="value">' + motion.shakeCount + "</span>",
      )
    );
  }

  // ------------------------------------------------------------
  // Monitor display leg: frame-rate smoothing + roster visibility
  // ------------------------------------------------------------

  // How long a DISCONNECTED device stays on the monitor before its card
  // disappears. Long enough that a network blip never flickers a card
  // out and back; short enough that a ghost (a link preview, a stray
  // browser tab that joined and left) does not sit in the roster
  // forever. Server-side claims are unaffected — a device returning
  // after the window still recovers its id.
  const DISCONNECTED_HIDE_AFTER_MS = 10000;

  // The ids the monitor renders: connected devices always, disconnected
  // ones only inside the hide window. `now` and the devices' `since`
  // share the server clock (the snapshot's `at`).
  function visibleDeviceIds(devices, now) {
    const ids = [];

    for (const key of Object.keys(devices)) {
      const device = devices[key];

      if (device.connected || now - device.since < DISCONNECTED_HIDE_AFTER_MS) {
        ids.push(Number(device.id));
      }
    }

    return ids.sort((a, b) => a - b);
  }

  // Exponential approach toward the newest sample — the SuperCollider
  // control-rate idea: values are computed at the wire's low rate and
  // presented continuously at frame rate. dt-based, so frame jitter
  // changes only the pace, never the shape.
  function approach(current, target, dtMs, tauMs) {
    const alpha = 1 - Math.exp(-Math.max(dtMs, 0) / tauMs);
    return current + alpha * (target - current);
  }

  // The same across the α wrap (0°/360°): approach along the shortest
  // path and wrap the result back into [0, 360).
  function approachAngle(current, target, dtMs, tauMs) {
    const alpha = 1 - Math.exp(-Math.max(dtMs, 0) / tauMs);
    const delta = (((target - current) % 360) + 540) % 360 - 180;
    return (current + alpha * delta + 360) % 360;
  }

  // Advances one numeric display field toward its target; a null on
  // either side is a FACT (the zero-vs-null rule) and passes through
  // unsmoothed.
  function approachField(current, target, dtMs, tauMs, wrap) {
    if (current === null || current === undefined) {
      return target;
    }

    if (target === null || target === undefined) {
      return null;
    }

    return wrap
      ? approachAngle(current, target, dtMs, tauMs)
      : approach(current, target, dtMs, tauMs);
  }

  return {
    row,
    naSpan,
    numOrNa,
    tiltRows,
    motionRows,
    DISCONNECTED_HIDE_AFTER_MS,
    visibleDeviceIds,
    approach,
    approachAngle,
    approachField,
  };
});
