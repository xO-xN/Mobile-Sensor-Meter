// Mobile Sensor Diagnostics — shared value rendering (both pages).
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

  function seqRow(seq, T) {
    return row(T.seq, '<span class="value">#' + seq + "</span>");
  }

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

  return { row, naSpan, numOrNa, seqRow, tiltRows, motionRows };
});
