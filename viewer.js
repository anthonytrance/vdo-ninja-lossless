/**
 * VDO.Ninja Lossless DC Viewer v1.1.0-test
 *
 * Inject via:  &js=https://anthonytrance.github.io/vdo-ninja-lossless/viewer.js
 *
 * Root cause of v1.0.0/1.0.1 "IDLE" bug:
 *   VDO.Ninja captures `const PC = window.RTCPeerConnection` at startup.
 *   Replacing window.RTCPeerConnection later (constructor patch) has no effect
 *   because VDO.Ninja uses its cached reference.  Fix: patch the prototype
 *   methods instead — those are shared by every instance regardless of which
 *   reference was used to construct it.
 */
(function () {
  'use strict';

  const VERSION     = '1.1.0-test';
  const PROTOCOL_VERSION = 2;
  const DC_ID       = 42;
  const DC_LABEL    = 'lossless-audio-v1';
  const DC_PROTOCOL = 'vdo-ninja-hifi-1';
  const FALLBACK_MS = 750;
  const FMT_INT16   = 0;
  const FMT_FLOAT32 = 1;
  const FRAME_KIND_AUDIO = 0;
  const FRAME_KIND_FEC = 1;
  const FEC_GROUP_SIZE = 4;

  function log(msg)  { console.log(`[lossless-dc v${VERSION}] ${msg}`); }
  function warn(msg) { console.warn(`[lossless-dc v${VERSION}] ${msg}`); }

  let _losslessDisabled = false;
  let _showStats = true;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('losslessStats') === '0' || params.get('losslessStats') === 'false') _showStats = false;
  } catch (_) {}

  // -------------------------------------------------------------------------
  // Worklet URL resolution
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
  const _peers = new Map();   // WeakMap would be cleaner but Map is fine here

  function _newPeer(pc, dc) {
    return { pc, dc, stream: null, handshake: null, audioEl: null,
             savedVolume: 1.0, savedMuted: false, gainNode: null,
             lastFrameMs: 0, lastSeq: -1,
             expectedSeq: null, pendingAudio: new Map(), pendingFec: new Map(), recentAudio: new Map(),
             frames: 0, underruns: 0, lateFrames: 0, fecRepaired: 0,
             fecUnrepaired: 0, zeroFilled: 0, bytes: 0, opusRestored: false };
  }

  // -------------------------------------------------------------------------
  // AudioContext + AudioWorklet (shared)
  // -------------------------------------------------------------------------
  let _audioCtx       = null;
  let _workletLoaded  = false;
  let _workletLoading = false;
  const _workletNodes = new Map();

  // Browsers require a user gesture before audio can play.
  // Resume whenever the user interacts with the page.
  function _resumeCtxOnGesture() {
    if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  }
  ['click', 'keydown', 'touchstart', 'pointerdown'].forEach(t =>
    document.addEventListener(t, _resumeCtxOnGesture, { capture: true, passive: true })
  );

  async function _ensureAudio(sampleRate) {
    if (!_audioCtx) {
      _audioCtx = new AudioContext({ sampleRate: sampleRate || 48000 });
      log(`AudioContext created @ ${_audioCtx.sampleRate} Hz (state: ${_audioCtx.state})`);
    }
    if (_audioCtx.state === 'suspended') {
      try { await _audioCtx.resume(); } catch (_) {}
    }
    if (!_workletLoaded && !_workletLoading) {
      _workletLoading = true;
      const url = _getWorkletUrl();
      log(`Loading AudioWorklet: ${url}`);
      try {
        await _audioCtx.audioWorklet.addModule(url);
        _workletLoaded  = true;
        _workletLoading = false;
        log('AudioWorklet loaded');
      } catch (e) {
        _workletLoading = false;
        warn(`AudioWorklet failed: ${e.message}`);
        throw e;
      }
    }
    while (_workletLoading && !_workletLoaded) await new Promise(r => setTimeout(r, 50));
  }

  async function _buildWorkletNode(peer) {
    const channels = peer.handshake.channels || 2;
    const wn = new AudioWorkletNode(_audioCtx, 'lossless-audio-processor', {
      numberOfInputs: 0, numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: { channels },
    });
    wn.port.onmessage = (ev) => {
      if (ev.data.type === 'underrun') { peer.underruns++; _updateOverlay(); }
      if (ev.data.type === 'stats') {
        peer.bufferDepth = ev.data.bufferDepth || 0;
        peer.workletUnderruns = ev.data.underruns || 0;
        peer.workletOverflows = ev.data.overflows || 0;
      }
      if (ev.data.type === 'version') window.__LOSSLESS_WORKLET_VERSION = ev.data.version;
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
    for (const el of document.querySelectorAll('audio, video')) {
      if (el.srcObject === peer.stream) return el;
    }
    const ourIds = new Set(peer.stream.getTracks().map(t => t.id));
    for (const el of document.querySelectorAll('audio, video')) {
      if (el.srcObject instanceof MediaStream &&
          el.srcObject.getTracks().some(t => ourIds.has(t.id))) return el;
    }
    return null;
  }

  function _muteOpus(peer) {
    if (peer.audioEl) return;
    const el = _findAudioElement(peer);
    if (!el) { warn('Opus audio element not found — both streams may play simultaneously'); return; }
    peer.audioEl     = el;
    peer.savedVolume = el.volume > 0 ? el.volume : 1.0;
    peer.savedMuted  = !!el.muted;
    el.volume        = 0;
    if (peer.gainNode) peer.gainNode.gain.value = peer.savedMuted ? 0 : peer.savedVolume;
    log(`Opus muted (vol=${peer.savedVolume.toFixed(2)})`);
    _startVolumePoll(peer);
  }

  function _restoreOpus(peer) {
    if (peer.opusRestored) return;
    peer.opusRestored = true;
    if (peer.audioEl) { peer.audioEl.volume = peer.savedVolume; log('Opus restored'); }
    const wn = _workletNodes.get(peer.pc);
    if (wn)          { try { wn.disconnect();          } catch (_) {} _workletNodes.delete(peer.pc); }
    if (peer.gainNode) { try { peer.gainNode.disconnect(); } catch (_) {} peer.gainNode = null; }
  }

  function _startVolumePoll(peer) {
    const t = setInterval(() => {
      if (!peer.audioEl || !peer.gainNode) { clearInterval(t); return; }
      const v = peer.audioEl.volume;
      if (v !== 0) {
        peer.savedVolume = v;
        peer.gainNode.gain.value = peer.savedMuted ? 0 : v;
        if (Date.now() - peer.lastFrameMs < FALLBACK_MS) peer.audioEl.volume = 0;
      }
      if (peer.audioEl.muted !== peer.savedMuted) {
        peer.savedMuted = !!peer.audioEl.muted;
        peer.gainNode.gain.value = peer.savedMuted ? 0 : peer.savedVolume;
      }
      if (peer.lastFrameMs > 0 && Date.now() - peer.lastFrameMs > FALLBACK_MS) {
        warn('DC silent — Opus fallback');
        _restoreOpus(peer); _updateOverlay(); clearInterval(t);
      }
    }, 250);
  }

  // -------------------------------------------------------------------------
  // DC message handler
  // -------------------------------------------------------------------------
  function _seqDistance(from, to) {
    return (to - from + 65536) & 0xFFFF;
  }

  function _groupBase(seq, groupSize) {
    return seq - (seq % groupSize);
  }

  function _xorInto(target, source) {
    for (let i = 0; i < target.length; i++) target[i] ^= source[i] || 0;
  }

  function _decodePacket(peer, packet) {
    if (packet.fmt === FMT_INT16) {
      const i16 = new Int16Array(packet.payload.slice(0));
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] < 0 ? i16[i] / 32768 : i16[i] / 32767;
      return f32;
    }
    if (packet.fmt === FMT_FLOAT32) return new Float32Array(packet.payload.slice(0));
    return new Float32Array((peer.handshake && peer.handshake.channels || 2) * 480);
  }

  function _nearestPendingSeq(peer) {
    let best = null;
    for (const seq of peer.pendingAudio.keys()) {
      if (_seqDistance(peer.expectedSeq, seq) >= 32768) continue;
      if (best === null || _seqDistance(peer.expectedSeq, seq) < _seqDistance(peer.expectedSeq, best)) best = seq;
    }
    return best;
  }

  function _tryRepair(peer, missingSeq) {
    const groupSize = (peer.handshake && peer.handshake.fecGroupSize) || FEC_GROUP_SIZE;
    const base = _groupBase(missingSeq, groupSize);
    const fec = peer.pendingFec.get(base);
    if (!fec) return null;
    let missingCount = 0;
    const payload = fec.payload.slice(0);
    for (let i = 0; i < groupSize; i++) {
      const seq = (base + i) & 0xFFFF;
      if (seq === missingSeq) { missingCount++; continue; }
      const packet = peer.pendingAudio.get(seq) || peer.recentAudio.get(seq);
      if (!packet) { missingCount++; continue; }
      _xorInto(new Uint8Array(payload), new Uint8Array(packet.payload));
    }
    if (missingCount !== 1) return null;
    peer.fecRepaired++;
    return { seq: missingSeq, frames: fec.frames, fmt: fec.fmt, channels: fec.channels, payload, repaired: true };
  }

  function _postPacket(peer, packet, zeroFilled) {
    const wn = _workletNodes.get(peer.pc);
    if (!wn || _losslessDisabled) return;
    const channels = packet.channels || (peer.handshake && peer.handshake.channels) || 2;
    const f32 = zeroFilled ? new Float32Array(channels * 480) : _decodePacket(peer, packet);
    wn.port.postMessage({ type: 'frame', samples: f32.buffer, channels }, [f32.buffer]);
    if (!zeroFilled) {
      peer.recentAudio.set(packet.seq, packet);
      while (peer.recentAudio.size > 64) peer.recentAudio.delete(peer.recentAudio.keys().next().value);
    }
    peer.lastFrameMs = Date.now();
    peer.frames++;
    if (zeroFilled) peer.zeroFilled++;
    if (peer.frames === 1 || peer.opusRestored) {
      log('Lossless frame active - muting Opus');
      peer.opusRestored = false;
      _muteOpus(peer);
      _updateOverlay();
    }
  }

  function _flushPeer(peer) {
    if (peer.expectedSeq === null) return;
    let guard = 0;
    while (guard++ < 256) {
      const packet = peer.pendingAudio.get(peer.expectedSeq);
      if (packet) {
        peer.pendingAudio.delete(peer.expectedSeq);
        _postPacket(peer, packet, false);
        peer.expectedSeq = (peer.expectedSeq + 1) & 0xFFFF;
        continue;
      }
      const repaired = _tryRepair(peer, peer.expectedSeq);
      if (repaired) {
        _postPacket(peer, repaired, false);
        peer.expectedSeq = (peer.expectedSeq + 1) & 0xFFFF;
        continue;
      }
      const nextSeq = _nearestPendingSeq(peer);
      if (nextSeq === null) break;
      const gap = _seqDistance(peer.expectedSeq, nextSeq);
      if (gap > 0 && gap < FEC_GROUP_SIZE) break;
      peer.underruns++;
      peer.fecUnrepaired++;
      _postPacket(peer, {
        seq: peer.expectedSeq,
        frames: 480,
        fmt: FMT_FLOAT32,
        channels: (peer.handshake && peer.handshake.channels) || 2,
        payload: new ArrayBuffer(0),
      }, true);
      peer.expectedSeq = (peer.expectedSeq + 1) & 0xFFFF;
    }
  }

  async function _onDcMessage(peer, ev) {
    if (!peer.handshake) {
      try {
        const text = typeof ev.data === 'string'
          ? ev.data
          : new TextDecoder().decode(ev.data instanceof ArrayBuffer ? ev.data : await ev.data.arrayBuffer());
        const hs = JSON.parse(text);
        if (!hs.v || hs.v > PROTOCOL_VERSION) { warn(`Unknown handshake version ${hs.v}`); peer.dc.close(); return; }
        peer.handshake = hs;
        log(`Handshake: ${hs.sampleRate}Hz ${hs.channels}ch ${hs.format}`);
        try { peer.dc.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ack', lossless: true, viewer: VERSION })); } catch (_) {}
        await _ensureAudio(hs.sampleRate);
        await _buildWorkletNode(peer);
        _updateOverlay();
      } catch (e) { warn(`Bad handshake: ${e.message}`); peer.dc.close(); }
      return;
    }

    let buf;
    if (ev.data instanceof ArrayBuffer)             buf = ev.data;
    else if (typeof ev.data.arrayBuffer === 'function') buf = await ev.data.arrayBuffer();
    else return;
    if (buf.byteLength < 8) return;

    const view = new DataView(buf);
    const seq = view.getUint16(0, true);
    const frames = view.getUint16(2, true);
    const fmt = view.getUint8(4);
    const channels = view.getUint8(5);
    const kind = view.getUint8(6);
    const groupSize = view.getUint8(7) || FEC_GROUP_SIZE;
    const payload = buf.slice(8);
    if (fmt !== FMT_INT16 && fmt !== FMT_FLOAT32) return;

    if (kind === FRAME_KIND_FEC) {
      peer.pendingFec.set(seq, { seq, frames, fmt, channels, groupSize, payload });
      _flushPeer(peer);
      _updateOverlay();
      return;
    }
    if (kind !== FRAME_KIND_AUDIO) return;

    if (peer.expectedSeq === null) peer.expectedSeq = seq;
    else if (_seqDistance(peer.expectedSeq, seq) >= 32768) {
      peer.lateFrames++;
      return;
    }
    if (peer.lastSeq >= 0 && seq !== ((peer.lastSeq + 1) & 0xFFFF)) peer.lateFrames++;
    peer.lastSeq = seq;
    peer.bytes += buf.byteLength;
    peer.pendingAudio.set(seq, { seq, frames, fmt, channels, groupSize, payload });
    _flushPeer(peer);
    _updateOverlay();
  }

  // -------------------------------------------------------------------------
  // Attach DC to a PeerConnection (idempotent — safe to call multiple times)
  // -------------------------------------------------------------------------
  function _attachDcToPc(pc) {
    if (_peers.has(pc)) return;   // already attached
    let dc;
    try {
      dc = pc.createDataChannel(DC_LABEL, {
        id: DC_ID, negotiated: true, ordered: true, maxRetransmits: 0, protocol: DC_PROTOCOL,
      });
    } catch (e) {
      warn(`createDataChannel failed: ${e.message}`);
      return;
    }

    const peer = _newPeer(pc, dc);
    _peers.set(pc, peer);

    pc.addEventListener('track', (ev) => {
      if (ev.streams && ev.streams[0]) {
        peer.stream = ev.streams[0];
        log(`Track received, stream=${peer.stream.id}`);
      }
    });

    dc.addEventListener('open',    ()  => { log('DC open');                         _updateOverlay(); });
    dc.addEventListener('close',   ()  => { log('DC closed'); _restoreOpus(peer);   _peers.delete(pc); _updateOverlay(); });
    dc.addEventListener('error',   (e) => { warn(`DC error: ${e.error ? e.error.message : e}`); });
    dc.addEventListener('message', (ev) => { _onDcMessage(peer, ev).catch(e => warn(`frame error: ${e.message}`)); });

    log(`DC attached to PC (state=${pc.signalingState})`);
    _updateOverlay();
  }

  // -------------------------------------------------------------------------
  // Prototype patches — affect ALL RTCPeerConnection instances, including ones
  // created before this script ran (VDO.Ninja caches the constructor reference).
  // -------------------------------------------------------------------------
  const _proto            = window.RTCPeerConnection.prototype;
  const _origCreateOffer  = _proto.createOffer;
  const _origSetRemote    = _proto.setRemoteDescription;
  const _origCreateAnswer = _proto.createAnswer;

  _proto.createOffer = async function (...args) {
    _attachDcToPc(this);
    return _origCreateOffer.apply(this, args);
  };

  _proto.setRemoteDescription = async function (desc, ...rest) {
    _attachDcToPc(this);
    return _origSetRemote.call(this, desc, ...rest);
  };

  _proto.createAnswer = async function (...args) {
    _attachDcToPc(this);
    return _origCreateAnswer.apply(this, args);
  };

  log('RTCPeerConnection prototype patched — lossless DC ready');

  // -------------------------------------------------------------------------
  // Overlay (visual, aria-hidden) + hidden aria-live announcer (state changes only)
  // -------------------------------------------------------------------------
  let _overlay      = null;
  let _announcer    = null;
  let _lastStateStr = '';

  function _ensureOverlay() {
    if (_overlay) return;
    if (!document.body) return;

    _announcer = document.createElement('div');
    _announcer.setAttribute('aria-live', 'polite');
    _announcer.setAttribute('role', 'status');
    Object.assign(_announcer.style, { position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden' });
    document.body.appendChild(_announcer);

    _overlay = document.createElement('div');
    _overlay.id = 'lossless-dc-status';
    _overlay.setAttribute('role', 'region');
    _overlay.setAttribute('aria-label', 'Lossless audio testing panel');
    Object.assign(_overlay.style, {
      position: 'fixed', top: '8px', right: '8px', zIndex: '999999',
      background: 'rgba(0,0,0,0.80)', color: '#00ff88',
      font: '11px/1.6 monospace', padding: '6px 10px', borderRadius: '5px',
      pointerEvents: 'auto', maxWidth: '320px', userSelect: 'none',
    });
    _overlay.addEventListener('click', (ev) => {
      const action = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-lossless-action');
      if (action === 'disable') {
        _losslessDisabled = true;
        for (const [, peer] of _peers) {
          peer.opusRestored = true;
          if (peer.audioEl) peer.audioEl.volume = peer.savedVolume;
        }
        _updateOverlay();
      } else if (action === 'retry') {
        _losslessDisabled = false;
        for (const [, peer] of _peers) {
          peer.opusRestored = false;
          peer.frames = 0;
          peer.expectedSeq = null;
          peer.pendingAudio.clear();
          peer.pendingFec.clear();
          peer.recentAudio.clear();
        }
        _updateOverlay();
      }
    });
    document.body.appendChild(_overlay);
  }

  function _updateOverlay() {
    _ensureOverlay();
    if (!_overlay) return;
    let totalFrames = 0, totalUnderruns = 0, totalBytes = 0, activePeers = 0;
    let repaired = 0, unrepaired = 0, lateFrames = 0, zeroFilled = 0, bufferDepth = 0;
    const now = Date.now();
    for (const [, p] of _peers) {
      if (!p.handshake) continue;
      totalFrames    += p.frames;
      totalUnderruns += p.underruns;
      totalBytes     += p.bytes;
      repaired       += p.fecRepaired;
      unrepaired     += p.fecUnrepaired;
      lateFrames     += p.lateFrames;
      zeroFilled     += p.zeroFilled;
      bufferDepth    += p.bufferDepth || 0;
      if (!_losslessDisabled && p.lastFrameMs > 0 && (now - p.lastFrameMs) < FALLBACK_MS) activePeers++;
    }
    const elapsed  = totalFrames * 0.01;
    const kbps     = elapsed > 0 ? Math.round((totalBytes * 8) / elapsed / 1000) : 0;
    const stateStr = _losslessDisabled ? 'LOSSLESS DISABLED' : (activePeers > 0 ? 'LOSSLESS ACTIVE' : (_peers.size > 0 ? 'OPUS FALLBACK' : 'IDLE'));

    if (_announcer && stateStr !== _lastStateStr) {
      _lastStateStr = stateStr;
      _announcer.textContent = `Lossless audio: ${stateStr}`;
    }
    const statsHtml = _showStats
      ? `<div aria-hidden="true">` +
        `Protocol: ${PROTOCOL_VERSION}  Worklet: ${window.__LOSSLESS_WORKLET_VERSION || 'loading'}<br>` +
        `Frames: ${totalFrames}  Drops: ${totalUnderruns}  Late: ${lateFrames}<br>` +
        `FEC: ${repaired}/${unrepaired}  Zero: ${zeroFilled}<br>` +
        `Buffer: ${Math.round(bufferDepth)}fr  Last: ${activePeers ? 'live' : 'idle'}<br>` +
        `~${kbps} kbps` +
        `</div>`
      : '';
    _overlay.innerHTML =
      `<b>Lossless DC ${VERSION}</b><br><span>${stateStr}</span><br>` +
      `<button type="button" data-lossless-action="disable" style="margin:4px 4px 4px 0">Disable lossless</button>` +
      `<button type="button" data-lossless-action="retry" style="margin:4px 0">Retry lossless</button>` +
      statsHtml;
  }

  setInterval(() => {
    _updateOverlay();
  }, 1000);

  if (document.body) { _ensureOverlay(); _updateOverlay(); }
  else document.addEventListener('DOMContentLoaded', () => { _ensureOverlay(); _updateOverlay(); });

  log(`Loaded v${VERSION}`);
})();
