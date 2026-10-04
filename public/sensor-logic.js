// Mobile Sensor Meter — browser-side sensor logic.
//
// Plain script, no imports: loaded as window.SensorLogic on the performer
// page, require()d by the Node tests (the "API stand-in" harness drives
// this exact code with fake event sources, fake permission requesters and
// a fake clock — what the tests prove is what the phone runs).
//
// Layers (spec #142: only the latest processed sample ever goes on the
// wire, so a disconnect never replays history):
//
//   raw events ──capture gate (≤60 Hz)──▶ MotionProcessor / tilt sanitize
//             ──seq++──▶ latest processed sample
//             ──send gate (≤30 Hz)──▶ onSend (wire + the phone's own
//                                    value readout — the sample the
//                                    phone DISPLAYS is the sample the
//                                    monitor RECEIVES, seq included)
//
// There is deliberately no third "display" gate on the phone: the
// 30 Hz send path IS the phone's readout rate, and the monitor renders
// at frame rate, exponentially smoothing toward the newest sample —
// the SuperCollider control-rate idea (compute at a low rate, present
// continuously). Rate counters are not shown anywhere; smoothness is
// the deliverable, not telemetry about it.
//
// Guards the spec demands and this module enforces:
// - Zero is a valid reading; null is "field not provided". They are
//   never folded together — every value travels as number-or-null and
//   the displays render null as "unavailable".
// - Every capture has an epoch. A raw event from a stopped capture is a
//   late result and is dropped; a permission result arriving after the
//   user stopped (or started again) never restarts or re-attaches.
// - Paused pages (backgrounded) process nothing and send nothing.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.SensorLogic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const TILT = "tilt";
  const MOTION = "motion";
  const SENSOR_IDS = [TILT, MOTION];

  // Rate limits (ms between passes). Capture passes the full device
  // cadence (~60 Hz on iOS); the wire carries every other processed
  // sample (~30 Hz) — enough for the monitor's frame-rate smoothing to
  // read as continuous motion.
  const CAPTURE_MIN_INTERVAL_MS = 16; // ~60 Hz
  const SEND_MIN_INTERVAL_MS = 33; // ~30 Hz

  // Motion processing tuning. Shake: a user-acceleration magnitude above
  // SHAKE_THRESHOLD_MS2 (m/s²; ~1.5 g over Earth gravity) counts once,
  // then the counter is deaf for SHAKE_COOLDOWN_MS so one shake is one.
  // The gravity estimate low-passes at GRAVITY_TAU_MS when the browser
  // reports gravity-including acceleration; INTENSITY_EMA_MS smooths the
  // displayed intensity. Defaults are starting points for real-device
  // measurement, not promises (spec: budgets come from measurement).
  const SHAKE_THRESHOLD_MS2 = 15;
  const SHAKE_COOLDOWN_MS = 600;
  const GRAVITY_TAU_MS = 500;
  // A quiet gap is REST, not evidence: without this cap, the first
  // sample after a long gap would fast-forward the gravity estimate
  // most of the way toward itself (α grows with dt) and swallow exactly
  // the sharp spike a shake produces. Fresh samples move the estimate
  // at the steady-rate pace, gap or no gap.
  const GRAVITY_DT_CAP_MS = 100;
  const INTENSITY_EMA_MS = 200;

  // ------------------------------------------------------------
  // Value sanitization — zero vs missing
  // ------------------------------------------------------------

  function readNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // ------------------------------------------------------------
  // Rate limiting
  // ------------------------------------------------------------

  // Returns a gate: gate(now) === true means "pass now". Watermark-based
  // (the first call always passes; a long quiet stretch does not bank
  // passes). Each layer owns its own gate — the limits never share.
  function makeGate(minIntervalMs) {
    let last = -Infinity;

    return function gate(now) {
      if (now - last < minIntervalMs) {
        return false;
      }

      last = now;
      return true;
    };
  }

  // ------------------------------------------------------------
  // Tilt (deviceorientation): display what the browser provides
  // ------------------------------------------------------------

  // α/β/γ travel as provided — no wrapping, no calibration, no fusion
  // into a compass heading (spec: the angles are the browser's, not an
  // oriented bearing). Per-field null means "not provided" and renders
  // as unavailable, never as 0°.
  function sanitizeTilt(raw) {
    return {
      alpha: readNumber(raw.alpha),
      beta: readNumber(raw.beta),
      gamma: readNumber(raw.gamma),
    };
  }

  // ------------------------------------------------------------
  // Motion (devicemotion): gravity split, intensity, shake counting
  // ------------------------------------------------------------

  class MotionProcessor {
    constructor(options = {}) {
      this.shakeThresholdMs2 =
        typeof options.shakeThresholdMs2 === "number"
          ? options.shakeThresholdMs2
          : SHAKE_THRESHOLD_MS2;
      this.shakeCooldownMs =
        typeof options.shakeCooldownMs === "number"
          ? options.shakeCooldownMs
          : SHAKE_COOLDOWN_MS;

      this.gravity = null; // low-pass gravity estimate [x, y, z]
      this.gravityAt = null;
      this.intensity = null; // EMA of user-acceleration magnitude
      this.shakeCount = 0;
      this.lastShakeAt = null;
    }

    // Feed one raw motion event block ({x, y, z, includesGravity,
    // interval, at}); returns the processed sample or null when no
    // acceleration field is provided at all (a motion event with no
    // data is not a sample).
    feed(block) {
      const x = readNumber(block.x);
      const y = readNumber(block.y);
      const z = readNumber(block.z);

      if (x === null && y === null && z === null) {
        return null;
      }

      const includesGravity = block.includesGravity === true;
      const at = readNumber(block.at);
      const dt =
        at !== null && this.gravityAt !== null ? Math.max(at - this.gravityAt, 0) : null;

      let user = null;

      if (x !== null && y !== null && z !== null) {
        if (includesGravity) {
          // Track gravity with an exponential low-pass (τ from the
          // inter-sample gap, capped — a long gap must not turn one
          // fresh sample into a gravity jump).
          if (this.gravity === null) {
            this.gravity = [x, y, z];
            this.gravityAt = at;
          } else if (dt !== null) {
            const alpha =
              1 - Math.exp(-Math.min(dt, GRAVITY_DT_CAP_MS) / GRAVITY_TAU_MS);
            const observed = [x, y, z];
            for (let axis = 0; axis < 3; axis += 1) {
              this.gravity[axis] += alpha * (observed[axis] - this.gravity[axis]);
            }
            this.gravityAt = at;
          }

          user = {
            x: x - this.gravity[0],
            y: y - this.gravity[1],
            z: z - this.gravity[2],
          };
        } else {
          // The browser already removed gravity.
          user = { x, y, z };
        }

        const magnitude = Math.sqrt(
          user.x * user.x + user.y * user.y + user.z * user.z,
        );

        if (this.intensity === null) {
          this.intensity = magnitude;
        } else if (dt !== null) {
          const beta = 1 - Math.exp(-dt / INTENSITY_EMA_MS);
          this.intensity += beta * (magnitude - this.intensity);
        } else {
          this.intensity = magnitude;
        }

        if (
          magnitude > this.shakeThresholdMs2 &&
          (this.lastShakeAt === null ||
            (at !== null && at - this.lastShakeAt >= this.shakeCooldownMs))
        ) {
          this.shakeCount += 1;
          this.lastShakeAt = at;
        }
      }

      return {
        x,
        y,
        z,
        includesGravity,
        intensity: this.intensity,
        shakeCount: this.shakeCount,
      };
    }
  }

  // ------------------------------------------------------------
  // The per-sensor controller
  // ------------------------------------------------------------

  // platform (all injectable; the performer page passes the real ones):
  //   now()                    monotonic-ish ms clock
  //   addEventListener(type, fn) / removeEventListener(type, fn)
  //   orientationEvent / motionEvent — the page's DeviceOrientationEvent /
  //   DeviceMotionEvent globals (may be undefined on the platform)
  //
  // callbacks:
  //   onState(sensor, state)          — capture-state changes
  //   onPermission(sensor, permission)— a permission fact (denied,
  //                                     unsupported, late results)
