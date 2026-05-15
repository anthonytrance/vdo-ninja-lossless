/**
 * VDO.Ninja Lossless DC AudioWorklet Processor v1.0.0
 *
 * Registered as: 'lossless-audio-processor'
 * Loaded by viewer.js via AudioContext.audioWorklet.addModule()
 *
 * Protocol:
 *   main → worklet:  { type: 'frame', samples: Float32Array.buffer, channels: N }
 *   worklet → main:  { type: 'underrun' }
 */
class LosslessAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ch = (options && options.processorOptions && options.processorOptions.channels) || 2;
    this._channels = ch;

    // Ring buffer: 4096 frames per channel (at 48kHz = ~85ms of headroom)
    this._ringSize = 4096;
    this._ring     = new Array(ch).fill(null).map(() => new Float32Array(this._ringSize));
    this._writePos = 0;
    this._readPos  = 0;
    this._filled   = 0;  // samples per channel currently buffered

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
        // If source has fewer channels than output, clamp to last available
        const sc = c < srcChannels ? c : srcChannels - 1;
        this._ring[c][wp] = interleaved[f * srcChannels + sc];
      }
    }
    this._writePos = (this._writePos + frames) % this._ringSize;
    this._filled   = Math.min(this._filled + frames, this._ringSize);
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const quantum = output[0] ? output[0].length : 128;

    if (this._filled < quantum) {
      // Not enough data — output silence, report underrun
      for (const ch of output) ch.fill(0);
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
    return true;
  }
}

registerProcessor('lossless-audio-processor', LosslessAudioProcessor);
