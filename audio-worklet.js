/**
 * VDO.Ninja Lossless DC AudioWorklet Processor v1.0.16
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
 * v1.0.16 (Step 8, Layer A): the worklet exposes a single user-controlled
 *   target buffer level (`currentTargetFrames`) that doubles as the arming
 *   threshold AND the steady-state target the drift integrator (Step 6, Layer
 *   C) will chase. Main thread can rewrite the target at runtime via the
 *   `setTarget` message (Layer D auto-tune wiring for Step 9). Default 30 ms
 *   at 48 kHz = 1440 frames.
 */
const DEFAULT_TARGET_FRAMES = 1440;  // 30 ms @ 48 kHz
const MIN_TARGET_FRAMES = 240;       //  5 ms @ 48 kHz
const MAX_TARGET_FRAMES = 14400;     // 300 ms @ 48 kHz
const REARM_UNDERRUN_TICKS = 8;
const BUFFER_STATUS_TICKS = 50;

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
    // Accept new name (targetFrames) and the legacy name (armingTargetFrames)
    // so older viewer.js builds keep working.
    const initialTarget = opts.targetFrames != null ? opts.targetFrames : opts.armingTargetFrames;
    this.currentTargetFrames = _clampTarget(initialTarget != null ? initialTarget : DEFAULT_TARGET_FRAMES);

    // Ring buffer: must hold at least MAX_TARGET_FRAMES + headroom. 16384 frames
    // (~340 ms @ 48 kHz) covers the 300 ms ceiling with margin for burst arrival.
    this._ringSize = 16384;
    this._ring     = new Array(ch).fill(null).map(() => new Float32Array(this._ringSize));
    this._writePos = 0;
    this._readPos  = 0;
    this._filled   = 0;
    this._armed = false;
    this._consecutiveUnderruns = 0;
    this._statusTicks = 0;

    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === 'frame') {
        this._enqueue(m.samples, m.channels || ch);
      } else if (m.type === 'setTarget') {
        const next = _clampTarget(m.frames);
        if (next !== this.currentTargetFrames) {
          this.currentTargetFrames = next;
          // Surface the change so the overlay reflects auto-tune moves immediately.
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
    this.port.postMessage({ type: 'arming', armed, filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
  }

  _postBufferStatus() {
    this._statusTicks++;
    if (this._statusTicks < BUFFER_STATUS_TICKS) return;
    this._statusTicks = 0;
    this.port.postMessage({ type: 'buffer', filled: this._filled, ringSize: this._ringSize, target: this.currentTargetFrames });
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
      for (const ch of output) ch.fill(0);
      this.port.postMessage({ type: 'underrun', filled: this._filled, needed: quantum, target: this.currentTargetFrames });
      this._consecutiveUnderruns++;
      if (this._consecutiveUnderruns >= REARM_UNDERRUN_TICKS) this._setArmed(false);
      return true;
    }

    for (let f = 0; f < quantum; f++) {
      const rp = (this._readPos + f) % this._ringSize;
      for (let c = 0; c < output.length; c++) {
        const rc = c < this._channels ? c : this._channels - 1;
        output[c][f] = this._ring[rc][rp];
      }
    }
    this._readPos = (this._readPos + quantum) % this._ringSize;
    this._filled -= quantum;
    this._consecutiveUnderruns = 0;
    this._postBufferStatus();
    return true;
  }
}

registerProcessor('lossless-audio-processor', LosslessAudioProcessor);
