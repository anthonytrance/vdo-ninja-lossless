/**
 * VDO.Ninja Lossless DC AudioWorklet Processor v1.0.15
 *
 * Registered as: 'lossless-audio-processor'
 * Loaded by viewer.js via AudioContext.audioWorklet.addModule()
 *
 * Protocol:
 *   main -> worklet: { type: 'frame', samples: Float32Array.buffer, channels: N }
 *   worklet -> main: { type: 'underrun' }
 *                  | { type: 'arming', armed: bool }
 *                  | { type: 'buffer' }
 *                  | { type: 'drift', action: 'skip'|'repeat', skips, repeats, acc, filled }
 *
 * v1.0.15: clock-drift integrator. AudioContext.sampleRate is rarely exactly
 * 48 kHz; over minutes the buffer slowly fills or drains and the audio glitches.
 * Per quantum we integrate (filled - target) and once the accumulator crosses
 * +/-1 we drop or repeat one frame with an 8-sample cosine crossfade. The audible
 * cost is one ~21 us seam every few seconds at steady-state drift; the win is
 * that long-running sessions stay glitch-free.
 */
const DEFAULT_ARMING_TARGET_FRAMES = 576;
const REARM_UNDERRUN_TICKS = 8;
const BUFFER_STATUS_TICKS = 50;

// Drift integrator constants (RemSound SessionPlayout.cs 2026-05-06, adapted
// for our 480-frame WebRTC bursts arriving every ~10 ms against a quantum-rate
// reader). The LP filter on filled smooths the burst sawtooth so the integrator
// sees the true time-average instead of false drift at ppm=0.
const DRIFT_GAIN_BASE = 0.005;
const DRIFT_SMALL_ERROR_FRAMES = 50;
const DRIFT_MAX_GAIN_SCALE = 20;
const DRIFT_ACC_CLAMP = 100;
const DRIFT_XFADE_FRAMES = 8;
// LP-filter alpha for filled, per-quantum. tau ~= dt / alpha. At alpha=0.0025
// and dt = 128/48000, tau ~= 1.07 s — long enough to bury the 10 ms burst
// sawtooth while still responding to drift on a few-second timescale.
const DRIFT_FILL_ALPHA = 0.0025;

class LosslessAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const ch = opts.channels || 2;
    this._channels = ch;
    this._armingTargetFrames = Math.max(128, opts.armingTargetFrames || DEFAULT_ARMING_TARGET_FRAMES);

    // Ring buffer: 4096 frames per channel (at 48kHz = ~85ms of headroom)
    this._ringSize = 4096;
    this._ring     = new Array(ch).fill(null).map(() => new Float32Array(this._ringSize));
    this._writePos = 0;
    this._readPos  = 0;
    this._filled   = 0;  // samples per channel currently buffered
    this._armed = false;
    this._consecutiveUnderruns = 0;
    this._statusTicks = 0;

    // Drift integrator state. _driftAcc and _filledLp reset on every (re-)arm.
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
      if (ev.data.type === 'frame') {
        this._enqueue(ev.data.samples, ev.data.channels || ch);
      }
    };
  }

  _enqueue(buffer, srcChannels) {
    const interleaved = new Float32Array(buffer);
    const frames = Math.floor(interleaved.length / srcChannels);

    for (let f = 0; f < frames; f++) {
      const wp = (this._writePos + f) % this._ringSize;
      for (let c = 0; c < this._channels; c++) {
        // If source has fewer channels than output, clamp to last available.
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
    this._driftAcc = 0;
    this._filledLpInit = false;
    this.port.postMessage({ type: 'arming', armed, filled: this._filled, ringSize: this._ringSize });
  }

  _postBufferStatus() {
    this._statusTicks++;
    if (this._statusTicks < BUFFER_STATUS_TICKS) return;
    this._statusTicks = 0;
    this.port.postMessage({ type: 'buffer', filled: this._filled, ringSize: this._ringSize });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const quantum = output[0] ? output[0].length : 128;

    if (!this._armed) {
      if (this._filled < this._armingTargetFrames) {
        for (const ch of output) ch.fill(0);
        this._postBufferStatus();
        return true;
      }
      this._setArmed(true);
    }

    if (this._filled < quantum) {
      // Not enough data after arming: output silence and report a real underrun.
      for (const ch of output) ch.fill(0);
      this.port.postMessage({ type: 'underrun', filled: this._filled, needed: quantum });
      this._consecutiveUnderruns++;
      if (this._consecutiveUnderruns >= REARM_UNDERRUN_TICKS) this._setArmed(false);
      return true;
    }

    // Drift integrator (RemSound-style) over LP-filtered filled. The LP filter
    // averages out the 10 ms WebRTC burst sawtooth so the integrator sees the
    // true buffer trend and only fires when there is sustained drift.
    if (!this._filledLpInit) {
      this._filledLp = this._filled;
      this._filledLpInit = true;
    } else {
      this._filledLp += DRIFT_FILL_ALPHA * (this._filled - this._filledLp);
    }
    const error = this._filledLp - this._armingTargetFrames;
    const absErr = error >= 0 ? error : -error;
    const gainScale = absErr <= DRIFT_SMALL_ERROR_FRAMES
      ? 1
      : Math.min(absErr / DRIFT_SMALL_ERROR_FRAMES, DRIFT_MAX_GAIN_SCALE);
    this._driftAcc += error * (quantum / sampleRate) * DRIFT_GAIN_BASE * gainScale;
    if (this._driftAcc > DRIFT_ACC_CLAMP) this._driftAcc = DRIFT_ACC_CLAMP;
    else if (this._driftAcc < -DRIFT_ACC_CLAMP) this._driftAcc = -DRIFT_ACC_CLAMP;

    // extra: +1 = skip one source frame this tick, -1 = repeat one frame.
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

    // Output path. For extra=+1 ("skip"): the last DRIFT_XFADE_FRAMES samples
    // crossfade from source[rp+f] toward source[rp+f+1], so the read pointer
    // ends advanced by quantum+1 with no audible discontinuity. For extra=-1
    // ("repeat"): crossfade toward source[rp+f-1], advancing by quantum-1.
    const xfadeStart = quantum - DRIFT_XFADE_FRAMES;
    for (let f = 0; f < quantum; f++) {
      const rp = (this._readPos + f) % this._ringSize;
      let neighbourIdx = rp;
      let w = 0;
      if (extra !== 0 && f >= xfadeStart) {
        w = this._driftXfade[f - xfadeStart];
        if (extra === 1) {
          neighbourIdx = (rp + 1) % this._ringSize;
        } else {
          neighbourIdx = (rp - 1 + this._ringSize) % this._ringSize;
        }
      }
      for (let c = 0; c < output.length; c++) {
        const rc = c < this._channels ? c : this._channels - 1;
        const v = this._ring[rc][rp];
        output[c][f] = w === 0 ? v : ((1 - w) * v + w * this._ring[rc][neighbourIdx]);
      }
    }
    const consumed = quantum + extra;
    this._readPos = (this._readPos + consumed) % this._ringSize;
    this._filled -= consumed;
    this._consecutiveUnderruns = 0;
    this._postBufferStatus();
    return true;
  }
}

registerProcessor('lossless-audio-processor', LosslessAudioProcessor);
