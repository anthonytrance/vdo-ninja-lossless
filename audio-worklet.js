/**
 * VDO.Ninja Lossless DC AudioWorklet Processor v1.0.19
 *
 * Registered as: 'lossless-audio-processor'
 * Loaded by viewer.js via AudioContext.audioWorklet.addModule()
 *
 * Protocol:
 *   main -> worklet: { type: 'frame', samples: Float32Array.buffer, channels: N }
 *                    { type: 'setTarget', frames: N }
 *   worklet -> main: { type: 'underrun', filled, needed, target }
 *                    { type: 'arming', armed, filled, ringSize, target }
 *                    { type: 'buffer', filled, ringSize, target }
 *                    { type: 'drift', action, skips, repeats, acc, filled }
 *
 * v1.0.16 (Step 8, Layer A): single user-controlled target buffer level
 *   (currentTargetFrames). Default 30 ms @ 48 kHz.
 * v1.0.17 (Step 5, Layer B): cosine fade-out/fade-in concealment on
 *   underrun boundaries. CONCEAL_FADE_FRAMES = 32.
 * v1.0.18 (Step 6, Layer C): RemSound-style drift integrator. Per quantum
 *   integrates (filledLp - currentTargetFrames) × dt × 0.005 × gainScale.
 *   When the accumulator crosses ±1 the worklet drops or repeats one
 *   stereo frame over an 8-sample cosine crossfade. The target is
 *   currentTargetFrames from Layer A (v1.0.15's bug: it used the arming
 *   threshold, which is below the natural sawtooth midpoint, so the
 *   integrator never converged). State resets on every (re-)arm.
 * v1.0.19 (Step 6 refinement): on (re-)arm, initialise filledLp to
 *   currentTargetFrames instead of current _filled. After an underrun,
 *   queued packets pile up and re-arming sees _filled well above target;
 *   the prior init-at-fill caused the integrator to interpret that
 *   one-shot overshoot as drift and fire a recovery burst of skips per
 *   underrun. Initialising at target keeps error=0 at re-arm so the
 *   integrator only fires for sustained drift, not transient overshoot.
 *   Post-underrun extra fill is left to drain naturally via real clock
 *   drift; the residual elevated buffer is a feature (more headroom,
 *   fewer next underruns).
 */
const DEFAULT_TARGET_FRAMES = 1440;  // 30 ms @ 48 kHz
const MIN_TARGET_FRAMES = 240;       //  5 ms @ 48 kHz
const MAX_TARGET_FRAMES = 14400;     // 300 ms @ 48 kHz
const REARM_UNDERRUN_TICKS = 8;
const BUFFER_STATUS_TICKS = 50;
const CONCEAL_FADE_FRAMES = 32;      // ~0.67 ms @ 48 kHz — matches RemSound ConcealFadeFramesShort.

// Drift integrator constants (RemSound SessionPlayout.cs, 2026-05-06).
const DRIFT_GAIN_BASE = 0.005;
const DRIFT_SMALL_ERROR_FRAMES = 50;
const DRIFT_MAX_GAIN_SCALE = 20;
const DRIFT_ACC_CLAMP = 100;
const DRIFT_XFADE_FRAMES = 8;
// LP-filter alpha for filled, per-quantum. tau ≈ dt / alpha. At alpha=0.0025
// and dt = 128/48000, tau ≈ 1.07 s — long enough to bury the 10 ms WebRTC
// burst sawtooth, fast enough to track drift on a few-second timescale.
const DRIFT_FILL_ALPHA = 0.0025;

function _clampTarget(n) {
  if (!Number.isFinite(n)) return DEFAULT_TARGET_FRAMES;
  return Math.max(MIN_TARGET_FRAMES, Math.min(MAX_TARGET_FRAMES, Math.round(n)));
}

class LosslessAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const ch = opts.channels || 2;
    this._channels = ch;
    const initialTarget = opts.targetFrames != null ? opts.targetFrames : opts.armingTargetFrames;
    this.currentTargetFrames = _clampTarget(initialTarget != null ? initialTarget : DEFAULT_TARGET_FRAMES);

    this._ringSize = 16384;
    this._ring     = new Array(ch).fill(null).map(() => new Float32Array(this._ringSize));
    this._writePos = 0;
    this._readPos  = 0;
    this._filled   = 0;
    this._armed = false;
    this._consecutiveUnderruns = 0;
    this._statusTicks = 0;

    this._lastOutSample = new Float32Array(ch);
    this._inConcealment = false;

    // Drift integrator state. Resets on every (re-)arm.
    this._driftAcc = 0;
    this._filledLp = 0;
    this._filledLpInit = false;
    this._driftSkips = 0;
    this._driftRepeats = 0;
    this._driftXfade = new Float32Array(DRIFT_XFADE_FRAMES);
    for (let k = 0; k < DRIFT_XFADE_FRAMES; k++) {
      this._driftXfade[k] = 0.5 * (1 - Math.cos(Math.PI * (k + 1) / DRIFT_XFADE_FRAMES));
    }

    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === 'frame') {
        this._enqueue(m.samples, m.channels || ch);
      } else if (m.type === 'setTarget') {
        const next = _clampTarget(m.frames);
        if (next !== this.currentTargetFrames) {
          this.currentTargetFrames = next;
          this.port.postMessage({ type: 'buffer', filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
        }
      }
    };
  }

  _enqueue(buffer, srcChannels) {
    const interleaved = new Float32Array(buffer);
    const frames = Math.floor(interleaved.length / srcChannels);

    for (let f = 0; f < frames; f++) {
      const wp = (this._writePos + f) % this._ringSize;
      for (let c = 0; c < this._channels; c++) {
        const sc = c < srcChannels ? c : srcChannels - 1;
        this._ring[c][wp] = interleaved[f * srcChannels + sc];
      }
    }
    this._writePos = (this._writePos + frames) % this._ringSize;
    this._filled   = Math.min(this._filled + frames, this._ringSize);
  }

  _setArmed(armed) {
    if (this._armed === armed) return;
    this._armed = armed;
    this._consecutiveUnderruns = 0;
    this._inConcealment = false;
    for (let c = 0; c < this._channels; c++) this._lastOutSample[c] = 0;
    // Drift state: reset accumulator and the LP filter so a fresh session
    // doesn't carry forward stale drift accounting from before the silence.
    this._driftAcc = 0;
    this._filledLpInit = false;
    this.port.postMessage({ type: 'arming', armed, filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
  }

  _postBufferStatus() {
    this._statusTicks++;
    if (this._statusTicks < BUFFER_STATUS_TICKS) return;
    this._statusTicks = 0;
    this.port.postMessage({ type: 'buffer', filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
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

  process(_inputs, outputs) {
    const output = outputs[0];
    const quantum = output[0] ? output[0].length : 128;

    if (!this._armed) {
      if (this._filled < this.currentTargetFrames) {
        for (const ch of output) ch.fill(0);
        this._postBufferStatus();
        return true;
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
      this.port.postMessage({ type: 'underrun', filled: this._filled, needed: quantum, target: this.currentTargetFrames });
      this._consecutiveUnderruns++;
      if (this._consecutiveUnderruns >= REARM_UNDERRUN_TICKS) this._setArmed(false);
      return true;
    }

    // Drift integrator (Layer C). Runs every armed, data-bearing quantum.
    // LP-filter the observed fill so the WebRTC burst sawtooth doesn't
    // masquerade as drift. Initialise the LP to the current fill on first
    // tick (and after every re-arm) to skip the long startup transient.
    if (!this._filledLpInit) {
      // v1.0.19: init at target, not _filled. After an underrun, _filled
      // at re-arm includes the queued-burst overshoot; treating that
      // overshoot as the LP starting point made the integrator dump skips
      // to "fix" it. With LP=target at re-arm, the integrator stays quiet
      // until real drift accumulates.
      this._filledLp = this.currentTargetFrames;
      this._filledLpInit = true;
    } else {
      this._filledLp += DRIFT_FILL_ALPHA * (this._filled - this._filledLp);
    }
    const error = this._filledLp - this.currentTargetFrames;
    const absErr = error >= 0 ? error : -error;
    const gainScale = absErr <= DRIFT_SMALL_ERROR_FRAMES
      ? 1
      : Math.min(absErr / DRIFT_SMALL_ERROR_FRAMES, DRIFT_MAX_GAIN_SCALE);
    this._driftAcc += error * (quantum / sampleRate) * DRIFT_GAIN_BASE * gainScale;
    if (this._driftAcc > DRIFT_ACC_CLAMP) this._driftAcc = DRIFT_ACC_CLAMP;
    else if (this._driftAcc < -DRIFT_ACC_CLAMP) this._driftAcc = -DRIFT_ACC_CLAMP;

    // extra: +1 = skip one source frame this quantum (drain by one),
    //        -1 = repeat one frame (grow by one).
    let extra = 0;
    if (this._driftAcc >= 1 && this._filled >= quantum + 1) {
      this._driftAcc -= 1;
      this._driftSkips++;
      extra = 1;
      this.port.postMessage({
        type: 'drift', action: 'skip',
        skips: this._driftSkips, repeats: this._driftRepeats,
        acc: this._driftAcc, filled: this._filled,
      });
    } else if (this._driftAcc <= -1) {
      this._driftAcc += 1;
      this._driftRepeats++;
      extra = -1;
      this.port.postMessage({
        type: 'drift', action: 'repeat',
        skips: this._driftSkips, repeats: this._driftRepeats,
        acc: this._driftAcc, filled: this._filled,
      });
    }

    // First quantum back after concealment: cosine fade-in on the first
    // CONCEAL_FADE_FRAMES samples. Drift skip/repeat still applies to the
    // last DRIFT_XFADE_FRAMES samples; the two windows don't overlap at
    // standard quanta (128) since 32 + 8 < 128.
    const inFadeIn = this._inConcealment;
    this._inConcealment = false;
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
        output[c][f] = blended * preFadeGain;
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
    return true;
  }
}

registerProcessor('lossless-audio-processor', LosslessAudioProcessor);
