/**
 * VDO.Ninja Lossless DC Viewer v1.0.3
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

  const VERSION     = '1.0.3';
  const DC_ID       = 42;
  const DC_LABEL    = 'lossless-audio-v1';
  const DC_PROTOCOL = 'vdo-ninja-hifi-1';
  const FALLBACK_MS = 2000;
  const FMT_INT16   = 0;
  const FMT_FLOAT32 = 1;

  function log(msg)  { console.log(`[lossless-dc v${VERSION}] ${msg}`); }
  function warn(msg) { console.warn(`[lossless-dc v${VERSION}] ${msg}`); }

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
             savedVolume: 1.0, gainNode: null,
             lastFrameMs: 0, lastSeq: -1,
             frames: 0, underruns: 0, bytes: 0, opusRestored: false,
             pollTimer: null };
  }

  // Global state — manual fallback / retry are page-wide, not per-peer
  let _userDisabled = false;

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
    if (_userDisabled) return;
    if (peer.audioEl) return;
    const el = _findAudioElement(peer);
    if (!el) { warn('Opus audio element not found — both streams may play simultaneously'); return; }
    peer.audioEl     = el;
    peer.savedVolume = el.volume > 0 ? el.volume : 1.0;
    el.volume        = 0;
    if (peer.gainNode) peer.gainNode.gain.value = peer.savedVolume;
    log(`Opus muted (vol=${peer.savedVolume.toFixed(2)})`);
    _startVolumePoll(peer);
  }

  function _restoreOpus(peer) {
    if (peer.opusRestored) return;
    peer.opusRestored = true;

    // The cached audioEl reference may be stale (VDO.Ninja can replace the
    // element when it re-attaches a stream). Re-find it from peer.stream if
    // the cached one is no longer in the document. Then clear `muted` and
    // call play() defensively — restoring volume alone is not enough if the
    // element ended up paused or muted while lossless had the foreground.
    let el = peer.audioEl;
    if (!el || !document.contains(el)) {
      const found = _findAudioElement(peer);
      if (found) { el = found; peer.audioEl = found; }
    }
    if (el) {
      try { if (el.muted) el.muted = false; } catch (_) {}
      try { el.volume = peer.savedVolume > 0 ? peer.savedVolume : 1.0; } catch (_) {}
      if (el.paused) { try { el.play().catch(() => {}); } catch (_) {} }
      log(`Opus restored (vol=${el.volume.toFixed(2)} muted=${el.muted} paused=${el.paused})`);
    } else {
      warn('Opus restore: no audio element found');
    }

    if (peer.pollTimer) { clearInterval(peer.pollTimer); peer.pollTimer = null; }
    const wn = _workletNodes.get(peer.pc);
    if (wn)          { try { wn.disconnect();          } catch (_) {} _workletNodes.delete(peer.pc); }
    if (peer.gainNode) { try { peer.gainNode.disconnect(); } catch (_) {} peer.gainNode = null; }
  }

  function _startVolumePoll(peer) {
    if (peer.pollTimer) clearInterval(peer.pollTimer);
    peer.pollTimer = setInterval(() => {
      if (!peer.audioEl || !peer.gainNode) { clearInterval(peer.pollTimer); peer.pollTimer = null; return; }
      const v = peer.audioEl.volume;
      if (v !== 0) {
        peer.savedVolume = v;
        peer.gainNode.gain.value = v;
        if (Date.now() - peer.lastFrameMs < FALLBACK_MS) peer.audioEl.volume = 0;
      }
      if (peer.lastFrameMs > 0 && Date.now() - peer.lastFrameMs > FALLBACK_MS) {
        warn('DC silent — Opus fallback');
        _restoreOpus(peer); _updateOverlay();
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
        if (hs.v !== 1) { warn(`Unknown handshake version ${hs.v}`); peer.dc.close(); return; }
        peer.handshake = hs;
        log(`Handshake: ${hs.sampleRate}Hz ${hs.channels}ch ${hs.format}`);
        if (_userDisabled) {
          log('User disabled lossless — handshake parsed but worklet not built');
          _updateOverlay();
          return;
        }
        await _ensureAudio(hs.sampleRate);
        await _buildWorkletNode(peer);
        _updateOverlay();
      } catch (e) { warn(`Bad handshake: ${e.message}`); peer.dc.close(); }
      return;
    }

    const wn = _workletNodes.get(peer.pc);
    if (!wn) return;

    let buf;
    if (ev.data instanceof ArrayBuffer)             buf = ev.data;
    else if (typeof ev.data.arrayBuffer === 'function') buf = await ev.data.arrayBuffer();
    else return;
    if (buf.byteLength < 8) return;

    const view = new DataView(buf);
    const seq  = view.getUint16(0, true);
    const fmt  = view.getUint8(4);

    if (peer.lastSeq >= 0) {
      const exp = (peer.lastSeq + 1) & 0xFFFF;
      if (seq !== exp) {
        const gap = (seq - exp + 65536) & 0xFFFF;
        peer.underruns += gap;
        warn(`Gap: ${gap} frame(s) (seq ${peer.lastSeq} → ${seq})`);
      }
    }
    peer.lastSeq = seq; peer.lastFrameMs = Date.now();
    peer.frames++; peer.bytes += buf.byteLength;

    const payload = buf.slice(8);
    let f32;
    if (fmt === FMT_INT16) {
      const i16 = new Int16Array(payload);
      f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] < 0 ? i16[i] / 32768 : i16[i] / 32767;
    } else if (fmt === FMT_FLOAT32) {
      f32 = new Float32Array(payload.slice(0));
    } else { return; }

    wn.port.postMessage({ type: 'frame', samples: f32.buffer, channels: peer.handshake.channels }, [f32.buffer]);

    if (peer.frames === 1) { log('First DC frame — muting Opus'); _muteOpus(peer); _updateOverlay(); }
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
  // Overlay — keyboard-accessible status panel + persistent Disable/Retry buttons.
  // The overlay is part of the a11y tree so screen-reader users can tab to it
  // and read the stats. A hidden aria-live region also announces state-change
  // transitions ("Lossless audio: ACTIVE / OPUS FALLBACK / DISABLED").
  //
  // Buttons are real DOM nodes created once with direct click listeners. We
  // never replace them via innerHTML — only text nodes update each tick —
  // so screen-reader focus on a button survives stat refreshes.
  // -------------------------------------------------------------------------
  let _overlay      = null;
  let _announcer    = null;
  let _lastStateStr = '';
  let _stateNode    = null;
  let _statsNode    = null;
  let _disableBtn   = null;
  let _retryBtn     = null;

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
    _overlay.setAttribute('aria-label', 'Lossless audio status');
    _overlay.setAttribute('tabindex', '0');
    Object.assign(_overlay.style, {
      position: 'fixed', top: '8px', right: '8px', zIndex: '999999',
      background: 'rgba(0,0,0,0.80)', color: '#00ff88',
      font: '11px/1.6 monospace', padding: '6px 10px', borderRadius: '5px',
      pointerEvents: 'auto', maxWidth: '320px', userSelect: 'text',
    });

    const title = document.createElement('div');
    title.innerHTML = `<b>Lossless DC ${VERSION}</b>`;
    _overlay.appendChild(title);

    _stateNode = document.createElement('div');
    _stateNode.textContent = 'IDLE';
    _overlay.appendChild(_stateNode);

    _statsNode = document.createElement('div');
    _statsNode.textContent = 'Frames: 0  Drops: 0  ~0 kbps';
    _overlay.appendChild(_statsNode);

    const btnRow = document.createElement('div');
    btnRow.style.marginTop = '4px';

    _disableBtn = document.createElement('button');
    _disableBtn.type = 'button';
    _disableBtn.textContent = 'Disable lossless';
    _disableBtn.setAttribute('aria-label', 'Disable lossless audio and force Opus');
    _disableBtn.style.marginRight = '4px';
    _disableBtn.addEventListener('click', _onDisableClick);

    _retryBtn = document.createElement('button');
    _retryBtn.type = 'button';
    _retryBtn.textContent = 'Retry lossless';
    _retryBtn.setAttribute('aria-label', 'Retry lossless audio after fallback');
    _retryBtn.addEventListener('click', _onRetryClick);

    btnRow.appendChild(_disableBtn);
    btnRow.appendChild(_retryBtn);
    _overlay.appendChild(btnRow);

    document.body.appendChild(_overlay);
  }

  function _computeStateStr() {
    if (_userDisabled) return 'LOSSLESS DISABLED';
    let activePeers = 0;
    const now = Date.now();
    for (const [, p] of _peers) {
      if (!p.handshake) continue;
      if (p.lastFrameMs > 0 && (now - p.lastFrameMs) < FALLBACK_MS && !p.opusRestored) activePeers++;
    }
    if (activePeers > 0) return 'LOSSLESS ACTIVE';
    if (_peers.size > 0) return 'OPUS FALLBACK';
    return 'IDLE';
  }

  function _updateOverlay() {
    _ensureOverlay();
    if (!_overlay) return;
    let totalFrames = 0, totalUnderruns = 0, totalBytes = 0;
    for (const [, p] of _peers) {
      if (!p.handshake) continue;
      totalFrames    += p.frames;
      totalUnderruns += p.underruns;
      totalBytes     += p.bytes;
    }
    const elapsed  = totalFrames * 0.01;
    const kbps     = elapsed > 0 ? Math.round((totalBytes * 8) / elapsed / 1000) : 0;
    const stateStr = _computeStateStr();

    if (_stateNode) _stateNode.textContent = stateStr;
    if (_statsNode) _statsNode.textContent = `Frames: ${totalFrames}  Drops: ${totalUnderruns}  ~${kbps} kbps`;

    // Conditional visibility — Disable when lossless is playing, Retry when Opus is.
    if (_disableBtn) {
      const show = stateStr === 'LOSSLESS ACTIVE';
      _disableBtn.style.display = show ? '' : 'none';
      _disableBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
    }
    if (_retryBtn) {
      const show = stateStr === 'OPUS FALLBACK' || stateStr === 'LOSSLESS DISABLED';
      _retryBtn.style.display = show ? '' : 'none';
      _retryBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
    }

    if (_announcer && stateStr !== _lastStateStr) {
      _lastStateStr = stateStr;
      _announcer.textContent = `Lossless audio: ${stateStr}`;
    }
  }

  function _onDisableClick() {
    log('Disable lossless clicked');
    _userDisabled = true;
    for (const [, peer] of _peers) {
      if (peer.handshake) _restoreOpus(peer);
    }
    _updateOverlay();
  }

  async function _onRetryClick() {
    log('Retry lossless clicked');
    _userDisabled = false;
    for (const [, peer] of _peers) {
      if (!peer.handshake) continue;
      peer.opusRestored = false;
      peer.frames = 0;
      peer.lastFrameMs = 0;
      peer.lastSeq = -1;
      // Drop cached audio element ref so the next mute re-discovers it
      peer.audioEl = null;
      try { await _buildWorkletNode(peer); } catch (e) { warn(`retry rebuild failed: ${e.message}`); }
    }
    _updateOverlay();
  }

  setInterval(() => {
    const now = Date.now();
    for (const [, p] of _peers) {
      if (!p.handshake || p.frames === 0) continue;
      const age = now - p.lastFrameMs;
      log(`stats: frames=${p.frames} underruns=${p.underruns} ~${Math.round((p.bytes * 8) / (p.frames * 0.01) / 1000)}kbps state=${age < FALLBACK_MS ? 'active' : 'silent'} lastFrame=${age}ms ago`);
    }
    _updateOverlay();
  }, 1000);

  if (document.body) { _ensureOverlay(); _updateOverlay(); }
  else document.addEventListener('DOMContentLoaded', () => { _ensureOverlay(); _updateOverlay(); });

  log(`Loaded v${VERSION}`);
})();
