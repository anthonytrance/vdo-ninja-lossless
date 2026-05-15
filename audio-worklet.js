/**
 * VDO.Ninja Lossless DC AudioWorklet Processor v1.1.0-test
 *
 * Registered as: 'lossless-audio-processor'
 * Loaded by viewer.js via AudioContext.audioWorklet.addModule()
 */
const LOSSLESS_WORKLET_VERSION = '1.1.0-test';

class LosslessAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ch = (options && options.processorOptions && options.processorOptions.channels) || 2;
    this._channels = ch;

    this._ringSize = 1024;
    this._ring = new Array(ch).fill(null).map(() => new Float32Array(this._ringSize));
    this._writePos = 0;
    this._readPos = 0;
    this._filled = 0;
    this._underruns = 0;
    this._overflows = 0;
    this._processed = 0;

    this.port.postMessage({ type: 'version', version: LOSSLESS_WORKLET_VERSION });
    this.port.onmessage = (ev) => {
      if (ev.data.type === 'frame') this._enqueue(ev.data.samples, ev.data.channels || ch);
    };
  }

  _enqueue(buffer, srcChannels) {
    const interleaved = new Float32Array(buffer);
    const frames = Math.floor(interleaved.length / srcChannels);
    if (frames <= 0) return;

    const overflow = Math.max(0, this._filled + frames - this._ringSize);
    if (overflow > 0) {
      this._readPos = (this._readPos + overflow) % this._ringSize;
      this._filled -= overflow;
      this._overflows++;
    }

    for (let f = 0; f < frames; f++) {
      const wp = (this._writePos + f) % this._ringSize;
      for (let c = 0; c < this._channels; c++) {
        const sc = c < srcChannels ? c : srcChannels - 1;
        this._ring[c][wp] = interleaved[f * srcChannels + sc] || 0;
      }
    }
    this._writePos = (this._writePos + frames) % this._ringSize;
    this._filled = Math.min(this._filled + frames, this._ringSize);
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const quantum = output[0] ? output[0].length : 128;

    if (this._filled < quantum) {
      for (const ch of output) ch.fill(0);
      this._underruns++;
      this.port.postMessage({ type: 'underrun' });
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
    this._processed++;
    if ((this._processed & 31) === 0) {
      this.port.postMessage({
        type: 'stats',
        version: LOSSLESS_WORKLET_VERSION,
        bufferDepth: this._filled,
        underruns: this._underruns,
        overflows: this._overflows,
      });
    }
    return true;
  }
}

registerProcessor('lossless-audio-processor', LosslessAudioProcessor);
