/**
 * VDO.Ninja Lossless DC AudioWorklet v1.0.28.
 *
 * GENERATED FILE — do not edit by hand. Regenerate via:
 *   npm run build:worklet
 * Sources:
 *   sidecar/src/playout.js  (canonical playout chain — shared with Node)
 *   sidecar/browser/audio-worklet.template.js  (AudioWorklet I/O wiring)
 *
 * The playout chain (arming gate, ring buffer, cosine concealment, drift
 * servo, re-arm trim, LP filter, cooldown, xfade) is defined in playout.js
 * so the sidecar receive path can run the exact same chain when it gets
 * wired up in Pass 6b-B. Browser listeners keep zero runtime dependency on
 * the sidecar: the chain is inlined here at build time and shipped as one
 * file via GitHub Pages.
 *
 * Version-by-version playout history (preserved from v1.0.21):
 *   v1.0.16 (Step 8, Layer A): single user-controlled target buffer level.
 *   v1.0.17 (Step 5, Layer B): cosine fade-out/fade-in concealment.
 *   v1.0.18 (Step 6, Layer C): RemSound-style drift integrator.
 *   v1.0.19 — REVERTED. filledLp = target on re-arm exploded skip rate.
 *   v1.0.20: filledLp re-initialised to current _filled on (re-)arm.
 *   v1.0.21: re-arm trims stale queued audio + drift gating after re-arm.
 *   v1.0.24: fixed-ratio linear resampler replaces steady-state splices.
 *   v1.0.25: bounded rate estimator, arm cushion, and partial-shortfall clamp.
 *   v1.0.26: freeze at trusted ratio, disable fill-driven ppm nudging, confirm learning.
 *   v1.0.27: keep long-term clock learning alive through playout disturbances.
 *   v1.0.28: expose drift learner measured/pending ratios for diagnostics.
 */

'use strict';

/**
 * Lossless DC receiver-side playout chain.
 *
 * Canonical, source-time-mirrored implementation of the playout state machine
 * that v1.0.21's AudioWorklet ran inline. Same chain is consumed by:
 *
 *   - Browser listener (sidecar/browser/audio-worklet.js, concatenated by
 *     sidecar/scripts/build-worklet.js). No runtime dependency on this file
 *     once concatenated — listeners on plain VDO.Ninja never see a sidecar.
 *   - Node sidecar receive path (wired in a later pass; today this module is
 *     defined and tested but not yet consumed by sidecar/src/lossless-dc.js).
 *
 * Public API:
 *   new PlayoutChain({ sampleRate, channels, targetFrames, emit, ringSize })
 *   enqueue(samplesOrArrayBuffer, srcChannels)
 *   renderQuantum(output /* Float32Array[] per channel *\/, quantum?)
 *   setTarget(frames)
 *   getStats() — snapshot of internal counters / drift state
 *
 * The owner supplies an `emit(msg)` callback. The chain calls it with the same
 * messages the worklet used to postMessage:
 *   { type: 'underrun', filled, needed, target }
 *   { type: 'arming', armed, filled, ringSize, target }
 *   { type: 'buffer', filled, ringSize, target }
 *   { type: 'drift', action, skips, repeats, acc, filled }
 *   { type: 'rearm-trim', dropped, totalDropped, filled, target }
 *
 * Behaviour matches viewer/worklet v1.0.21. See sidecar/browser/audio-worklet.js
 * header for the version-by-version playout history (Steps 4, 5, 6, 6 refine).
 */

const DEFAULT_TARGET_FRAMES = 1440;  // 30 ms @ 48 kHz
const DEFAULT_PACKET_FRAMES = 480;   // 10 ms @ 48 kHz; updated from observed frames.
const MIN_TARGET_FRAMES = 240;       //  5 ms @ 48 kHz
const MAX_TARGET_FRAMES = 14400;     // 300 ms @ 48 kHz
const REARM_UNDERRUN_TICKS = 8;
const BUFFER_STATUS_TICKS = 50;
const CONCEAL_FADE_FRAMES = 32;      // ~0.67 ms @ 48 kHz — RemSound ConcealFadeFramesShort.
const CLICK_TRIM_FADE_FRAMES = 32;   // Crossfade span for the click-trim splice (same shape).

// Legacy discrete drift integrator constants. The Phase-4 path below keeps
// these exports and counters for compatibility, but steady-state correction is
// handled by the fixed-ratio linear resampler instead of skip/repeat splices.
const DRIFT_GAIN_BASE = 0.005;
const DRIFT_SMALL_ERROR_FRAMES = 50;
const DRIFT_MAX_GAIN_SCALE = 20;
const DRIFT_ACC_CLAMP = 100;
const DRIFT_XFADE_FRAMES = 8;
const DRIFT_REARM_HOLD_TICKS = 375;   // ~1 s at 128-frame / 48 kHz quanta.
const DRIFT_MIN_EVENT_TICKS = 32;     // Spread corrections; no skip/repeat bursts.
// LP-filter alpha for filled, per-quantum. tau ≈ dt / alpha. At alpha=0.0025
// and dt = 128/48000, tau ≈ 1.07 s — long enough to bury the 10 ms WebRTC
// burst sawtooth, fast enough to track drift on a few-second timescale.
const DRIFT_FILL_ALPHA = 0.0025;

