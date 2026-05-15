/**
 * VDO.Ninja Lossless DC Viewer v1.0.1
 *
 * Inject via:  &js=https://anthonytrance.github.io/vdo-ninja-lossless/viewer.js
 *
 * What this does:
 *   - Monkey-patches RTCPeerConnection so every new PC immediately creates the
 *     negotiated lossless DataChannel (id=42, label="lossless-audio-v1").
 *   - When the publisher sends the JSON handshake + binary PCM frames over that
 *     DC, this script decodes them via an AudioWorklet and plays them out.
 *   - Mutes the VDO.Ninja Opus <audio> element for that peer once DC frames arrive.
 *   - Falls back to Opus automatically if DC goes silent for 2 seconds.
 *   - Logs stats to console every second and shows a small status overlay.
 *   - Screen reader: a separate hidden aria-live region announces only on
 *     state changes (IDLE → LOSSLESS ACTIVE, etc.), not every stats tick.
 */
(function () {
  'use strict';

  const VERSION     = '1.0.1';
  const DC_ID       = 42;
  const DC_LABEL    = 'lossless-audio-v1';
  const DC_PROTOCOL = 'vdo-ninja-hifi-1';
  const FALLBACK_MS = 2000;
  const FMT_INT16   = 0;
  const FMT_FLOAT32 = 1;

  // -------------------------------------------------------------------------
  // Logging helpers
  // -------------------------------------------------------------------------
  function log(msg)  { console.log(`[lossless-dc v${VERSION}] ${msg}`); }
  function warn(msg) { console.warn(`[lossless-dc v${VERSION}] ${msg}`); }

  // -------------------------------------------------------------------------
  // Resolve worklet URL from &js= query parameter or document.currentScript
  // -------------------------------------------------------------------------
  function _getWorkletUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      for (const [, val] of params) {
        if (val && val.includes('viewer.js')) {
          return val.replace(/viewer\.js(\?.*)?$/, '') + 'audio-worklet.js';
        }
      }
    } catch (_) {}
    if (document.currentScript && document.currentScript.src) {
      return document.currentScript.src.replace(/viewer\.js(\?.*)?$/, '') + 'audio-worklet.js';
    }
    return 'https://anthonytrance.github.io/vdo-ninja-lossless/audio-worklet.js';
  }

  // -------------------------------------------------------------------------
  // Per-PC state
  // -------------------------------------------------------------------------
  const _peers = new Map();

  function _newPeer(pc, dc) {
    return {
      pc, dc,
      stream:       null,
      handshake:    null,
      audioEl:      null,
      savedVolume:  1.0,
      gainNode:     null,
      lastFrameMs:  0,
      lastSeq:      -1,
      frames:       0,
      underruns:    0,
      bytes:        0,
      opusRestored: false,
    };
  }

  // -------------------------------------------------------------------------
  // AudioContext + AudioWorklet (shared, created on first handshake)
  // -------------------------------------------------------------------------
  let _audioCtx = null;
  let _workletLoaded = false;
  let _workletLoading = false;

  const _workletNodes = new Map();

  // Resume AudioContext on any user gesture — browsers require a gesture before
  // audio can play, and VDO.Ninja may create the AudioContext before one happens.
  function _resumeCtxOnGesture() {
    if (_audioCtx && _audioCtx.state === 'suspended') {
      _audioCtx.resume().catch(() => {});
    }
  }
  ['click', 'keydown', 'touchstart', 'pointerdown'].forEach(evt =>
    document.addEventListener(evt, _resumeCtxOnGesture, { capture: true, passive: true })
  );

  async function _ensureAudio(sampleRate) {
    if (!_audioCtx) {
      _audioCtx = new AudioContext({ sampleRate: sampleRate || 48000 });
      log(`AudioContext created @ ${_audioCtx.sampleRate} Hz (state: ${_audioCtx.state})`);
    }
    if (_audioCtx.state === 'suspended') {
      try { await _audioCtx.resume(); } catch (_) {}
      if (_audioCtx.state === 'suspended') {
        log('AudioContext still suspended — waiting for user gesture');
      }
    }
    if (!_workletLoaded && !_workletLoading) {
      _workletLoading = true;
      const url = _getWorkletUrl();
      log(`Loading AudioWorklet from: ${url}`);
      try {
        await _audioCtx.audioWorklet.addModule(url);
        _workletLoaded = true;
        _workletLoading = false;
        log('AudioWorklet module loaded');
      } catch (e) {
        warn(`AudioWorklet load failed: ${e.message}`);
        _workletLoading = false;
        throw e;
      }
    }
    while (_workletLoading && !_workletLoaded) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  async function _buildWorkletNode(peer) {
    if (!_workletLoaded) throw new Error('worklet not loaded');
    const channels = peer.handshake.channels || 2;
    const wn = new AudioWorkletNode(_audioCtx, 'lossless-audio-processor', {
      numberOfInputs:     0,
      numberOfOutputs:    1,
      outputChannelCount: [channels],
      processorOptions:   { channels },
    });
    wn.port.onmessage = (ev) => {
      if (ev.data.type === 'underrun') {
        peer.underruns++;
        _updateOverlay();
      }
    };
    peer.gainNode = _audioCtx.createGain();
    peer.gainNode.gain.value = peer.savedVolume;
    wn.connect(peer.gainNode);
    peer.gainNode.connect(_audioCtx.destination);
    _workletNodes.set(peer.pc, wn);
    log(`AudioWorkletNode created (${channels}ch)`);
  }

  // -------------------------------------------------------------------------
  // Opus muting / restore
  // -------------------------------------------------------------------------
  function _findAudioElement(peer) {
    if (!peer.stream) return null;
    const elements = document.querySelectorAll('audio, video');
    for (const el of elements) {
      if (el.srcObject === peer.stream) return el;
    }
    const ourIds = new Set(peer.stream.getTracks().map(t => t.id));
    for (const el of elements) {
      if (el.srcObject instanceof MediaStream) {
        if (el.srcObject.getTracks().some(t => ourIds.has(t.id))) return el;
      }
    }
    return null;
  }

  function _muteOpus(peer) {
    if (peer.audioEl) return;
    const el = _findAudioElement(peer);
    if (el) {
      peer.audioEl     = el;
      peer.savedVolume = el.volume > 0 ? el.volume : 1.0;
      el.volume        = 0;
      if (peer.gainNode) peer.gainNode.gain.value = peer.savedVolume;
      log(`Opus muted — element: ${el.id || el.tagName}, saved volume=${peer.savedVolume.toFixed(2)}`);
      _startVolumePoll(peer);
    } else {
      warn('Could not find Opus audio element — both streams may play simultaneously');
    }
  }

  function _restoreOpus(peer) {
    if (peer.opusRestored) return;
    peer.opusRestored = true;
    if (peer.audioEl) {
      peer.audioEl.volume = peer.savedVolume;
      log(`Opus restored, volume=${peer.savedVolume.toFixed(2)}`);
    }
    const wn = _workletNodes.get(peer.pc);
    if (wn) { try { wn.disconnect(); } catch (_) {} _workletNodes.delete(peer.pc); }
    if (peer.gainNode) { try { peer.gainNode.disconnect(); } catch (_) {} peer.gainNode = null; }
  }

  function _startVolumePoll(peer) {
    const timer = setInterval(() => {
      if (!peer.audioEl || !peer.gainNode) { clearInterval(timer); return; }
      const elVol = peer.audioEl.volume;
      if (elVol !== 0) {
        peer.savedVolume = elVol;
        peer.gainNode.gain.value = elVol;
        const dcAge = Date.now() - peer.lastFrameMs;
        if (dcAge < FALLBACK_MS) peer.audioEl.volume = 0;
      }
      if (peer.lastFrameMs > 0 && (Date.now() - peer.lastFrameMs) > FALLBACK_MS) {
        warn(`DC silent ${FALLBACK_MS}ms — falling back to Opus`);
        _restoreOpus(peer);
        _updateOverlay();
        clearInterval(timer);
      }
    }, 250);
  }

  // -------------------------------------------------------------------------
  // DC message handler
  // -------------------------------------------------------------------------
  async function _onDcMessage(peer, ev) {
    if (!peer.handshake) {
      try {
        const text = typeof ev.data === 'string'
          ? ev.data
          : new TextDecoder().decode(ev.data instanceof ArrayBuffer ? ev.data : await ev.data.arrayBuffer());
        const hs = JSON.parse(text);
        if (hs.v !== 1) { warn(`Unknown handshake version: ${hs.v}`); peer.dc.close(); return; }
        peer.handshake = hs;
        log(`Handshake: sampleRate=${hs.sampleRate} channels=${hs.channels} format=${hs.format}`);
        await _ensureAudio(hs.sampleRate);
        await _buildWorkletNode(peer);
        _updateOverlay();
      } catch (e) {
        warn(`Bad handshake: ${e.message}`);
        peer.dc.close();
      }
      return;
    }

    const wn = _workletNodes.get(peer.pc);
    if (!wn) return;

    let buf;
    if (ev.data instanceof ArrayBuffer) {
      buf = ev.data;
    } else if (typeof ev.data.arrayBuffer === 'function') {
      buf = await ev.data.arrayBuffer();
    } else {
      return;
    }
    if (buf.byteLength < 8) return;

    const view = new DataView(buf);
    const seq  = view.getUint16(0, true);
    const fmt  = view.getUint8(4);

    if (peer.lastSeq >= 0) {
      const expected = (peer.lastSeq + 1) & 0xFFFF;
      if (seq !== expected) {
        const gap = (seq - expected + 65536) & 0xFFFF;
        peer.underruns += gap;
        warn(`Gap detected: ${gap} frame(s) lost (seq ${peer.lastSeq} → ${seq})`);
      }
    }
    peer.lastSeq = seq;
    peer.lastFrameMs = Date.now();
    peer.frames++;
    peer.bytes += buf.byteLength;

    const payload = buf.slice(8);
    let f32;
    if (fmt === FMT_INT16) {
      const i16 = new Int16Array(payload);
      f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) {
        f32[i] = i16[i] < 0 ? i16[i] / 32768 : i16[i] / 32767;
      }
    } else if (fmt === FMT_FLOAT32) {
      f32 = new Float32Array(payload.slice(0));
    } else {
      return;
    }

    wn.port.postMessage({ type: 'frame', samples: f32.buffer, channels: peer.handshake.channels }, [f32.buffer]);

    if (peer.frames === 1) {
      log('First DC frame received — muting Opus');
      _muteOpus(peer);
      _updateOverlay();
    }
  }

  // -------------------------------------------------------------------------
  // RTCPeerConnection patch
  // -------------------------------------------------------------------------
  const _OrigPC = window.RTCPeerConnection;

  function _PatchedPC(...args) {
    const pc = new _OrigPC(...args);

    const dc = pc.createDataChannel(DC_LABEL, {
      id:             DC_ID,
      negotiated:     true,
      ordered:        true,
      maxRetransmits: 0,
      protocol:       DC_PROTOCOL,
    });

    const peer = _newPeer(pc, dc);
    _peers.set(pc, peer);

    pc.addEventListener('track', (ev) => {
      if (ev.streams && ev.streams[0]) {
        peer.stream = ev.streams[0];
        log(`Remote track received, stream id=${peer.stream.id}`);
      }
    });

    dc.addEventListener('open', () => {
      log('DC open — waiting for handshake');
      _updateOverlay();
    });

    dc.addEventListener('close', () => {
      log('DC closed — Opus fallback');
      _restoreOpus(peer);
      _peers.delete(pc);
      _updateOverlay();
    });

    dc.addEventListener('error', (e) => {
      warn(`DC error: ${e.error ? e.error.message : e}`);
    });

    dc.addEventListener('message', (ev) => {
      _onDcMessage(peer, ev).catch(e => warn(`frame error: ${e.message}`));
    });

    return pc;
  }

  Object.setPrototypeOf(_PatchedPC, _OrigPC);
  _PatchedPC.prototype = _OrigPC.prototype;
  try { window.RTCPeerConnection = _PatchedPC; } catch (_) {}

  log('RTCPeerConnection patched — lossless DC ready');

  // -------------------------------------------------------------------------
  // Overlay (visual, aria-hidden) + separate hidden announcer (aria-live)
  // Screen reader only hears state transitions, not every stats tick.
  // -------------------------------------------------------------------------
  let _overlay   = null;
  let _announcer = null;
  let _lastStateStr = '';

  function _ensureOverlay() {
    if (_overlay) return;
    if (!document.body) return;

    // Hidden aria-live region: announces only on state change
    _announcer = document.createElement('div');
    _announcer.setAttribute('aria-live', 'polite');
    _announcer.setAttribute('role', 'status');
    Object.assign(_announcer.style, {
      position: 'absolute',
      left:     '-9999px',
      width:    '1px',
      height:   '1px',
      overflow: 'hidden',
    });
    document.body.appendChild(_announcer);

    // Visual overlay: aria-hidden so screen readers skip the stats chatter
    _overlay = document.createElement('div');
    _overlay.id = 'lossless-dc-status';
    _overlay.setAttribute('aria-hidden', 'true');
    Object.assign(_overlay.style, {
      position:      'fixed',
      top:           '8px',
      right:         '8px',
      zIndex:        '999999',
      background:    'rgba(0,0,0,0.80)',
      color:         '#00ff88',
      font:          '11px/1.6 monospace',
      padding:       '6px 10px',
      borderRadius:  '5px',
      pointerEvents: 'none',
      maxWidth:      '260px',
      userSelect:    'none',
    });
    document.body.appendChild(_overlay);
  }

  function _updateOverlay() {
    _ensureOverlay();
    if (!_overlay) return;

    let totalFrames = 0, totalUnderruns = 0, totalBytes = 0;
    let activePeers = 0;
    const now = Date.now();

    for (const [, p] of _peers) {
      if (!p.handshake) continue;
      totalFrames    += p.frames;
      totalUnderruns += p.underruns;
      totalBytes     += p.bytes;
      if (p.lastFrameMs > 0 && (now - p.lastFrameMs) < FALLBACK_MS) activePeers++;
    }

    const elapsed  = totalFrames * 0.01;
    const kbps     = elapsed > 0 ? Math.round((totalBytes * 8) / elapsed / 1000) : 0;
    const stateStr = activePeers > 0
      ? 'LOSSLESS ACTIVE'
      : (_peers.size > 0 ? 'OPUS FALLBACK' : 'IDLE');

    // Announce to screen reader only when state changes
    if (_announcer && stateStr !== _lastStateStr) {
      _lastStateStr = stateStr;
      _announcer.textContent = `Lossless audio: ${stateStr}`;
    }

    // Update visual overlay (aria-hidden, so no screen reader chatter)
    _overlay.innerHTML =
      `<b>Lossless DC ${VERSION}</b><br>` +
      `${stateStr}<br>` +
      `Frames: ${totalFrames}  Drops: ${totalUnderruns}<br>` +
      `~${kbps} kbps`;
  }

  // -------------------------------------------------------------------------
  // Periodic console stats (1/s)
  // -------------------------------------------------------------------------
  setInterval(() => {
    const now = Date.now();
    for (const [, p] of _peers) {
      if (!p.handshake || p.frames === 0) continue;
      const dcAge  = now - p.lastFrameMs;
      const state  = dcAge < FALLBACK_MS ? 'active' : 'silent';
      const elapsed = p.frames * 0.01;
      const kbps   = elapsed > 0 ? Math.round((p.bytes * 8) / elapsed / 1000) : 0;
      log(`stats: frames=${p.frames} underruns=${p.underruns} ~${kbps}kbps state=${state} lastFrame=${dcAge}ms ago`);
    }
    _updateOverlay();
  }, 1000);

  if (document.body) {
    _ensureOverlay();
    _updateOverlay();
  } else {
    document.addEventListener('DOMContentLoaded', () => { _ensureOverlay(); _updateOverlay(); });
  }

  log(`Loaded v${VERSION} — waiting for DC`);

})();
