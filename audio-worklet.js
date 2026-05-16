/**
 * VDO.Ninja Lossless DC AudioWorklet Processor v1.0.17
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
 *
 * v1.0.16 (Step 8, Layer A): single user-controlled target buffer level
 *   (currentTargetFrames). Doubles as arming threshold AND (Step 6) drift
 *   target. Default 30 ms @ 48 kHz = 1440 frames.
 *
 * v1.0.17 (Step 5, Layer B): cosine fade-out on first underrun, cosine
 *   fade-in on first refill. CONCEAL_FADE_FRAMES = 32. After
 *   REARM_UNDERRUN_TICKS consecutive empty quanta the worklet re-arms
 *   (existing behavior); the fade-out + hard silence keeps the audible
 *   signature of a brief underrun to "dipped briefly" instead of
 *   "click-silence-click."
 */
const DEFAULT_TARGET_FRAMES = 1440;  // 30 ms @ 48 kHz
const MIN_TARGET_FRAMES = 240;       //  5 ms @ 48 kHz
const MAX_TARGET_FRAMES = 14400;     // 300 ms @ 48 kHz
const REARM_UNDERRUN_TICKS = 8;
const BUFFER_STATUS_TICKS = 50;
const CONCEAL_FADE_FRAMES = 32;      // ~0.67 ms @ 48 kHz — matches RemSound ConcealFadeFramesShort.

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

    // Concealment state (Layer B). _lastOutSample tracks the trailing sample
    // per channel after every successful read so a fade-OUT on the next
    // underrun starts from continuous audio rather than zero. _inConcealment
    // latches between the underrun that triggered the fade-out and the next
    // non-empty quantum that needs a fade-IN.
    this._lastOutSample = new Float32Array(ch);
    this._inConcealment = false;

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
    // Reset concealment state on every arm transition so a fresh
    // session doesn't carry stale fade-out residue from a previous gap.
    this._inConcealment = false;
    for (let c = 0; c < this._channels; c++) this._lastOutSample[c] = 0;
    this.port.postMessage({ type: 'arming', armed, filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
  }

  _postBufferStatus() {
    this._statusTicks++;
    if (this._statusTicks < BUFFER_STATUS_TICKS) return;
    this._statusTicks = 0;
    this.port.postMessage({ type: 'buffer', filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
  }

  // Writes a cosine fade-out of CONCEAL_FADE_FRAMES samples from _lastOutSample
  // toward zero into the first 32 samples of `output`, then hard-silences the
  // rest of the quantum. Called when an underrun is detected and concealment
  // wasn't already active.
  _writeConcealmentFadeOut(output, quantum) {
    const fadeFrames = Math.min(CONCEAL_FADE_FRAMES, quantum);
    for (let f = 0; f < fadeFrames; f++) {
      // gain = (cos(π × t) + 1) / 2, t = (f+1)/fadeFrames
      // f=0 → t≈1/32, gain≈0.9976; f=fadeFrames-1 → t=1, gain=0.
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

  // Writes a cosine fade-in over the first 32 samples of the quantum, scaling
  // the actual ring samples from 0 → 1, then copies the remainder verbatim.
  // Advances readPos / filled / _lastOutSample as a normal read would.
  _readWithFadeIn(output, quantum) {
    const fadeFrames = Math.min(CONCEAL_FADE_FRAMES, quantum);
    for (let f = 0; f < quantum; f++) {
      const rp = (this._readPos + f) % this._ringSize;
      const t = (f + 1) / fadeFrames;
      const gain = f < fadeFrames ? (1 - Math.cos(Math.PI * t)) * 0.5 : 1;
      for (let c = 0; c < output.length; c++) {
        const rc = c < this._channels ? c : this._channels - 1;
        output[c][f] = this._ring[rc][rp] * gain;
      }
    }
    this._readPos = (this._readPos + quantum) % this._ringSize;
    this._filled -= quantum;
    // _lastOutSample is the trailing sample (post-fade, so full-gain).
    for (let c = 0; c < output.length; c++) {
      const rc = c < this._channels ? c : this._channels - 1;
      const rp = (this._readPos - 1 + this._ringSize) % this._ringSize;
      this._lastOutSample[rc] = this._ring[rc][rp];
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
        // First empty quantum of this underrun: cosine fade-out from last
        // good sample toward zero, hard silence for the remainder.
        this._writeConcealmentFadeOut(output, quantum);
        this._inConcealment = true;
      } else {
        // Already concealed: stay silent until either we get data back
        // (fade-in path below) or we hit the re-arm threshold.
        for (const ch of output) ch.fill(0);
      }
      this.port.postMessage({ type: 'underrun', filled: this._filled, needed: quantum, target: this.currentTargetFrames });
      this._consecutiveUnderruns++;
      if (this._consecutiveUnderruns >= REARM_UNDERRUN_TICKS) this._setArmed(false);
      return true;
    }

    if (this._inConcealment) {
      // First quantum back with data after an underrun: fade in.
      this._readWithFadeIn(output, quantum);
      this._inConcealment = false;
    } else {
      for (let f = 0; f < quantum; f++) {
        const rp = (this._readPos + f) % this._ringSize;
        for (let c = 0; c < output.length; c++) {
          const rc = c < this._channels ? c : this._channels - 1;
          output[c][f] = this._ring[rc][rp];
        }
      }
      this._readPos = (this._readPos + quantum) % this._ringSize;
      this._filled -= quantum;
      // Stash the trailing sample for the next potential fade-out.
      for (let c = 0; c < output.length; c++) {
        const rc = c < this._channels ? c : this._channels - 1;
        const rp = (this._readPos - 1 + this._ringSize) % this._ringSize;
        this._lastOutSample[rc] = this._ring[rc][rp];
      }
    }
    this._consecutiveUnderruns = 0;
    this._postBufferStatus();
    return true;
  }
}

registerProcessor('lossless-audio-processor', LosslessAudioProcessor);