// Fixed-ratio resampler drift correction. Ratio > 1 consumes input faster,
// ratio < 1 stretches input. The counter window estimates sender/receiver
// clock ratio. Buffer-fill error is diagnostic only; it must not modulate pitch.
const RESAMPLER_WINDOW_SEC = 30.0;
const RESAMPLER_FIRST_WINDOW_SEC = 30.0;
const RESAMPLER_RATIO_SMOOTHING_NEW = 0.15;
const RESAMPLER_RATIO_MIN = 0.995;       // +/-5000 ppm sanity reject.
const RESAMPLER_RATIO_MAX = 1.005;
const RESAMPLER_MEASURED_MAX_PPM = 500;  // Reject non-clock outliers, not real device drift.
const RESAMPLER_MEASURED_DEADBAND_PPM = 40;
const RESAMPLER_LEARN_CONFIRM_WINDOWS = 2;
const RESAMPLER_LEARN_AGREE_PPM = 75;
const RESAMPLER_LEARN_MAX_STEP_PPM = 50;
const RESAMPLER_FILL_CORRECTION_SEC = 30.0;
const RESAMPLER_FILL_MAX_PPM = 0;        // Do not let buffer fill modulate pitch.
const RESAMPLER_RATIO_SLEW = 0.0025;     // About 1 s time constant at 48k/128.
const RESAMPLER_STABLE_HOLD_SEC = 5.0;
const LATENCY_TRIM_ARM_SEC = 2.0;
const LATENCY_TRIM_STABLE_SEC = 0.5;

function clampTarget(n) {
  if (!Number.isFinite(n)) return DEFAULT_TARGET_FRAMES;
  return Math.max(MIN_TARGET_FRAMES, Math.min(MAX_TARGET_FRAMES, Math.round(n)));
}

class PlayoutChain {
  constructor(opts) {
    const o = opts || {};
    this.sampleRate = o.sampleRate || 48000;
    this._channels = o.channels || 2;
    const initialTarget = o.targetFrames != null ? o.targetFrames : o.armingTargetFrames;
    this.currentTargetFrames = clampTarget(initialTarget != null ? initialTarget : DEFAULT_TARGET_FRAMES);
    this._emit = typeof o.emit === 'function' ? o.emit : function () {};

    this._ringSize = o.ringSize || 16384;
    this._ring     = new Array(this._channels).fill(null).map(() => new Float32Array(this._ringSize));
    this._writePos = 0;
    this._readPos  = 0;
    this._filled   = 0;
    this._armed = false;
    this._consecutiveUnderruns = 0;
    this._partialUnderruns = 0;
    this._statusTicks = 0;

    this._lastOutSample = new Float32Array(this._channels);
    this._inConcealment = false;
    this._fadeInOnNextRead = false;
    this._lastPacketFrames = DEFAULT_PACKET_FRAMES;
    this._rearmTrimFrames = 0;

    // Click-trim (RemSound SessionPlayout.cs, Phase-4 safety net). Fires when
    // fill exceeds target + trimMargin so the latency contract is preserved
    // when concealment, write bursts, or any other accumulation pushed the
    // ring beyond what the drift integrator can drain in a tolerable window.
    // Caller can override the margin; default scales with target so small
    // targets (low-latency mode) snap sooner and large targets absorb more.
    this._clickTrimMarginFrames = o.clickTrimMarginFrames != null
      ? Math.max(0, Math.round(o.clickTrimMarginFrames))
      : null;  // null = compute lazily from current target + packet size.
    this._clickTrimFrames = 0;
    this._clickTrimFires = 0;
    this._pendingClickTrimXfade = false;
    this._renderFramesSinceArm = 0;
    this._renderFramesSinceDisturbance = 0;

    // Drift / resampler state. The old skip/repeat counters stay exposed so
    // existing overlay and harness parsing remains stable; the Phase-4 path
    // should leave them at zero in steady state.
    this._driftAcc = 0;
    this._filledLp = 0;
    this._filledLpInit = false;
    this._driftSkips = 0;
    this._driftRepeats = 0;
    this._driftHoldTicks = 0;
    this._driftEventCooldownTicks = 0;
    this._driftXfade = new Float32Array(DRIFT_XFADE_FRAMES);
    for (let k = 0; k < DRIFT_XFADE_FRAMES; k++) {
      this._driftXfade[k] = 0.5 * (1 - Math.cos(Math.PI * (k + 1) / DRIFT_XFADE_FRAMES));
    }

    this._resampleFrac = 0;
    this._framesWrittenForRate = 0;
    this._framesOutputForRate = 0;
    this._rateWindowStartOutput = 0;
    this._rateWindowStartWritten = 0;
    this._rateWindowActive = false;
    this._rateWindowDisturbed = false;
    this._resamplerActivelyTracking = false;
    this._resamplerUpdates = 0;
    this._measuredRateRatio = 1.0;
    this._baseRateRatio = 1.0;
    this._trustedRateRatio = 1.0;
    this._pendingRateRatio = 1.0;
    this._pendingRateConfirmations = 0;
    this._targetRateRatio = 1.0;
    this._appliedRateRatio = 1.0;
    this._lastFillCorrectionPpm = 0;
    this._stableRenderFrames = 0;
    this._resamplerFillArmed = false;
  }