//   onStart(sensor) / onStop(sensor, lastSample) — capture went live /
//                                     ended (server notifications)
//   onSend(sensor, sample, seq)     — send-gated latest values (the
//                                     phone's readout rides this too)
  class SensorController {
    constructor(platform, callbacks = {}) {
      this.platform = platform;
      this.callbacks = callbacks;

      this.paused = false;
      this.sensors = {
        [TILT]: blankControllerSensor(TILT, platform),
        [MOTION]: blankControllerSensor(MOTION, platform),
      };
    }

    stateOf(sensor) {
      const record = this.sensors[sensor];
      return record ? record.state : "off";
    }

    // The user's explicit enable. Must be called from a user gesture on
    // iOS (the permission request requires one).
    start(sensor) {
      const record = this.sensors[sensor];
      if (!record) {
        return;
      }

      if (record.state === "on" || record.state === "starting") {
        return;
      }

      record.attempt += 1; // supersedes any in-flight permission result
      const attempt = record.attempt;

      const eventGlobal =
        sensor === TILT
          ? this.platform.orientationEvent
          : this.platform.motionEvent;

      if (!eventGlobal) {
        record.state = "unsupported";
        this.emit("onPermission", sensor, "unsupported");
        return;
      }

      if (typeof eventGlobal.requestPermission !== "function") {
        // No permission gate on this platform (Android, desktops, old
        // iOS): sensors are simply readable.
        this.attach(sensor, attempt, "granted");
        return;
      }

      record.state = "starting";
      this.emit("onState", sensor, record.state);

      eventGlobal
        .requestPermission()
        .then((result) => {
          if (record.attempt !== attempt) {
            // A LATE permission result: the user stopped (or restarted)
            // while the dialog was open. The fact may be reported, the
            // capture is NEVER (re)started by it (spec #142).
            this.emit("onPermission", sensor, result === "granted" ? "granted" : "denied");
            return;
          }

          if (result === "granted") {
            this.attach(sensor, attempt, "granted");
          } else {
            record.state = "denied";
            this.emit("onState", sensor, record.state);
            this.emit("onPermission", sensor, "denied");
          }
        })
        .catch(() => {
          if (record.attempt !== attempt) {
            return;
          }

          record.state = "error";
          this.emit("onState", sensor, record.state);
        });
    }

    // The user's explicit stop (or shutdown). In-flight permission
    // results and queued sensor events from this capture become late
    // results — epoch + attempt see to both.
    stop(sensor) {
      const record = this.sensors[sensor];
      if (!record) {
        return;
      }

      record.attempt += 1;

      if (record.attached) {
        this.platform.removeEventListener(record.eventType, record.handler);
        record.attached = false;
      }

      record.epoch += 1;
      const was = record.state;
      record.state = "off";

      if (was === "on" || was === "starting") {
        this.emit("onStop", sensor, record.lastSample);
      }
      this.emit("onState", sensor, record.state);
    }

    stopAll() {
      for (const sensor of SENSOR_IDS) {
        this.stop(sensor);
      }
    }

    // Page visibility: backgrounded pages process and send nothing. On
    // resume, only sensors that were left on resume — a user-stopped
    // sensor stays stopped (no restart, ever).
    pause() {
      if (this.paused) {
        return;
      }

      this.paused = true;
    }

    resume() {
      this.paused = false;
    }

    // ------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------

    attach(sensor, attempt, permission) {
      const record = this.sensors[sensor];

      record.epoch += 1; // samples from any earlier capture are late
      record.seq = 0;
      record.processor = sensor === MOTION ? new MotionProcessor() : null;
      record.lastSample = null;
      record.handler = (event) => this.onRawEvent(sensor, record.epoch, event);
      record.attached = true;
      // A fresh capture gets fresh gates — a capture starting right
      // after a stop must not inherit the old capture's throttle
      // watermarks and lose its first samples to them.
      record.captureGate = makeGate(CAPTURE_MIN_INTERVAL_MS);
      record.sendGate = makeGate(SEND_MIN_INTERVAL_MS);
      this.platform.addEventListener(record.eventType, record.handler);

      record.state = "on";
      this.emit("onState", sensor, record.state);
      this.emit("onStart", sensor, permission);
    }

    onRawEvent(sensor, epoch, event) {
      const record = this.sensors[sensor];

      // Late event: the capture this listener belonged to is gone
      // (stopped, or restarted under a new epoch).
      if (!record || record.state !== "on" || record.epoch !== epoch) {
        return;
      }

      if (this.paused) {
        return;
      }

      const raw =
        sensor === TILT ? readTiltEvent(event) : readMotionEvent(event);

      if (raw === null) {
        return;
      }

      const now = this.platform.now();

      if (!record.captureGate(now)) {
        return;
      }

      let sample;

      if (sensor === TILT) {
        sample = sanitizeTilt(raw);
      } else {
        sample = record.processor.feed({ ...raw, at: now });
        if (sample === null) {
          return; // an event with no acceleration fields is not a sample
        }
      }

      record.seq += 1;
      record.lastSample = sample;

      if (record.sendGate(now)) {
        // Only the LATEST processed sample ever goes out — nothing is
        // queued between sends, so a reconnect cannot replay history.
        this.emit("onSend", sensor, sample, record.seq);
      }
    }

    emit(name, ...args) {
      const callback = this.callbacks[name];
      if (typeof callback === "function") {
        callback(...args);
      }
    }
  }

  function blankControllerSensor(sensor, platform) {
    return {
      sensor,
      state: "off",
      attempt: 0,
      epoch: 0,
      seq: 0,
      attached: false,
      handler: null,
      processor: null,
      lastSample: null,
      eventType: sensor === TILT ? "deviceorientation" : "devicemotion",
      captureGate: makeGate(CAPTURE_MIN_INTERVAL_MS),
      sendGate: makeGate(SEND_MIN_INTERVAL_MS),
    };
  }

  // deviceorientation: the three angles, as provided, nulls preserved.
  function readTiltEvent(event) {
    // An all-null tilt (some engines fire one before any data exists)
    // is not a sample; an event carrying no tilt fields at all is not
    // one either. Everything else passes through untouched — partial
    // nulls are per-field facts the sanitizer keeps.
    if (event.alpha === null && event.beta === null && event.gamma === null) {
      return null;
    }

    if (
      event.alpha === undefined &&
      event.beta === undefined &&
      event.gamma === undefined
    ) {
      return null;
    }

    return { alpha: event.alpha, beta: event.beta, gamma: event.gamma };
  }

  // devicemotion: prefer the browser's user acceleration; fall back to
  // the gravity-including block when the user block carries no fields
  // (the common Safari shape). Whichever block is used, the
  // includesGravity flag says which it was — the monitor renders it.
  function readMotionEvent(event) {
    const user = event.acceleration;
    const withGravity = event.accelerationIncludingGravity;

    const userHasField =
      user &&
      (readNumber(user.x) !== null ||
        readNumber(user.y) !== null ||
        readNumber(user.z) !== null);
    const gravityHasField =
      withGravity &&
      (readNumber(withGravity.x) !== null ||
        readNumber(withGravity.y) !== null ||
        readNumber(withGravity.z) !== null);

    if (userHasField) {
      return {
        x: user.x,
        y: user.y,
        z: user.z,
        includesGravity: false,
        interval: event.interval,
      };
    }

    if (gravityHasField) {
      return {
        x: withGravity.x,
        y: withGravity.y,
        z: withGravity.z,
        includesGravity: true,
        interval: event.interval,
      };
    }

    return null;
  }

  return {
    SENSOR_IDS,
    TILT,
    MOTION,
    CAPTURE_MIN_INTERVAL_MS,
    SEND_MIN_INTERVAL_MS,
    SHAKE_THRESHOLD_MS2,
    SHAKE_COOLDOWN_MS,
    readNumber,
    makeGate,
    sanitizeTilt,
    MotionProcessor,
    SensorController,
    readTiltEvent,
    readMotionEvent,
  };
});
