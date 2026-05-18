/**
 * VDO.Ninja Lossless DC AudioWorklet v1.0.22.
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

// Drift integrator constants (RemSound SessionPlayout.cs, 2026-05-06).
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

    // Drift integrator state. Resets on every (re-)arm.
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
  }

  enqueue(samples, srcChannels) {
    const interleaved = samples instanceof Float32Array
      ? samples
      : new Float32Array(samples);
    const sc = srcChannels || this._channels;
    const frames = Math.floor(interleaved.length / sc);
    if (frames > 0) this._lastPacketFrames = frames;

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
    this._emit({ type: 'buffer', filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
  }

  getStats() {
    return {
      armed: this._armed,
      filled: this._filled,
      target: this.currentTargetFrames,
      ringSize: this._ringSize,
      driftSkips: this._driftSkips,
      driftRepeats: this._driftRepeats,
      driftAcc: this._driftAcc,
      filledLp: this._filledLp,
      driftHoldTicks: this._driftHoldTicks,
      driftEventCooldownTicks: this._driftEventCooldownTicks,
      rearmTrimFrames: this._rearmTrimFrames,
      clickTrimFrames: this._clickTrimFrames,
      clickTrimFires: this._clickTrimFires,
      clickTrimThreshold: this.currentTargetFrames + this._effectiveClickTrimMargin(),
      lastPacketFrames: this._lastPacketFrames,
    };
  }

  _effectiveClickTrimMargin() {
    if (this._clickTrimMarginFrames != null) return this._clickTrimMarginFrames;
    // Default margin: max(packetFrames, currentTargetFrames). Matches RemSound's
    // floorMargin + knob-extra pattern: packet-size floor so the natural
    // arrival sawtooth doesn't false-trim, plus a target-sized headroom so the
    // drift integrator has room to drain small overhead before the snap fires.
    return Math.max(this._lastPacketFrames, this.currentTargetFrames);
  }

  _applyClickTrimIfNeeded() {
    const margin = this._effectiveClickTrimMargin();
    const threshold = this.currentTargetFrames + margin;
    if (this._filled <= threshold) return false;
    // Snap _readPos forward, but leave a packet-half cushion above target so
    // the post-trim sawtooth oscillates AROUND target instead of dropping
    // below it. Without the cushion, trim cuts the burst peaks down to
    // target, the drain phase between bursts pulls fill below target, and
    // the drift integrator sees a persistent deficit and fires repeats —
    // an oscillation that defeats the whole point of the trim.
    const cushion = Math.max(0, Math.round(this._lastPacketFrames / 2));
    const keep = this.currentTargetFrames + cushion;
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
    this._driftHoldTicks = DRIFT_REARM_HOLD_TICKS;
    this._driftEventCooldownTicks = DRIFT_MIN_EVENT_TICKS;
    this._emit({
      type: 'click-trim',
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
    const keep = clampTarget(this.currentTargetFrames);
    if (this._filled <= keep) return 0;
    const drop = this._filled - keep;
    this._readPos = (this._writePos - keep + this._ringSize) % this._ringSize;
    this._filled = keep;
    this._rearmTrimFrames += drop;
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
    this._inConcealment = false;
    this._fadeInOnNextRead = !!armed;
    for (let c = 0; c < this._channels; c++) this._lastOutSample[c] = 0;
    // Drift state: reset accumulator and the LP filter so a fresh session
    // doesn't carry forward stale drift accounting from before the silence.
    this._driftAcc = 0;
    this._filledLpInit = false;
    this._driftHoldTicks = armed ? DRIFT_REARM_HOLD_TICKS : 0;
    this._driftEventCooldownTicks = armed ? DRIFT_MIN_EVENT_TICKS : 0;
    this._emit({ type: 'arming', armed, filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
  }

  _postBufferStatus() {
    this._statusTicks++;
    if (this._statusTicks < BUFFER_STATUS_TICKS) return;
    this._statusTicks = 0;
    this._emit({ type: 'buffer', filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
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
      if (this._filled < this.currentTargetFrames) {
        for (const ch of output) ch.fill(0);
        this._postBufferStatus();
        return;
      }
      this._setArmed(true);
    }

    if (this._filled < quantum) {
      if (!this._inConcealment) {
        this._writeConcealmentFadeOut(output, quantum);
        this._inConcealment = true;
      } else {
        for (const ch of output) ch.fill(0);
      }
      this._emit({ type: 'underrun', filled: this._filled, needed: quantum, target: this.currentTargetFrames });
      this._consecutiveUnderruns++;
      if (this._consecutiveUnderruns >= REARM_UNDERRUN_TICKS) this._setArmed(false);
      return;
    }

    // Click-trim safety net: snap _readPos forward if fill has accumulated
    // beyond target + margin (gap recovery, sustained burst, etc.). Restores
    // the latency contract instantly; cosine crossfade in the render block
    // below masks the splice. Must run BEFORE the drift integrator so the
    // integrator sees the post-trim state, not the stale overhead.
    this._applyClickTrimIfNeeded();

    // extra: +1 = skip one source frame this quantum (drain by one),
    //        -1 = repeat one frame (grow by one).
    let extra = 0;
    if (this._driftHoldTicks > 0) {
      this._driftHoldTicks--;
      this._driftAcc = 0;
      this._filledLp = this._filled;
      this._filledLpInit = true;
    } else {
      // Drift integrator (Layer C). Runs every armed, data-bearing quantum.
      // LP-filter the observed fill so the WebRTC burst sawtooth doesn't
      // masquerade as drift. Initialise the LP to the current fill on first
      // tick (and after every re-arm) to skip the long startup transient.
      if (!this._filledLpInit) {
        this._filledLp = this._filled;
        this._filledLpInit = true;
      } else {
        this._filledLp += DRIFT_FILL_ALPHA * (this._filled - this._filledLp);
      }

      const error = this._filledLp - this.currentTargetFrames;
      const absErr = error >= 0 ? error : -error;
      const deadband = this._driftDeadbandFrames(quantum);
      if (absErr <= deadband) {
        // Decay stale accumulator so a brief packet-phase excursion does not
        // fire later after conditions have returned to normal.
        this._driftAcc *= 0.98;
        if (this._driftAcc > -0.001 && this._driftAcc < 0.001) this._driftAcc = 0;
      } else {
        const controlledError = error > 0 ? error - deadband : error + deadband;
        const controlledAbs = controlledError >= 0 ? controlledError : -controlledError;
        const gainScale = controlledAbs <= DRIFT_SMALL_ERROR_FRAMES
          ? 1
          : Math.min(controlledAbs / DRIFT_SMALL_ERROR_FRAMES, DRIFT_MAX_GAIN_SCALE);
        this._driftAcc += controlledError * (quantum / this.sampleRate) * DRIFT_GAIN_BASE * gainScale;
        if (this._driftAcc > DRIFT_ACC_CLAMP) this._driftAcc = DRIFT_ACC_CLAMP;
        else if (this._driftAcc < -DRIFT_ACC_CLAMP) this._driftAcc = -DRIFT_ACC_CLAMP;
      }

      if (this._driftEventCooldownTicks > 0) this._driftEventCooldownTicks--;
      if (this._driftEventCooldownTicks <= 0 && this._driftAcc >= 1 && this._filled >= quantum + 1) {
        this._driftAcc -= 1;
        this._driftSkips++;
        this._driftEventCooldownTicks = DRIFT_MIN_EVENT_TICKS;
        extra = 1;
        this._emit({
          type: 'drift', action: 'skip',
          skips: this._driftSkips, repeats: this._driftRepeats,
          acc: this._driftAcc, filled: this._filled,
        });
      } else if (this._driftEventCooldownTicks <= 0 && this._driftAcc <= -1) {
        this._driftAcc += 1;
        this._driftRepeats++;
        this._driftEventCooldownTicks = DRIFT_MIN_EVENT_TICKS;
        extra = -1;
        this._emit({
          type: 'drift', action: 'repeat',
          skips: this._driftSkips, repeats: this._driftRepeats,
          acc: this._driftAcc, filled: this._filled,
        });
      }
    }

    // First quantum back after concealment: cosine fade-in on the first
    // CONCEAL_FADE_FRAMES samples. Drift skip/repeat still applies to the
    // last DRIFT_XFADE_FRAMES samples; the two windows don't overlap at
    // standard quanta (128) since 32 + 8 < 128.
    const inFadeIn = this._inConcealment || this._fadeInOnNextRead;
    this._inConcealment = false;
    this._fadeInOnNextRead = false;
    // Click-trim splice xfade: blend pre-trim trailing sample (held in
    // _lastOutSample) into the first CLICK_TRIM_FADE_FRAMES of the new read
    // position. Suppresses fade-in (no concealment to fade in from when the
    // splice was caused by overhead, not silence).
    const inClickTrimXfade = this._pendingClickTrimXfade && !inFadeIn;
    this._pendingClickTrimXfade = false;
    const xfadeStart = quantum - DRIFT_XFADE_FRAMES;
    for (let f = 0; f < quantum; f++) {
      const rp = (this._readPos + f) % this._ringSize;
      let neighbourIdx = rp;
      let w = 0;
      if (extra !== 0 && f >= xfadeStart) {
        w = this._driftXfade[f - xfadeStart];
        neighbourIdx = extra === 1
          ? (rp + 1) % this._ringSize
          : (rp - 1 + this._ringSize) % this._ringSize;
      }
      let preFadeGain = 1;
      if (inFadeIn && f < CONCEAL_FADE_FRAMES) {
        const t = (f + 1) / CONCEAL_FADE_FRAMES;
        preFadeGain = (1 - Math.cos(Math.PI * t)) * 0.5;
      }
      for (let c = 0; c < output.length; c++) {
        const rc = c < this._channels ? c : this._channels - 1;
        const v = this._ring[rc][rp];
        const blended = w === 0 ? v : ((1 - w) * v + w * this._ring[rc][neighbourIdx]);
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
    const consumed = quantum + extra;
    this._readPos = (this._readPos + consumed) % this._ringSize;
    this._filled -= consumed;

    // Stash trailing sample for the next potential fade-out. After a drift
    // skip the trailing sample is the post-blend output we wrote, which is
    // already in output[c][quantum-1].
    for (let c = 0; c < output.length; c++) {
      const rc = c < this._channels ? c : this._channels - 1;
      this._lastOutSample[rc] = output[c][quantum - 1];
    }

    this._consecutiveUnderruns = 0;
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