  enqueue(samples, srcChannels) {
    const interleaved = samples instanceof Float32Array
      ? samples
      : new Float32Array(samples);
    const sc = srcChannels || this._channels;
    const frames = Math.floor(interleaved.length / sc);
    if (frames > 0) this._lastPacketFrames = frames;
    this._framesWrittenForRate += frames;

    for (let f = 0; f < frames; f++) {
      const wp = (this._writePos + f) % this._ringSize;
      for (let c = 0; c < this._channels; c++) {
        const sci = c < sc ? c : sc - 1;
        this._ring[c][wp] = interleaved[f * sc + sci];
      }
    }
    const nextFilled = this._filled + frames;
    this._writePos = (this._writePos + frames) % this._ringSize;
    if (nextFilled > this._ringSize) {
      const overflow = nextFilled - this._ringSize;
      this._readPos = (this._readPos + overflow) % this._ringSize;
      this._filled = this._ringSize;
    } else {
      this._filled = nextFilled;
    }
  }

  setTarget(frames) {
    const next = clampTarget(frames);
    if (next === this.currentTargetFrames) return;
    this.currentTargetFrames = next;
    // Runtime target moves belong to the buffer manager / future auto-tune
    // layer. The drift servo must not turn a target jump into a skip/repeat
    // burst.
    this._driftAcc = 0;
    this._filledLpInit = false;
    this._driftHoldTicks = DRIFT_REARM_HOLD_TICKS;
    this._driftEventCooldownTicks = DRIFT_MIN_EVENT_TICKS;
    this._rateWindowDisturbed = true;
    this._emit({ type: 'buffer', filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
  }

  getStats() {
    return {
      armed: this._armed,
      filled: this._filled,
      target: this.currentTargetFrames,
      servoTarget: this._servoTargetFrames(),
      ringSize: this._ringSize,
      driftSkips: this._driftSkips,
      driftRepeats: this._driftRepeats,
      driftAcc: this._driftAcc,
      filledLp: this._filledLp,
      driftHoldTicks: this._driftHoldTicks,
      driftEventCooldownTicks: this._driftEventCooldownTicks,
      rearmTrimFrames: this._rearmTrimFrames,
      partialUnderruns: this._partialUnderruns,
      clickTrimFrames: this._clickTrimFrames,
      clickTrimFires: this._clickTrimFires,
      clickTrimThreshold: this.currentTargetFrames + this._effectiveClickTrimMargin(),
      clickTrimLatencyThreshold: this._latencyTrimThresholdFrames(),
      clickTrimStableSec: this._renderFramesSinceDisturbance / this.sampleRate,
      lastPacketFrames: this._lastPacketFrames,
      resamplerRatio: this._appliedRateRatio,
      resamplerBaseRatio: this._baseRateRatio,
      resamplerTrustedRatio: this._trustedRateRatio,
      resamplerPendingRatio: this._pendingRateRatio,
      resamplerPendingConfirmations: this._pendingRateConfirmations,
      resamplerTargetRatio: this._targetRateRatio,
      resamplerMeasuredRatio: this._measuredRateRatio,
      resamplerUpdates: this._resamplerUpdates,
      resamplerActive: this._resamplerActivelyTracking,
      resamplerFillArmed: this._resamplerFillArmed,
      resamplerFillCorrectionPpm: this._lastFillCorrectionPpm,
      resamplerFrac: this._resampleFrac,
      resamplerStableSec: this._stableRenderFrames / this.sampleRate,
    };
  }

  _effectiveClickTrimMargin() {
    if (this._clickTrimMarginFrames != null) return this._clickTrimMarginFrames;
    // Default margin follows RemSound's normal smoothness shape: packet-size
    // floor, a small fixed floor for tiny packets, plus extra headroom. A trim
    // is a splice, so it should be a safety net for real backlog, not something
    // that fights ordinary startup bursts at 20 ms.
    const packetFloor = Math.round(this._lastPacketFrames * 4) + Math.round(this.sampleRate * 0.004);
    const fixedFloor = Math.round(this.sampleRate * 0.015);
    const knobExtra = Math.round(this.sampleRate * 0.008);
    return Math.max(packetFloor, fixedFloor) + knobExtra;
  }

  _markRateDisturbed() {
    // A playout disturbance should freeze whatever clock ratio we currently
    // trust, but it must not erase the long-term written/output measurement.
    // Otherwise a session with periodic underruns can never learn real device
    // drift and stays pinned at 0 ppm forever.
    this._renderFramesSinceDisturbance = 0;
    this._lastFillCorrectionPpm = 0;
    this._resamplerFillArmed = false;
    this._filledLpInit = false;
  }

  _lowLatencyCushionFrames() {
    return Math.max(0, Math.min(
      Math.round(this._lastPacketFrames / 2),
      Math.round(this.currentTargetFrames / 6)
    ));
  }

  _servoTargetFrames() {
    return Math.min(this._ringSize, this.currentTargetFrames + this._lowLatencyCushionFrames());
  }

  _clickTrimKeepFrames() {
    const keepCushion = Math.max(
      this._lowLatencyCushionFrames(),
      Math.round(this._lastPacketFrames * 2) + Math.round(this.sampleRate * 0.005)
    );
    return Math.min(this._ringSize, this.currentTargetFrames + keepCushion);
  }

  _latencyTrimThresholdFrames() {
    const packetRecovery = Math.round(this._lastPacketFrames * 2) + Math.round(this.sampleRate * 0.002);
    const fixedRecovery = Math.round(this.sampleRate * 0.010);
    return Math.min(this._ringSize, this.currentTargetFrames + Math.max(packetRecovery, fixedRecovery));
  }

  _latencyTrimReady() {
    return this._renderFramesSinceArm >= this.sampleRate * LATENCY_TRIM_ARM_SEC &&
      this._renderFramesSinceDisturbance >= this.sampleRate * LATENCY_TRIM_STABLE_SEC;
  }

  _resetRateEstimator() {
    const trusted = this._trustedRateRatio;
    this._resampleFrac = 0;
    this._rateWindowStartOutput = this._framesOutputForRate;
    this._rateWindowStartWritten = this._framesWrittenForRate;
    this._rateWindowActive = true;
    this._rateWindowDisturbed = false;
    this._resamplerActivelyTracking = trusted !== 1.0;
    this._resamplerUpdates = 0;
    this._measuredRateRatio = trusted;
    this._baseRateRatio = trusted;
    this._targetRateRatio = trusted;
    this._appliedRateRatio = trusted;
    this._pendingRateRatio = trusted;
    this._pendingRateConfirmations = 0;
    this._lastFillCorrectionPpm = 0;
    this._stableRenderFrames = 0;
    this._resamplerFillArmed = false;
  }

  _clearPendingRate() {
    this._pendingRateRatio = this._trustedRateRatio;
    this._pendingRateConfirmations = 0;
  }

  _decayPendingRate() {
    if (this._pendingRateConfirmations <= 0) return;
    this._pendingRateConfirmations -= 0.5;
    if (this._pendingRateConfirmations <= 0) this._clearPendingRate();
  }

  _emitResamplerStatus(source) {
    this._emit({
      type: 'resampler',
      ratio: this._appliedRateRatio,
      baseRatio: this._baseRateRatio,
      trustedRatio: this._trustedRateRatio,
      measuredRatio: this._measuredRateRatio,
      pendingRatio: this._pendingRateRatio,
      pendingConfirmations: this._pendingRateConfirmations,
      targetRatio: this._targetRateRatio,
      stableSec: this._stableRenderFrames / this.sampleRate,
      active: this._resamplerActivelyTracking,
      updates: this._resamplerUpdates,
      source: source || 'counter',
      filled: this._filled,
      target: this.currentTargetFrames,
    });
  }

  _acceptMeasuredRate(measured, outputDelta, opts) {
    const options = opts || {};
    const measuredPpm = Math.abs((measured - 1.0) * 1e6);
    if (measured < RESAMPLER_RATIO_MIN || measured > RESAMPLER_RATIO_MAX
        || measuredPpm > RESAMPLER_MEASURED_MAX_PPM) {
      this._decayPendingRate();
      return false;
    }

    const trusted = this._trustedRateRatio;
    if (measuredPpm < RESAMPLER_MEASURED_DEADBAND_PPM) {
      this._measuredRateRatio = trusted;
      this._decayPendingRate();
      return false;
    }

    const deltaPpm = (measured - trusted) * 1e6;
    if (Math.abs(deltaPpm) < RESAMPLER_MEASURED_DEADBAND_PPM) {
      this._measuredRateRatio = trusted;
      this._decayPendingRate();
      return false;
    }

    if (this._pendingRateConfirmations > 0) {
      const pendingDeltaPpm = (this._pendingRateRatio - trusted) * 1e6;
      const packetQuantizationPpm = !options.skipPacketQuantization && outputDelta > 0
        ? (this._lastPacketFrames / outputDelta) * 1e6
        : 0;
      const agreePpm = Math.max(RESAMPLER_LEARN_AGREE_PPM, packetQuantizationPpm * 1.25);
      const agree = Math.sign(deltaPpm) === Math.sign(pendingDeltaPpm)
        && Math.abs((measured - this._pendingRateRatio) * 1e6) <= agreePpm;
      if (agree) {
        this._pendingRateRatio = (this._pendingRateRatio * this._pendingRateConfirmations + measured)
          / (this._pendingRateConfirmations + 1);
        this._pendingRateConfirmations++;
      } else {
        this._pendingRateRatio = measured;
        this._pendingRateConfirmations = 1;
      }
    } else {
      this._pendingRateRatio = measured;
      this._pendingRateConfirmations = 1;
    }

    if (this._pendingRateConfirmations < RESAMPLER_LEARN_CONFIRM_WINDOWS) {
      this._measuredRateRatio = this._pendingRateRatio;
      return false;
    }

    this._measuredRateRatio = this._pendingRateRatio;
    const previous = this._trustedRateRatio;
    let next;
    if (!this._resamplerActivelyTracking) {
      next = this._measuredRateRatio;
      this._resamplerActivelyTracking = true;
    } else {
      next = (1.0 - RESAMPLER_RATIO_SMOOTHING_NEW) * this._baseRateRatio
        + RESAMPLER_RATIO_SMOOTHING_NEW * this._measuredRateRatio;
    }
    const maxStep = RESAMPLER_LEARN_MAX_STEP_PPM / 1e6;
    if (next > previous + maxStep) next = previous + maxStep;
    else if (next < previous - maxStep) next = previous - maxStep;
    this._baseRateRatio = next;
    this._trustedRateRatio = this._baseRateRatio;
    this._resamplerFillArmed = true;
    this._resamplerUpdates++;
    this._clearPendingRate();
    return true;
  }

  applyExternalRateEstimate(ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0) return false;
    if (this._stableRenderFrames < this.sampleRate * RESAMPLER_STABLE_HOLD_SEC) return false;
    const accepted = this._acceptMeasuredRate(ratio, 0, { skipPacketQuantization: true });
    if (accepted) this._emitResamplerStatus('arrival');
    return accepted;
  }

  _updateResamplerRate(quantum) {
    if (!this._rateWindowActive) this._resetRateEstimator();

    if (this._stableRenderFrames < this.sampleRate * RESAMPLER_STABLE_HOLD_SEC) {
      const trusted = this._trustedRateRatio;
      this._filledLp = this._filled;
      this._filledLpInit = true;
      this._measuredRateRatio = trusted;
      this._baseRateRatio = trusted;
      this._targetRateRatio = trusted;
      this._appliedRateRatio = trusted;
      this._pendingRateRatio = trusted;
      this._pendingRateConfirmations = 0;
      this._lastFillCorrectionPpm = 0;
      this._resamplerFillArmed = false;
      this._rateWindowStartOutput = this._framesOutputForRate;
      this._rateWindowStartWritten = this._framesWrittenForRate;
      this._rateWindowDisturbed = false;
      return;
    }

    const outputDelta = this._framesOutputForRate - this._rateWindowStartOutput;
    const windowSec = this._resamplerActivelyTracking ? RESAMPLER_WINDOW_SEC : RESAMPLER_FIRST_WINDOW_SEC;
    if (outputDelta >= this.sampleRate * windowSec) {
      const writtenDelta = this._framesWrittenForRate - this._rateWindowStartWritten;
      if (outputDelta > 0 && writtenDelta > 0) {
        const measured = writtenDelta / outputDelta;
        if (this._acceptMeasuredRate(measured, outputDelta)) {
          this._emitResamplerStatus('counter');
        }
      }
      this._rateWindowStartOutput = this._framesOutputForRate;
      this._rateWindowStartWritten = this._framesWrittenForRate;
      this._rateWindowDisturbed = false;
    }

    if (!this._filledLpInit) {
      this._filledLp = this._filled;
      this._filledLpInit = true;
    } else {
      this._filledLp += DRIFT_FILL_ALPHA * (this._filled - this._filledLp);
    }

    const error = this._filledLp - this._servoTargetFrames();
    const deadband = this._driftDeadbandFrames(quantum);
    let controlled = 0;
    if (error > deadband) controlled = error - deadband;
    else if (error < -deadband) controlled = error + deadband;

    const maxCorrection = RESAMPLER_FILL_MAX_PPM / 1e6;
    let fillCorrection = 0;
    if (this._resamplerFillArmed && maxCorrection > 0) {
      fillCorrection = controlled / (this.sampleRate * RESAMPLER_FILL_CORRECTION_SEC);
      if (fillCorrection > maxCorrection) fillCorrection = maxCorrection;
      else if (fillCorrection < -maxCorrection) fillCorrection = -maxCorrection;
    }
    this._lastFillCorrectionPpm = fillCorrection * 1e6;

    this._targetRateRatio = this._baseRateRatio + fillCorrection;
    if (this._targetRateRatio < RESAMPLER_RATIO_MIN) this._targetRateRatio = RESAMPLER_RATIO_MIN;
    else if (this._targetRateRatio > RESAMPLER_RATIO_MAX) this._targetRateRatio = RESAMPLER_RATIO_MAX;

    this._appliedRateRatio += (this._targetRateRatio - this._appliedRateRatio) * RESAMPLER_RATIO_SLEW;
    if (this._appliedRateRatio < RESAMPLER_RATIO_MIN) this._appliedRateRatio = RESAMPLER_RATIO_MIN;
    else if (this._appliedRateRatio > RESAMPLER_RATIO_MAX) this._appliedRateRatio = RESAMPLER_RATIO_MAX;
  }

  _inputNeededForResampler(quantum) {
    const end = this._resampleFrac + Math.max(0, quantum - 1) * this._appliedRateRatio;
    const whole = Math.floor(end);
    const frac = end - whole;
    return whole + (frac > 1e-9 ? 2 : 1);
  }

  _applyClickTrimIfNeeded() {
    const safetyThreshold = this.currentTargetFrames + this._effectiveClickTrimMargin();
    const latencyThreshold = this._latencyTrimThresholdFrames();
    const latencyTrim = this._filled > latencyThreshold && this._latencyTrimReady();
    const safetyTrim = this._filled > safetyThreshold;
    if (!latencyTrim && !safetyTrim) return false;
    // Safety trims are a loose backlog guard. Latency trims are tighter, but
    // only after stable rendering, so startup bursts and recent underruns do
    // not immediately get cut back to the edge.
    const threshold = safetyTrim ? safetyThreshold : latencyThreshold;
    let keep = safetyTrim ? this._clickTrimKeepFrames() : this._servoTargetFrames();
    if (keep >= this._filled) keep = this._servoTargetFrames();
    if (this._filled <= keep) return false;
    const dropped = this._filled - keep;
    this._readPos = (this._writePos - keep + this._ringSize) % this._ringSize;
    this._filled = keep;
    this._clickTrimFrames += dropped;
    this._clickTrimFires++;
    // The next render quantum needs a crossfade between the pre-trim last
    // sample (already in _lastOutSample) and the new read position, to mask
    // the splice discontinuity. Renderer handles the actual blend.
    this._pendingClickTrimXfade = true;
    // Reset drift state: the snap restored fill to target, so the integrator's
    // view of "error" is now zero and any accumulator from before is stale.
    this._driftAcc = 0;
    this._filledLpInit = false;
    this._resampleFrac = 0;
    if (safetyTrim) {
      this._driftHoldTicks = DRIFT_REARM_HOLD_TICKS;
      this._driftEventCooldownTicks = DRIFT_MIN_EVENT_TICKS;
      this._markRateDisturbed();
    }
    this._emit({
      type: 'click-trim',
      mode: safetyTrim ? 'safety' : 'latency',
      dropped,
      totalDropped: this._clickTrimFrames,
      fires: this._clickTrimFires,
      filled: this._filled,
      target: this.currentTargetFrames,
      threshold,
    });
    return true;
  }

  _trimStaleFramesForArm() {
    const keep = this._servoTargetFrames();
    if (this._filled <= keep) return 0;
    const drop = this._filled - keep;
    this._readPos = (this._writePos - keep + this._ringSize) % this._ringSize;
    this._filled = keep;
    this._rearmTrimFrames += drop;
    this._resampleFrac = 0;
    this._markRateDisturbed();
    this._emit({
      type: 'rearm-trim',
      dropped: drop,
      totalDropped: this._rearmTrimFrames,
      filled: this._filled,
      target: this.currentTargetFrames,
    });
    return drop;
  }

  _driftDeadbandFrames(quantum) {
    // The writer arrives in packet bursts while the chain drains in render
    // quanta. Treat that normal sawtooth as neutral; drift correction should
    // react to long-term clock slope, not packet phase.
    const halfPacket = Math.max(quantum, Math.round(this._lastPacketFrames / 2));
    const halfTarget = Math.max(quantum, Math.round(this.currentTargetFrames / 2));
    return Math.min(halfPacket, halfTarget);
  }

  _setArmed(armed) {
    if (this._armed === armed) return;
    if (armed) this._trimStaleFramesForArm();
    this._armed = armed;
    this._consecutiveUnderruns = 0;
    this._renderFramesSinceArm = 0;
    this._renderFramesSinceDisturbance = 0;
    this._inConcealment = false;
    this._fadeInOnNextRead = !!armed;
    for (let c = 0; c < this._channels; c++) this._lastOutSample[c] = 0;
    // Drift state: reset accumulator and the LP filter so a fresh session
    // doesn't carry forward stale drift accounting from before the silence.
    this._driftAcc = 0;
    this._filledLpInit = false;
    this._driftHoldTicks = armed ? DRIFT_REARM_HOLD_TICKS : 0;
    this._driftEventCooldownTicks = armed ? DRIFT_MIN_EVENT_TICKS : 0;
    if (armed) this._resetRateEstimator();
    else this._markRateDisturbed();
    this._emit({ type: 'arming', armed, filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
  }

  _postBufferStatus() {
    this._statusTicks++;
    if (this._statusTicks < BUFFER_STATUS_TICKS) return;
    this._statusTicks = 0;
    this._emit({
      type: 'buffer',
      filled: this._filled,
      ringSize: this._ringSize,
      target: this.currentTargetFrames,
      ratio: this._appliedRateRatio,
      baseRatio: this._baseRateRatio,
      trustedRatio: this._trustedRateRatio,
      targetRatio: this._targetRateRatio,
      measuredRatio: this._measuredRateRatio,
      pendingRatio: this._pendingRateRatio,
      pendingConfirmations: this._pendingRateConfirmations,
      stableSec: this._stableRenderFrames / this.sampleRate,
      active: this._resamplerActivelyTracking,
      updates: this._resamplerUpdates,
    });
  }

  _writeConcealmentFadeOut(output, quantum) {
    const fadeFrames = Math.min(CONCEAL_FADE_FRAMES, quantum);
    for (let f = 0; f < fadeFrames; f++) {
      const t = (f + 1) / fadeFrames;
      const gain = (Math.cos(Math.PI * t) + 1) * 0.5;
      for (let c = 0; c < output.length; c++) {
        const sc = c < this._channels ? c : this._channels - 1;
        output[c][f] = this._lastOutSample[sc] * gain;
      }
    }
    for (let c = 0; c < output.length; c++) {
      for (let f = fadeFrames; f < quantum; f++) output[c][f] = 0;
    }
  }

  renderQuantum(output, quantum) {
    quantum = quantum != null ? quantum : (output[0] ? output[0].length : 128);

    if (!this._armed) {
      if (this._filled < this._servoTargetFrames()) {
        for (const ch of output) ch.fill(0);
        this._postBufferStatus();
        return;
      }
      this._setArmed(true);
    }

    // Click-trim safety net: snap _readPos forward if fill has accumulated
    // beyond target + margin (gap recovery, sustained burst, etc.). Restores
    // the latency contract instantly; cosine crossfade in the render block
    // below masks the splice. Must run before the resampler reads the ring.
    this._applyClickTrimIfNeeded();

    if (this._driftHoldTicks > 0) {
      this._driftHoldTicks--;
      this._driftAcc = 0;
      this._filledLp = this._filled;
      this._filledLpInit = true;
    } else {
      this._updateResamplerRate(quantum);
    }

    const needed = this._inputNeededForResampler(quantum);
    const inputLimited = this._filled < needed;
    if (this._filled <= 0) {
      if (!this._inConcealment) {
        this._writeConcealmentFadeOut(output, quantum);
        this._inConcealment = true;
      } else {
        for (const ch of output) ch.fill(0);
      }
      this._emit({ type: 'underrun', filled: this._filled, needed, target: this.currentTargetFrames });
      this._framesOutputForRate += quantum;
      this._markRateDisturbed();
      this._resampleFrac = 0;
      this._consecutiveUnderruns++;
      if (this._consecutiveUnderruns >= REARM_UNDERRUN_TICKS) this._setArmed(false);
      return;
    }
    if (inputLimited) {
      // A small input shortfall near packet boundaries is better rendered by
      // holding the last available sample for the tail of this quantum than by
      // dropping the whole quantum into concealment.
      this._partialUnderruns++;
      this._markRateDisturbed();
    }

    // First quantum back after concealment: cosine fade-in on the first
    // CONCEAL_FADE_FRAMES samples.
    const inFadeIn = this._inConcealment || this._fadeInOnNextRead;
    this._inConcealment = false;
    this._fadeInOnNextRead = false;
    // Click-trim splice xfade: blend pre-trim trailing sample (held in
    // _lastOutSample) into the first CLICK_TRIM_FADE_FRAMES of the new read
    // position. Suppresses fade-in (no concealment to fade in from when the
    // splice was caused by overhead, not silence).
    const inClickTrimXfade = this._pendingClickTrimXfade && !inFadeIn;
    this._pendingClickTrimXfade = false;
    const ratio = this._appliedRateRatio;
    for (let f = 0; f < quantum; f++) {
      const srcPos = this._resampleFrac + f * ratio;
      const rawI0 = Math.floor(srcPos);
      const i0 = rawI0 < this._filled ? rawI0 : this._filled - 1;
      const frac = rawI0 === i0 ? srcPos - rawI0 : 0;
      const i1 = (i0 + 1) < this._filled ? i0 + 1 : i0;
      const rp0 = (this._readPos + i0) % this._ringSize;
      const rp1 = (this._readPos + i1) % this._ringSize;
      let preFadeGain = 1;
      if (inFadeIn && f < CONCEAL_FADE_FRAMES) {
        const t = (f + 1) / CONCEAL_FADE_FRAMES;
        preFadeGain = (1 - Math.cos(Math.PI * t)) * 0.5;
      }
      for (let c = 0; c < output.length; c++) {
        const rc = c < this._channels ? c : this._channels - 1;
        const a = this._ring[rc][rp0];
        const b = this._ring[rc][rp1];
        const blended = frac === 0 ? a : (a + (b - a) * frac);
        let out = blended * preFadeGain;
        if (inClickTrimXfade && f < CLICK_TRIM_FADE_FRAMES) {
          const t = (f + 1) / CLICK_TRIM_FADE_FRAMES;
          const w2 = (1 - Math.cos(Math.PI * t)) * 0.5;  // 0 → 1 cosine ramp
          const rc2 = c < this._channels ? c : this._channels - 1;
          out = (1 - w2) * this._lastOutSample[rc2] + w2 * out;
        }
        output[c][f] = out;
      }
    }
    const advance = this._resampleFrac + quantum * ratio;
    let consumed = Math.floor(advance);
    this._resampleFrac = advance - consumed;
    if (consumed > this._filled) {
      consumed = this._filled;
      this._resampleFrac = 0;
    }
    this._readPos = (this._readPos + consumed) % this._ringSize;
    this._filled -= consumed;
    this._framesOutputForRate += quantum;

    // Stash trailing sample for the next potential fade-out.
    for (let c = 0; c < output.length; c++) {
      const rc = c < this._channels ? c : this._channels - 1;
      this._lastOutSample[rc] = output[c][quantum - 1];
    }

    this._consecutiveUnderruns = 0;
    this._renderFramesSinceArm += quantum;
    if (!inputLimited) {
      this._stableRenderFrames += quantum;
      this._renderFramesSinceDisturbance += quantum;
    }
    this._postBufferStatus();
  }
}

// Dual-context export. In Node this populates module.exports; in the
// AudioWorklet global scope (where `module` is undefined), `typeof module`
// returns 'undefined' under strict mode and the block is skipped without
// throwing — so this same source file is safe to concatenate into the worklet.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PlayoutChain,
    clampTarget,
    DEFAULT_TARGET_FRAMES,
    DEFAULT_PACKET_FRAMES,
    MIN_TARGET_FRAMES,
    MAX_TARGET_FRAMES,
    REARM_UNDERRUN_TICKS,
    BUFFER_STATUS_TICKS,
    CONCEAL_FADE_FRAMES,
    DRIFT_GAIN_BASE,
    DRIFT_SMALL_ERROR_FRAMES,
    DRIFT_MAX_GAIN_SCALE,
    DRIFT_ACC_CLAMP,
    DRIFT_XFADE_FRAMES,
    DRIFT_REARM_HOLD_TICKS,
    DRIFT_MIN_EVENT_TICKS,
    DRIFT_FILL_ALPHA,
    RESAMPLER_WINDOW_SEC,
    RESAMPLER_FIRST_WINDOW_SEC,
    RESAMPLER_RATIO_SMOOTHING_NEW,
    RESAMPLER_RATIO_MIN,
    RESAMPLER_RATIO_MAX,
    RESAMPLER_MEASURED_MAX_PPM,
    RESAMPLER_MEASURED_DEADBAND_PPM,
    RESAMPLER_LEARN_CONFIRM_WINDOWS,
    RESAMPLER_LEARN_AGREE_PPM,
    RESAMPLER_LEARN_MAX_STEP_PPM,
    RESAMPLER_FILL_CORRECTION_SEC,
    RESAMPLER_FILL_MAX_PPM,
    RESAMPLER_RATIO_SLEW,
    RESAMPLER_STABLE_HOLD_SEC,
    LATENCY_TRIM_ARM_SEC,
    LATENCY_TRIM_STABLE_SEC,
    CLICK_TRIM_FADE_FRAMES,
  };
}

// AudioWorklet shell for the lossless DC receiver. The playout chain itself
// lives in sidecar/src/playout.js and is concatenated above this template by
// sidecar/scripts/build-worklet.js. Edit playout.js for chain logic; edit this
// template only for AudioWorklet I/O wiring.

class LosslessAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._playout = new PlayoutChain({
      sampleRate,
      channels: opts.channels || 2,
      targetFrames: opts.targetFrames != null ? opts.targetFrames : opts.armingTargetFrames,
      emit: (msg) => this.port.postMessage(msg),
    });

    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === 'frame') {
        this._playout.enqueue(m.samples, m.channels);
      } else if (m.type === 'setTarget') {
        this._playout.setTarget(m.frames);
      } else if (m.type === 'rateEstimate') {
        this._playout.applyExternalRateEstimate(m.ratio);
      }
    };
  }

  // Expose internals the rearm test pokes at. Keep this tiny — anything
  // beyond test surface belongs as a real method on PlayoutChain.
  get _filled() { return this._playout._filled; }
  get _driftHoldTicks() { return this._playout._driftHoldTicks; }
  get _driftAcc() { return this._playout._driftAcc; }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output) return true;
    this._playout.renderQuantum(output);
    return true;
  }
}

registerProcessor('lossless-audio-processor', LosslessAudioProcessor);
