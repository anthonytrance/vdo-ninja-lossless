/**
 * VDO.Ninja Lossless DC AudioWorklet Processor v1.0.11
 *
 * Registered as: 'lossless-audio-processor'
 * Loaded by viewer.js via AudioContext.audioWorklet.addModule()
 *
 * Protocol:
 *   main -> worklet: { type: 'frame', samples: Float32Array.buffer, channels: N }
 *   worklet -> main: { type: 'underrun' } | { type: 'arming', armed: bool } | { type: 'buffer' }
 */
const DEFAULT_ARMING_TARGET_FRAMES = 576;
const REARM_UNDERRUN_TICKS = 8;
const BUFFER_STATUS_TICKS = 50;

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
