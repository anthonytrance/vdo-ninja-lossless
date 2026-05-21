/**
 * VDO.Ninja Lossless DC Viewer v1.0.29
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

  const VERSION     = '1.0.30';
  const DEBUG_ON    = (() => {
    try {
      const truthy = (v) => v === '1' || v === 'true';
      const pageParams = new URLSearchParams(window.location.search);
      for (const name of ['dcDebug', 'losslessDebug', 'debug']) {
        const v = pageParams.get(name);
        if (truthy(v)) return true;
      }
      for (const [, val] of pageParams) {
        if (val && val.includes('viewer.js')) {
          try {
            const scriptUrl = new URL(val, window.location.href);
            for (const name of ['dcDebug', 'losslessDebug', 'debug']) {
              if (truthy(scriptUrl.searchParams.get(name))) return true;
            }
          } catch (_) {}
        }
      }
      if (document.currentScript && document.currentScript.src) {
        const scriptUrl = new URL(document.currentScript.src, window.location.href);
        for (const name of ['dcDebug', 'losslessDebug', 'debug']) {
          if (truthy(scriptUrl.searchParams.get(name))) return true;
        }
      }
    } catch (_) {
    }
    return false;
  })();
  const DC_ID       = 42;
  const DC_LABEL    = 'lossless-audio-v1';
  const DC_PROTOCOL = 'vdo-ninja-hifi-1';
  const FALLBACK_MS = 2000;
  const FMT_INT16   = 0;
  const FMT_FLOAT32 = 1;
  const MAX_CONCEAL_PACKETS = 12;
  const ARRIVAL_ESTIMATOR_MAX_WINDOW_MS = 35000;
  const ARRIVAL_ESTIMATOR_MIN_SPAN_MS = 8000;
  const ARRIVAL_RATE_CONTROL_MIN_SPAN_SEC = 14;
  const ARRIVAL_RATE_CONTROL_MIN_AGE_MS = 20000;
  const ARRIVAL_RATE_CONTROL_MAX_JITTER_MS = 1.5;
  const ARRIVAL_RATE_CONTROL_DEADBAND_PPM = 40;
  const ARRIVAL_RATE_CONTROL_MAX_PPM = 500;
  const ARRIVAL_RATE_CONTROL_AGREE_PPM = 100;
  const ARRIVAL_RATE_CONTROL_INTERVAL_MS = 1000;
  // --- Profile presets (Step 15c) --------------------------------------------
  // &dcMode=NAME bundles dcBuffer + dcFrame + dcFormat so the user picks ONE
  // knob. Individual &dcBuffer / &dcFrame / &dcFormat URL params still work
  // and override the profile they're set under. If no profile is set, each
  // individual knob falls back to its own default.
  const DC_PROFILES = {
    lowest:  { dcBuffer: 20, dcFrame:  5, dcFormat: 'int16'   },
    default: { dcBuffer: 30, dcFrame:  5, dcFormat: 'int16'   },
    robust:  { dcBuffer: 80, dcFrame: 10, dcFormat: 'int16'   },
    studio:  { dcBuffer: 30, dcFrame:  5, dcFormat: 'float32' },
  };
  const _dcMode = (_stringParam(['dcMode']) || '').toLowerCase();
  const _profile = DC_PROFILES[_dcMode] || {};
  // dcBuffer/losslessBufferMs is the single public target latency: the worklet
  // arms at this fill level and the drift integrator uses it as its setpoint.
  // Default 30 ms — Layer A of the four-layer playout model.
  const TARGET_BUFFER_MS = _numberParam(['dcBuffer', 'losslessBufferMs'], _profile.dcBuffer || 30, 5, 300);
  const TARGET_BUFFER_FRAMES = Math.round(48000 * TARGET_BUFFER_MS / 1000);
  // Receiver-requested wire packet size + format, sent in the ack so the
  // publisher chunks per peer. Per-peer-independent: two listeners can ask
  // for different sizes and the publisher tailors its DC output to each.
  const REQUESTED_FRAME_MS = _numberParam(['dcFrame'], _profile.dcFrame || 10, 1, 100);
  const REQUESTED_FRAME_FRAMES = Math.max(1, Math.round(48000 * REQUESTED_FRAME_MS / 1000));
  const DEFAULT_REORDER_WINDOW_PACKETS = REQUESTED_FRAME_MS <= 3.1 ? 8 : (REQUESTED_FRAME_MS <= 5.5 ? 6 : 4);
  const REORDER_WINDOW_PACKETS = Math.round(_numberParam(
    ['dcReorderPackets', 'losslessReorderPackets'],
    DEFAULT_REORDER_WINDOW_PACKETS,
    0,
    64
  ));
  const DEFAULT_STARTUP_PREROLL_PACKETS = Math.max(2, Math.min(64,
    Math.ceil((TARGET_BUFFER_FRAMES + Math.min(REQUESTED_FRAME_FRAMES, Math.round(TARGET_BUFFER_FRAMES / 4))) / REQUESTED_FRAME_FRAMES)
  ));
  const STARTUP_PREROLL_PACKETS = Math.round(_numberParam(['losslessPreroll'], DEFAULT_STARTUP_PREROLL_PACKETS, 1, 64));
  const REQUESTED_FORMAT = (() => {
    const fmt = (_stringParam(['dcFormat']) || _profile.dcFormat || 'int16').toLowerCase();
    return (fmt === 'float32' || fmt === 'int16') ? fmt : 'int16';
  })();
  const CLICK_TRIM_ENABLED = _boolParam(['dcClickTrim'], true);
  const LATENCY_TRIM_ENABLED = _boolParam(['dcLatencyTrim'], false);
  const RATE_LEARNING_ENABLED = _boolParam(['dcRateLearning'], false);
  const DEFAULT_PROMOTE_DELAY_MS = TARGET_BUFFER_MS <= 25 ? 8000 : 0;
  const PROMOTE_DELAY_MS = Math.round(_numberParam(
    ['dcPromoteDelayMs', 'losslessPromoteDelayMs'],
    DEFAULT_PROMOTE_DELAY_MS,
    0,
    30000
  ));

  function log(msg)  { console.log(`[lossless-dc v${VERSION}] ${msg}`); }
  function warn(msg) { console.warn(`[lossless-dc v${VERSION}] ${msg}`); }

  function _numberParam(names, fallback, min, max) {
    const vals = [];
    try {
      const pageParams = new URLSearchParams(window.location.search);
      for (const name of names) if (pageParams.has(name)) vals.push(pageParams.get(name));
      for (const [, val] of pageParams) {
        if (val && val.includes('viewer.js')) {
          try {
            const scriptUrl = new URL(val, window.location.href);
            for (const name of names) if (scriptUrl.searchParams.has(name)) vals.push(scriptUrl.searchParams.get(name));
          } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      if (document.currentScript && document.currentScript.src) {
        const scriptUrl = new URL(document.currentScript.src, window.location.href);
        for (const name of names) if (scriptUrl.searchParams.has(name)) vals.push(scriptUrl.searchParams.get(name));
      }
    } catch (_) {}
    for (const val of vals) {
      const n = Number(val);
      if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
    }
    return fallback;
  }

  function _stringParam(names) {
    try {
      const pageParams = new URLSearchParams(window.location.search);
      for (const name of names) {
        const v = pageParams.get(name);
        if (v) return v;
      }
      for (const [, val] of pageParams) {
        if (val && val.includes('viewer.js')) {
          try {
            const scriptUrl = new URL(val, window.location.href);
            for (const name of names) {
              const v = scriptUrl.searchParams.get(name);
              if (v) return v;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      if (document.currentScript && document.currentScript.src) {
        const scriptUrl = new URL(document.currentScript.src, window.location.href);
        for (const name of names) {
          const v = scriptUrl.searchParams.get(name);
          if (v) return v;
        }
      }
    } catch (_) {}
    return null;
  }

  function _boolParam(names, fallback) {
    const val = _stringParam(names);
    if (val == null) return fallback;
    const v = String(val).trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return fallback;
  }

  // -------------------------------------------------------------------------
  // Worklet URL resolution
  // -------------------------------------------------------------------------
  function _getWorkletUrl() {
    if (typeof window !== 'undefined' && typeof window.__LOSSLESS_WORKLET_SOURCE === 'string') {
      try {
        if (!window.__LOSSLESS_WORKLET_BLOB_URL) {
          window.__LOSSLESS_WORKLET_BLOB_URL = URL.createObjectURL(new Blob(
            [window.__LOSSLESS_WORKLET_SOURCE],
            { type: 'application/javascript' }
          ));
        }
        return window.__LOSSLESS_WORKLET_BLOB_URL;
      } catch (_) {}
    }
    const workletFile = `audio-worklet.js?v=${encodeURIComponent(VERSION)}`;
    try {
      const params = new URLSearchParams(window.location.search);
      for (const [, val] of params) {
        if (val && val.includes('viewer.js')) {
          return val.replace(/viewer\.js(\?.*)?$/, workletFile);
        }
      }
    } catch (_) {}
    if (document.currentScript && document.currentScript.src) {
      return document.currentScript.src.replace(/viewer\.js(\?.*)?$/, workletFile);
    }
    return 'https://anthonytrance.github.io/vdo-ninja-lossless/audio-worklet.js';
  }

  // -------------------------------------------------------------------------
  // Per-PC state
  // -------------------------------------------------------------------------
  const _peers = new Map();   // WeakMap would be cleaner but Map is fine here

  function _newPeer(pc, dc) {
    return { pc, dc, stream: null, handshake: null, ackSent: false, audioEl: null,
             savedVolume: 1.0, gainNode: null,
             lastFrameMs: 0, lastSeq: -1, expectedSeq: -1,
             pendingPackets: new Map(), lateDrops: 0, duplicateDrops: 0,
             frames: 0, seqDrops: 0, audioUnderruns: 0, partialUnderruns: 0, concealed: 0,
             driftSkips: 0, driftRepeats: 0, rearmTrimFrames: 0, clickTrimFrames: 0,
             bytes: 0, opusRestored: false, bufferFrames: 0,
             resamplerRatio: 1.0, resamplerUpdates: 0,
             resamplerBaseRatio: 1.0, resamplerTrustedRatio: 1.0,
             resamplerMeasuredRatio: 1.0, resamplerPendingRatio: 1.0,
             resamplerPendingConfirmations: 0, resamplerTargetRatio: 1.0,
             resamplerStableSec: 0, resamplerActive: false, resamplerSource: '',
             arrivalSamples: [], arrivalLastSeq: -1, arrivalSenderFrames: 0,
             arrivalStartMs: 0,
             arrivalRatio15: 1.0, arrivalRatio30: 1.0,
             arrivalJitterMs15: 0, arrivalJitterMs30: 0,
             arrivalSpanSec15: 0, arrivalSpanSec30: 0,
             arrivalSamples15: 0, arrivalSamples30: 0,
             arrivalValid15: false, arrivalValid30: false,
             arrivalSeqGaps: 0, arrivalResets: 0,
             arrivalControlPendingRatio: 1.0, arrivalControlConfirmations: 0,
             arrivalControlPendingMs: 0, arrivalControlLastSendMs: 0,
             arrivalControlSentRatio: 1.0, arrivalControlActive: false,
             lastGoodFrame: null, packetFrames: REQUESTED_FRAME_FRAMES,
             reorderWindowPackets: REORDER_WINDOW_PACKETS,
             acceptFrames: PROMOTE_DELAY_MS <= 0, promoteTimer: null,
             armed: false, losslessStarted: false, startupQueue: [],
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
      _audioCtx = new AudioContext({ sampleRate: sampleRate || 48000, latencyHint: 0 });
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
      processorOptions: {
        channels,
        targetFrames: TARGET_BUFFER_FRAMES,
        clickTrim: CLICK_TRIM_ENABLED,
        latencyTrim: LATENCY_TRIM_ENABLED,
        rateLearning: RATE_LEARNING_ENABLED,
      },
    });
    peer.targetFrames = TARGET_BUFFER_FRAMES;
    wn.port.onmessage = (ev) => {
      const m = ev.data;
      if (typeof m.target === 'number') peer.targetFrames = m.target;
      if (m.type === 'underrun') {
        peer.audioUnderruns++;
        peer.bufferFrames = m.filled || 0;
        _updateOverlay();
      }
      if (m.type === 'arming') {
        peer.armed = !!m.armed;
        if (typeof m.filled === 'number') peer.bufferFrames = m.filled;
        if (peer.armed && peer.losslessStarted) _muteOpus(peer);
        _updateOverlay();
      }
      if (m.type === 'buffer') {
        peer.bufferFrames = m.filled || 0;
        _updatePeerResamplerStats(peer, m);
        _updateOverlay();
      }
      if (m.type === 'resampler') {
        _updatePeerResamplerStats(peer, m);
        if (typeof m.filled === 'number') peer.bufferFrames = m.filled;
        _updateOverlay();
      }
      if (m.type === 'drift') {
        if (!peer.legacyDriftWarned) {
          peer.legacyDriftWarned = true;
          warn('Ignoring legacy drift splice event from worklet');
        }
        if (typeof m.filled === 'number') peer.bufferFrames = m.filled;
        _updateOverlay();
      }
      if (m.type === 'rearm-trim') {
        peer.rearmTrimFrames = m.totalDropped || 0;
        if (typeof m.filled === 'number') peer.bufferFrames = m.filled;
        _updateOverlay();
      }
      if (m.type === 'click-trim') {
        peer.clickTrimFrames = m.totalDropped || 0;
        if (typeof m.filled === 'number') peer.bufferFrames = m.filled;
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

  function _updatePeerResamplerStats(peer, m) {
    if (typeof m.ratio === 'number') peer.resamplerRatio = m.ratio;
    if (typeof m.baseRatio === 'number') peer.resamplerBaseRatio = m.baseRatio;
    if (typeof m.trustedRatio === 'number') peer.resamplerTrustedRatio = m.trustedRatio;
    if (typeof m.measuredRatio === 'number') peer.resamplerMeasuredRatio = m.measuredRatio;
    if (typeof m.pendingRatio === 'number') peer.resamplerPendingRatio = m.pendingRatio;
    if (typeof m.pendingConfirmations === 'number') peer.resamplerPendingConfirmations = m.pendingConfirmations;
    if (typeof m.targetRatio === 'number') peer.resamplerTargetRatio = m.targetRatio;
    if (typeof m.stableSec === 'number') peer.resamplerStableSec = m.stableSec;
    if (typeof m.active === 'boolean') peer.resamplerActive = m.active;
    if (typeof m.updates === 'number') peer.resamplerUpdates = m.updates;
    if (typeof m.source === 'string') peer.resamplerSource = m.source;
    if (typeof m.partialUnderruns === 'number') peer.partialUnderruns = m.partialUnderruns;
  }

  function _resetArrivalEstimator(peer) {
    peer.arrivalSamples = [];
    peer.arrivalLastSeq = -1;
    peer.arrivalSenderFrames = 0;
    peer.arrivalStartMs = 0;
    peer.arrivalRatio15 = 1.0;
    peer.arrivalRatio30 = 1.0;
    peer.arrivalJitterMs15 = 0;
    peer.arrivalJitterMs30 = 0;
    peer.arrivalSpanSec15 = 0;
    peer.arrivalSpanSec30 = 0;
    peer.arrivalSamples15 = 0;
    peer.arrivalSamples30 = 0;
    peer.arrivalValid15 = false;
    peer.arrivalValid30 = false;
    peer.arrivalControlPendingRatio = 1.0;
    peer.arrivalControlConfirmations = 0;
    peer.arrivalControlPendingMs = 0;
    peer.arrivalControlLastSendMs = 0;
    peer.arrivalControlSentRatio = 1.0;
    peer.arrivalControlActive = false;
  }

  function _updateArrivalEstimator(peer, seq, packetFrames) {
    const frames = packetFrames > 0 ? packetFrames : (peer.packetFrames || REQUESTED_FRAME_FRAMES);
    if (!Number.isFinite(frames) || frames <= 0) return;
    const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!peer.arrivalSamples) peer.arrivalSamples = [];

    if (peer.arrivalLastSeq < 0) {
      peer.arrivalLastSeq = seq;
      peer.arrivalSenderFrames = 0;
      peer.arrivalStartMs = nowMs;
    } else {
      const diff = (seq - peer.arrivalLastSeq + 65536) & 0xFFFF;
      if (diff === 0 || diff > 32768) {
        peer.arrivalResets = (peer.arrivalResets || 0) + 1;
        _resetArrivalEstimator(peer);
        peer.arrivalLastSeq = seq;
        peer.arrivalSenderFrames = 0;
      } else {
        if (diff > 1) peer.arrivalSeqGaps = (peer.arrivalSeqGaps || 0) + diff - 1;
        peer.arrivalSenderFrames += diff * frames;
        peer.arrivalLastSeq = seq;
      }
    }

    peer.arrivalSamples.push({ t: nowMs, f: peer.arrivalSenderFrames });
    const cutoff = nowMs - ARRIVAL_ESTIMATOR_MAX_WINDOW_MS;
    while (peer.arrivalSamples.length > 1 && peer.arrivalSamples[0].t < cutoff) {
      peer.arrivalSamples.shift();
    }

    _refreshArrivalEstimator(peer, nowMs);
    _maybeSendArrivalRateEstimate(peer, nowMs);
  }

  function _refreshArrivalEstimator(peer, nowMs) {
    const s15 = _arrivalWindowStats(peer, nowMs, 15000);
    const s30 = _arrivalWindowStats(peer, nowMs, 30000);
    _storeArrivalWindow(peer, 15, s15);
    _storeArrivalWindow(peer, 30, s30);
  }

  function _storeArrivalWindow(peer, suffix, stats) {
    peer[`arrivalValid${suffix}`] = !!stats;
    peer[`arrivalRatio${suffix}`] = stats ? stats.ratio : 1.0;
    peer[`arrivalJitterMs${suffix}`] = stats ? stats.jitterMs : 0;
    peer[`arrivalSpanSec${suffix}`] = stats ? stats.spanSec : 0;
    peer[`arrivalSamples${suffix}`] = stats ? stats.count : 0;
  }

  function _arrivalWindowStats(peer, nowMs, windowMs) {
    const samples = peer.arrivalSamples || [];
    const cutoff = nowMs - windowMs;
    let start = 0;
    while (start < samples.length - 1 && samples[start].t < cutoff) start++;
    const count = samples.length - start;
    if (count < 4) return null;

    const first = samples[start];
    const last = samples[samples.length - 1];
    const spanMs = last.t - first.t;
    if (spanMs < ARRIVAL_ESTIMATOR_MIN_SPAN_MS) return null;

    let sumT = 0, sumF = 0;
    for (let i = start; i < samples.length; i++) {
      sumT += samples[i].t - first.t;
      sumF += samples[i].f - first.f;
    }
    const meanT = sumT / count;
    const meanF = sumF / count;

    let cov = 0, varT = 0;
    for (let i = start; i < samples.length; i++) {
      const dt = (samples[i].t - first.t) - meanT;
      const df = (samples[i].f - first.f) - meanF;
      cov += dt * df;
      varT += dt * dt;
    }
    if (varT <= 0) return null;

    const slopeFramesPerMs = cov / varT;
    const sampleRate = (peer.handshake && peer.handshake.sampleRate) || 48000;
    const nominalFramesPerMs = sampleRate / 1000;
    const ratio = slopeFramesPerMs / nominalFramesPerMs;
    if (!Number.isFinite(ratio) || ratio <= 0) return null;

    let sse = 0;
    for (let i = start; i < samples.length; i++) {
      const t = samples[i].t - first.t;
      const f = samples[i].f - first.f;
      const residualFrames = f - (meanF + slopeFramesPerMs * (t - meanT));
      sse += residualFrames * residualFrames;
    }
    return {
      ratio,
      jitterMs: Math.sqrt(sse / count) / nominalFramesPerMs,
      spanSec: spanMs / 1000,
      count,
    };
  }

  function _resetArrivalControl(peer) {
    peer.arrivalControlPendingRatio = 1.0;
    peer.arrivalControlConfirmations = 0;
    peer.arrivalControlPendingMs = 0;
    peer.arrivalControlActive = false;
  }

  function _maybeSendArrivalRateEstimate(peer, nowMs) {
    if (!RATE_LEARNING_ENABLED) {
      _resetArrivalControl(peer);
      return;
    }
    if (!peer.losslessStarted || !peer.arrivalValid15) {
      _resetArrivalControl(peer);
      return;
    }
    const wn = _workletNodes.get(peer.pc);
    if (!wn) return;
    const ratio = peer.arrivalRatio15;
    const ppm = (ratio - 1.0) * 1000000;
    const absPpm = Math.abs(ppm);
    if (!Number.isFinite(ratio) || ratio <= 0
        || !peer.arrivalStartMs
        || nowMs - peer.arrivalStartMs < ARRIVAL_RATE_CONTROL_MIN_AGE_MS
        || peer.arrivalSpanSec15 < ARRIVAL_RATE_CONTROL_MIN_SPAN_SEC
        || peer.arrivalJitterMs15 > ARRIVAL_RATE_CONTROL_MAX_JITTER_MS
        || absPpm < ARRIVAL_RATE_CONTROL_DEADBAND_PPM
        || absPpm > ARRIVAL_RATE_CONTROL_MAX_PPM) {
      _resetArrivalControl(peer);
      return;
    }

    if (peer.arrivalValid30 && peer.arrivalSpanSec30 >= 25) {
      const ppm30 = (peer.arrivalRatio30 - 1.0) * 1000000;
      if (Number.isFinite(ppm30) && Math.abs(ppm - ppm30) > ARRIVAL_RATE_CONTROL_AGREE_PPM * 2) {
        _resetArrivalControl(peer);
        return;
      }
    }

    if (peer.arrivalControlConfirmations > 0) {
      const pendingPpm = (peer.arrivalControlPendingRatio - 1.0) * 1000000;
      const agrees = Math.sign(ppm) === Math.sign(pendingPpm)
        && Math.abs(ppm - pendingPpm) <= ARRIVAL_RATE_CONTROL_AGREE_PPM;
      if (!agrees) {
        peer.arrivalControlPendingRatio = ratio;
        peer.arrivalControlConfirmations = 1;
        peer.arrivalControlPendingMs = nowMs;
        return;
      }
      if (nowMs - peer.arrivalControlPendingMs >= ARRIVAL_RATE_CONTROL_INTERVAL_MS) {
        peer.arrivalControlPendingRatio = (peer.arrivalControlPendingRatio * peer.arrivalControlConfirmations + ratio)
          / (peer.arrivalControlConfirmations + 1);
        peer.arrivalControlConfirmations++;
        peer.arrivalControlPendingMs = nowMs;
      }
    } else {
      peer.arrivalControlPendingRatio = ratio;
      peer.arrivalControlConfirmations = 1;
      peer.arrivalControlPendingMs = nowMs;
      return;
    }

    if (peer.arrivalControlConfirmations < 2) return;
    if (nowMs - peer.arrivalControlLastSendMs < ARRIVAL_RATE_CONTROL_INTERVAL_MS) return;

    peer.arrivalControlSentRatio = peer.arrivalControlPendingRatio;
    peer.arrivalControlLastSendMs = nowMs;
    peer.arrivalControlActive = true;
    wn.port.postMessage({
      type: 'rateEstimate',
      ratio: peer.arrivalControlSentRatio,
      source: 'arrival15',
      ppm: Math.round((peer.arrivalControlSentRatio - 1.0) * 1000000),
      jitterMs: peer.arrivalJitterMs15,
      spanSec: peer.arrivalSpanSec15,
    });
  }

  function _sendLosslessAck(peer) {
    if (peer.ackSent || !peer.handshake || peer.handshake.v < 2) return;
    // Carry receiver's own preferences. Publisher's hs default is 10ms /
    // int16; only include overrides where this viewer differs, so a default
    // viewer still sends a minimal ack (forwards-compat).
    const ack = { v: 2, type: 'ack', lossless: true };
    if (REQUESTED_FRAME_MS !== 10) ack.frameMs = REQUESTED_FRAME_MS;
    if (REQUESTED_FORMAT !== 'int16') ack.format = REQUESTED_FORMAT;
    try {
      peer.dc.send(JSON.stringify(ack));
      peer.ackSent = true;
      log(`Ack sent to publisher (${ack.frameMs || 10}ms ${ack.format || 'int16'})`);
    } catch (_) {}
  }

  function _postFrameToWorklet(peer, f32, byteLength) {
    const wn = _workletNodes.get(peer.pc);
    if (!wn) return;
    peer.lastGoodFrame = f32.slice(0);
    wn.port.postMessage({ type: 'frame', samples: f32.buffer, channels: peer.handshake.channels }, [f32.buffer]);
    peer.frames++;
    peer.bytes += byteLength;
  }

  function _concealGap(peer, gap) {
    const count = Math.min(gap, MAX_CONCEAL_PACKETS);
    const samplesPerPacket = (peer.packetFrames || REQUESTED_FRAME_FRAMES) * (peer.handshake.channels || 2);
    for (let i = 0; i < count; i++) {
      const f32 = peer.lastGoodFrame
        ? new Float32Array(peer.lastGoodFrame)
        : new Float32Array(samplesPerPacket);
      _postFrameToWorklet(peer, f32, 0);
      peer.concealed++;
    }
    if (gap > MAX_CONCEAL_PACKETS) warn(`Large DC gap: concealed ${MAX_CONCEAL_PACKETS}/${gap} packet(s), Opus fallback may be cleaner`);
  }

  function _seqDistance(from, to) {
    return (to - from + 65536) & 0xFFFF;
  }

  function _deliverPacketInOrder(peer, packet) {
    if (packet.packetFrames > 0) peer.packetFrames = packet.packetFrames;
    peer.lastSeq = packet.seq;
    peer.lastFrameMs = Date.now();

    if (!peer.losslessStarted) {
      peer.startupQueue.push(packet);
      if (peer.startupQueue.length < STARTUP_PREROLL_PACKETS) {
        _updateOverlay();
        return;
      }
      peer.losslessStarted = true;
      _resetArrivalEstimator(peer);
      log(`Startup preroll ready (${peer.startupQueue.length} packets) - lossless playback starts`);
      for (const item of peer.startupQueue) {
        _updateArrivalEstimator(peer, item.seq, item.packetFrames);
        _postFrameToWorklet(peer, item.f32, item.byteLength);
      }
      peer.startupQueue = [];
      _updateOverlay();
      return;
    }

    _updateArrivalEstimator(peer, packet.seq, packet.packetFrames);
    _postFrameToWorklet(peer, packet.f32, packet.byteLength);
    _updateOverlay();
  }

  function _handleMissingExpectedPacket(peer) {
    const missingSeq = peer.expectedSeq;
    if (peer.losslessStarted) {
      peer.seqDrops++;
      warn(`Gap: 1 packet (expected seq ${missingSeq}, reorder window ${peer.reorderWindowPackets})`);
      _concealGap(peer, 1);
      peer.lastSeq = missingSeq;
    } else {
      peer.startupQueue = [];
      log(`Startup preroll gap at seq ${missingSeq}; waiting for clean preroll`);
    }
    peer.expectedSeq = (peer.expectedSeq + 1) & 0xFFFF;
  }

  function _drainPendingPackets(peer) {
    const pending = peer.pendingPackets;
    while (peer.expectedSeq >= 0) {
      const packet = pending.get(peer.expectedSeq);
      if (!packet) break;
      pending.delete(peer.expectedSeq);
      _deliverPacketInOrder(peer, packet);
      peer.expectedSeq = (peer.expectedSeq + 1) & 0xFFFF;
    }
    while (peer.expectedSeq >= 0 && pending.size > peer.reorderWindowPackets) {
      _handleMissingExpectedPacket(peer);
      while (pending.has(peer.expectedSeq)) {
        const packet = pending.get(peer.expectedSeq);
        pending.delete(peer.expectedSeq);
        _deliverPacketInOrder(peer, packet);
        peer.expectedSeq = (peer.expectedSeq + 1) & 0xFFFF;
      }
    }
  }

  function _handleDecodedPacket(peer, packet) {
    if (!peer.acceptFrames) {
      peer.lastFrameMs = Date.now();
      return;
    }
    peer.lastFrameMs = Date.now();
    if (peer.expectedSeq < 0) {
      peer.expectedSeq = packet.seq;
    } else {
      const distance = _seqDistance(peer.expectedSeq, packet.seq);
      if (distance > 32768) {
        peer.lateDrops++;
        return;
      }
    }
    if (peer.pendingPackets.has(packet.seq)) {
      peer.duplicateDrops++;
      return;
    }
    peer.pendingPackets.set(packet.seq, packet);
    _drainPendingPackets(peer);
    _updateOverlay();
  }

  function _armLosslessPromotion(peer) {
    if (PROMOTE_DELAY_MS <= 0) {
      peer.acceptFrames = true;
      return;
    }
    peer.acceptFrames = false;
    if (peer.promoteTimer) clearTimeout(peer.promoteTimer);
    log(`Lossless promotion delayed ${PROMOTE_DELAY_MS}ms for low-latency warm-up`);
    peer.promoteTimer = setTimeout(() => {
      peer.promoteTimer = null;
      peer.acceptFrames = true;
      peer.expectedSeq = -1;
      peer.lastSeq = -1;
      peer.losslessStarted = false;
      peer.startupQueue = [];
      peer.lastGoodFrame = null;
      if (peer.pendingPackets) peer.pendingPackets.clear();
      log('Lossless promotion window open');
      _updateOverlay();
    }, PROMOTE_DELAY_MS);
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
    if (peer.promoteTimer) { clearTimeout(peer.promoteTimer); peer.promoteTimer = null; }
    const wn = _workletNodes.get(peer.pc);
    if (wn)          { try { wn.disconnect();          } catch (_) {} _workletNodes.delete(peer.pc); }
    if (peer.gainNode) { try { peer.gainNode.disconnect(); } catch (_) {} peer.gainNode = null; }
    peer.armed = false;
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
        if (hs.v < 1 || hs.v > 2) { warn(`Unknown handshake version ${hs.v}`); peer.dc.close(); return; }
        peer.handshake = hs;
        log(`Handshake v${hs.v}: ${hs.sampleRate}Hz ${hs.channels}ch ${hs.format}`);
        if (_userDisabled) {
          log('User disabled lossless — handshake parsed but worklet not built');
          _updateOverlay();
          return;
        }
        await _ensureAudio(hs.sampleRate);
        await _buildWorkletNode(peer);
        _sendLosslessAck(peer);
        _armLosslessPromotion(peer);
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
    const packetFrames = view.getUint16(2, true);
    const fmt  = view.getUint8(4);
    if (packetFrames > 0) peer.packetFrames = packetFrames;

    const payload = buf.slice(8);
    let f32;
    if (fmt === FMT_INT16) {
      const i16 = new Int16Array(payload);
      f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] < 0 ? i16[i] / 32768 : i16[i] / 32767;
    } else if (fmt === FMT_FLOAT32) {
      f32 = new Float32Array(payload.slice(0));
    } else { return; }

    _handleDecodedPacket(peer, { seq, packetFrames, fmt, f32, byteLength: buf.byteLength });
  }

  // -------------------------------------------------------------------------
  // Attach DC to a PeerConnection (idempotent — safe to call multiple times)
  // -------------------------------------------------------------------------
  function _attachDcToPc(pc) {
    if (_peers.has(pc)) return;   // already attached
    let dc;
    try {
      dc = pc.createDataChannel(DC_LABEL, {
        id: DC_ID, negotiated: true, ordered: false, maxRetransmits: 0, protocol: DC_PROTOCOL,
      });
      dc.binaryType = 'arraybuffer';
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

  // Test-harness debug hook. Exposes _peers and version so the autonomous
  // browser harness can read per-peer state without parsing the overlay text.
  // This stays available even when console-heavy debug logging is off.
  try {
    window.__LosslessDcDebug = Object.freeze({
      get peers() { return _peers; },
      get version() { return VERSION; },
      get targetBufferMs() { return TARGET_BUFFER_MS; },
      get requestedFrameMs() { return REQUESTED_FRAME_MS; },
      get requestedFormat() { return REQUESTED_FORMAT; },
      get dcMode() { return _dcMode || null; },
      snapshot() {
        const peers = [];
        for (const [, p] of _peers) {
          peers.push({
            hasHandshake: !!p.handshake,
            armed: !!p.armed,
            losslessStarted: !!p.losslessStarted,
            opusRestored: !!p.opusRestored,
            frames: p.frames, bytes: p.bytes,
            seqDrops: p.seqDrops, audioUnderruns: p.audioUnderruns,
            concealed: p.concealed, partialUnderruns: p.partialUnderruns || 0,
            lateDrops: p.lateDrops || 0, duplicateDrops: p.duplicateDrops || 0,
            pendingPackets: p.pendingPackets ? p.pendingPackets.size : 0,
            reorderWindowPackets: p.reorderWindowPackets || 0,
            driftSkips: p.driftSkips, driftRepeats: p.driftRepeats,
            rearmTrimFrames: p.rearmTrimFrames, clickTrimFrames: p.clickTrimFrames,
            bufferFrames: p.bufferFrames, targetFrames: p.targetFrames || 0,
            resamplerRatio: p.resamplerRatio || 1.0,
            resamplerBaseRatio: p.resamplerBaseRatio || 1.0,
            resamplerTrustedRatio: p.resamplerTrustedRatio || 1.0,
            resamplerMeasuredRatio: p.resamplerMeasuredRatio || 1.0,
            resamplerPendingRatio: p.resamplerPendingRatio || 1.0,
            resamplerPendingConfirmations: p.resamplerPendingConfirmations || 0,
            resamplerTargetRatio: p.resamplerTargetRatio || 1.0,
            resamplerStableSec: p.resamplerStableSec || 0,
            resamplerActive: !!p.resamplerActive,
            resamplerUpdates: p.resamplerUpdates || 0,
            resamplerSource: p.resamplerSource || '',
            arrivalRatio15: p.arrivalRatio15 || 1.0,
            arrivalRatio30: p.arrivalRatio30 || 1.0,
            arrivalAgeSec: p.arrivalStartMs ? ((performance.now() - p.arrivalStartMs) / 1000) : 0,
            arrivalJitterMs15: p.arrivalJitterMs15 || 0,
            arrivalJitterMs30: p.arrivalJitterMs30 || 0,
            arrivalSpanSec15: p.arrivalSpanSec15 || 0,
            arrivalSpanSec30: p.arrivalSpanSec30 || 0,
            arrivalSamples15: p.arrivalSamples15 || 0,
            arrivalSamples30: p.arrivalSamples30 || 0,
            arrivalValid15: !!p.arrivalValid15,
            arrivalValid30: !!p.arrivalValid30,
            arrivalSeqGaps: p.arrivalSeqGaps || 0,
            arrivalResets: p.arrivalResets || 0,
            arrivalControlPendingRatio: p.arrivalControlPendingRatio || 1.0,
            arrivalControlConfirmations: p.arrivalControlConfirmations || 0,
            arrivalControlSentRatio: p.arrivalControlSentRatio || 1.0,
            arrivalControlActive: !!p.arrivalControlActive,
            lastFrameMs: p.lastFrameMs, lastSeq: p.lastSeq,
          });
        }
        return { version: VERSION, peers };
      },
    });
    if (DEBUG_ON) log('debug hook installed at window.__LosslessDcDebug');
  } catch (_) {}

  log('RTCPeerConnection prototype patched — lossless DC ready');
  log(`Latency profile: ${_dcMode ? `dcMode=${_dcMode} → ` : ''}` +
    `dcBuffer=${TARGET_BUFFER_MS}ms (target=${TARGET_BUFFER_FRAMES} frames) ` +
    `dcFrame=${REQUESTED_FRAME_MS}ms dcFormat=${REQUESTED_FORMAT} ` +
    `losslessPreroll=${STARTUP_PREROLL_PACKETS} reorder=${REORDER_WINDOW_PACKETS} ` +
    `promoteDelay=${PROMOTE_DELAY_MS}ms ` +
    `clickTrim=${CLICK_TRIM_ENABLED ? 1 : 0} latencyTrim=${LATENCY_TRIM_ENABLED ? 1 : 0} rateLearning=${RATE_LEARNING_ENABLED ? 1 : 0}`);

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
    _stateNode.setAttribute('data-lossless-state', '');
    _stateNode.textContent = 'IDLE';
    _overlay.appendChild(_stateNode);

    _statsNode = document.createElement('div');
    _statsNode.setAttribute('data-lossless-stats', '');
    _statsNode.textContent = 'Frames: 0  SeqDrops: 0  Concealed: 0  AudioUnderruns: 0 (0/min)  Partial: 0  Drift: 0/0 (0/min)  RearmTrim: 0ms (0/min)  ClickTrim: 0ms (0/min)  Reorder: 0/0  Late: 0  Buffer: 0/0 armed 0ms / target 0ms  Ratio: 0ppm  ~0 kbps';
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
    let activePeers = 0, armedPeers = 0;
    const now = Date.now();
    for (const [, p] of _peers) {
      if (!p.handshake) continue;
      if (p.lastFrameMs > 0 && (now - p.lastFrameMs) < FALLBACK_MS && !p.opusRestored) {
        activePeers++;
        if (p.armed) armedPeers++;
      }
    }
    if (activePeers > 0) return armedPeers > 0 ? 'LOSSLESS ACTIVE' : 'LOSSLESS BUFFERING';
    if (_peers.size > 0) return 'OPUS FALLBACK';
    return 'IDLE';
  }

  // 60s sliding-window snapshot ring for per-minute rate display. Each entry is
  // {ts, au, df, rt, ct} cumulative counters at that instant. We compare the
  // newest snapshot to whichever oldest snapshot is still within the 60s window;
  // the delta is the "per minute" rate (or proportionally less if the session
  // is younger than 60s).
  const _rateSnapshots = [];
  function _sampleRate(now, au, df, rt, ct) {
    _rateSnapshots.push({ ts: now, au, df, rt, ct });
    const cutoff = now - 60000;
    while (_rateSnapshots.length > 1 && _rateSnapshots[0].ts < cutoff) _rateSnapshots.shift();
  }
  function _ratePerMin(now, currentValue, key) {
    if (_rateSnapshots.length < 2) return 0;
    const oldest = _rateSnapshots[0];
    const dt = now - oldest.ts;
    if (dt <= 0) return 0;
    const delta = currentValue - oldest[key];
    return Math.round((delta * 60000) / dt);
  }

  function _updateOverlay() {
    _ensureOverlay();
    if (!_overlay) return;
    let totalFrames = 0, totalSeqDrops = 0, totalAudioUnderruns = 0, totalConcealed = 0;
    let totalPartialUnderruns = 0, totalLateDrops = 0, totalDuplicateDrops = 0, totalPendingPackets = 0, maxReorderWindow = 0;
    let totalDriftSkips = 0, totalDriftRepeats = 0, totalRearmTrimFrames = 0, totalClickTrimFrames = 0;
    let totalBytes = 0, armedCount = 0, losslessPeers = 0, minBufferFrames = null, maxTargetFrames = 0;
    let ratioSum = 0, ratioCount = 0, ratioUpdates = 0;
    let measuredSum = 0, measuredCount = 0, pendingSum = 0, pendingCount = 0;
    let pendingConfirmations = 0, minStableSec = null, activeRatioPeers = 0;
    let arrival15Sum = 0, arrival15Count = 0, arrival30Sum = 0, arrival30Count = 0;
    let arrival15JitterSum = 0, arrival30JitterSum = 0, arrivalSeqGaps = 0;
    let arrivalControlSentSum = 0, arrivalControlSentCount = 0, arrivalControlConfirmations = 0;
    for (const [, p] of _peers) {
      if (!p.handshake) continue;
      totalFrames    += p.frames;
      totalSeqDrops  += p.seqDrops;
      totalAudioUnderruns += p.audioUnderruns;
      totalConcealed += p.concealed;
      totalPartialUnderruns += p.partialUnderruns || 0;
      totalLateDrops += p.lateDrops || 0;
      totalDuplicateDrops += p.duplicateDrops || 0;
      totalPendingPackets += p.pendingPackets ? p.pendingPackets.size : 0;
      maxReorderWindow = Math.max(maxReorderWindow, p.reorderWindowPackets || 0);
      totalDriftSkips   += p.driftSkips;
      totalDriftRepeats += p.driftRepeats;
      totalRearmTrimFrames += p.rearmTrimFrames || 0;
      totalClickTrimFrames += p.clickTrimFrames || 0;
      totalBytes     += p.bytes;
      losslessPeers++;
      if (p.armed) armedCount++;
      if (p.bufferFrames > 0) minBufferFrames = minBufferFrames === null ? p.bufferFrames : Math.min(minBufferFrames, p.bufferFrames);
      if (typeof p.targetFrames === 'number' && p.targetFrames > maxTargetFrames) maxTargetFrames = p.targetFrames;
      if (typeof p.resamplerRatio === 'number' && p.resamplerRatio > 0) {
        ratioSum += p.resamplerRatio;
        ratioCount++;
      }
      ratioUpdates += p.resamplerUpdates || 0;
      if (typeof p.resamplerMeasuredRatio === 'number' && p.resamplerMeasuredRatio > 0) {
        measuredSum += p.resamplerMeasuredRatio;
        measuredCount++;
      }
      if (typeof p.resamplerPendingRatio === 'number' && p.resamplerPendingRatio > 0) {
        pendingSum += p.resamplerPendingRatio;
        pendingCount++;
      }
      pendingConfirmations = Math.max(pendingConfirmations, p.resamplerPendingConfirmations || 0);
      if (typeof p.resamplerStableSec === 'number') {
        minStableSec = minStableSec === null ? p.resamplerStableSec : Math.min(minStableSec, p.resamplerStableSec);
      }
      if (p.resamplerActive) activeRatioPeers++;
      if (p.arrivalValid15 && typeof p.arrivalRatio15 === 'number' && p.arrivalRatio15 > 0) {
        arrival15Sum += p.arrivalRatio15;
        arrival15JitterSum += p.arrivalJitterMs15 || 0;
        arrival15Count++;
      }
      if (p.arrivalValid30 && typeof p.arrivalRatio30 === 'number' && p.arrivalRatio30 > 0) {
        arrival30Sum += p.arrivalRatio30;
        arrival30JitterSum += p.arrivalJitterMs30 || 0;
        arrival30Count++;
      }
      if (p.arrivalControlActive && typeof p.arrivalControlSentRatio === 'number' && p.arrivalControlSentRatio > 0) {
        arrivalControlSentSum += p.arrivalControlSentRatio;
        arrivalControlSentCount++;
      }
      arrivalControlConfirmations = Math.max(arrivalControlConfirmations, p.arrivalControlConfirmations || 0);
      arrivalSeqGaps += p.arrivalSeqGaps || 0;
    }
    const elapsed  = totalFrames * (REQUESTED_FRAME_MS / 1000);
    const kbps     = elapsed > 0 ? Math.round((totalBytes * 8) / elapsed / 1000) : 0;
    const stateStr = _computeStateStr();

    if (_stateNode) _stateNode.textContent = stateStr;
    const bufMs = minBufferFrames === null ? 0 : Math.round((minBufferFrames / 48));
    const targetMs = maxTargetFrames > 0 ? Math.round(maxTargetFrames / 48) : TARGET_BUFFER_MS;
    const rearmTrimMs = Math.round(totalRearmTrimFrames / 48);
    const clickTrimMs = Math.round(totalClickTrimFrames / 48);
    const totalDriftEvents = totalDriftSkips + totalDriftRepeats;
    const ratioPpm = ratioCount > 0 ? Math.round(((ratioSum / ratioCount) - 1.0) * 1000000) : 0;
    const measuredPpm = measuredCount > 0 ? Math.round(((measuredSum / measuredCount) - 1.0) * 1000000) : 0;
    const pendingPpm = pendingCount > 0 ? Math.round(((pendingSum / pendingCount) - 1.0) * 1000000) : 0;
    const stableSec = minStableSec === null ? 0 : Math.round(minStableSec);
    const arrival15Ppm = arrival15Count > 0 ? Math.round(((arrival15Sum / arrival15Count) - 1.0) * 1000000) : null;
    const arrival30Ppm = arrival30Count > 0 ? Math.round(((arrival30Sum / arrival30Count) - 1.0) * 1000000) : null;
    const arrival15Jitter = arrival15Count > 0 ? Math.round((arrival15JitterSum / arrival15Count) * 10) / 10 : null;
    const arrival30Jitter = arrival30Count > 0 ? Math.round((arrival30JitterSum / arrival30Count) * 10) / 10 : null;
    const arrivalControlPpm = arrivalControlSentCount > 0 ? Math.round(((arrivalControlSentSum / arrivalControlSentCount) - 1.0) * 1000000) : null;
    const learnText = DEBUG_ON
      ? `  Learn: meas ${measuredPpm}ppm pending ${pendingPpm}ppm/${pendingConfirmations}c stable ${stableSec}s active ${activeRatioPeers}/${losslessPeers} arrival15 ${arrival15Ppm === null ? 'n/a' : `${arrival15Ppm}ppm/${arrival15Jitter}ms`} arrival30 ${arrival30Ppm === null ? 'n/a' : `${arrival30Ppm}ppm/${arrival30Jitter}ms`} sent ${arrivalControlPpm === null ? 'n/a' : `${arrivalControlPpm}ppm/${arrivalControlConfirmations}c`} gaps ${arrivalSeqGaps}`
      : '';
    const now = Date.now();
    _sampleRate(now, totalAudioUnderruns, totalDriftEvents, totalRearmTrimFrames, totalClickTrimFrames);
    const auPerMin = _ratePerMin(now, totalAudioUnderruns, 'au');
    const dfPerMin = _ratePerMin(now, totalDriftEvents, 'df');
    const rtPerMinFrames = _ratePerMin(now, totalRearmTrimFrames, 'rt');
    const ctPerMinFrames = _ratePerMin(now, totalClickTrimFrames, 'ct');
    const rtPerMinMs = Math.round(rtPerMinFrames / 48);
    const ctPerMinMs = Math.round(ctPerMinFrames / 48);
    if (_statsNode) _statsNode.textContent = `Frames: ${totalFrames}  SeqDrops: ${totalSeqDrops}  Concealed: ${totalConcealed}  AudioUnderruns: ${totalAudioUnderruns} (${auPerMin}/min)  Partial: ${totalPartialUnderruns}  Drift: ${totalDriftSkips}/${totalDriftRepeats} (${dfPerMin}/min)  RearmTrim: ${rearmTrimMs}ms (${rtPerMinMs}ms/min)  ClickTrim: ${clickTrimMs}ms (${ctPerMinMs}ms/min)  Reorder: ${totalPendingPackets}/${maxReorderWindow}  Late: ${totalLateDrops} dup ${totalDuplicateDrops}  Buffer: ${armedCount}/${losslessPeers} armed ${bufMs}ms / target ${targetMs}ms  Ratio: ${ratioPpm}ppm/${ratioUpdates}u${learnText}  ~${kbps} kbps`;

    // Conditional visibility — Disable when lossless is playing, Retry when Opus is.
    if (_disableBtn) {
      const show = stateStr === 'LOSSLESS ACTIVE' || stateStr === 'LOSSLESS BUFFERING';
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
      // Reset ALL session counters together so the displayed stats stay
      // consistent. Resetting frames but not underruns/bytes (v1.0.3) gave
      // a ratio that looked impossible (more drops than frames, kbps far
      // above the wire rate) once Retry was used.
      peer.frames = 0;
      peer.seqDrops = 0;
      peer.audioUnderruns = 0;
      peer.concealed = 0;
      peer.partialUnderruns = 0;
      peer.lateDrops = 0;
      peer.duplicateDrops = 0;
      peer.expectedSeq = -1;
      if (peer.pendingPackets) peer.pendingPackets.clear();
      peer.acceptFrames = PROMOTE_DELAY_MS <= 0;
      if (peer.promoteTimer) { clearTimeout(peer.promoteTimer); peer.promoteTimer = null; }
      peer.driftSkips = 0;
      peer.driftRepeats = 0;
      peer.rearmTrimFrames = 0;
      peer.bytes = 0;
      peer.bufferFrames = 0;
      peer.resamplerRatio = 1.0;
      peer.resamplerUpdates = 0;
      peer.resamplerBaseRatio = 1.0;
      peer.resamplerTrustedRatio = 1.0;
      peer.resamplerMeasuredRatio = 1.0;
      peer.resamplerPendingRatio = 1.0;
      peer.resamplerPendingConfirmations = 0;
      peer.resamplerTargetRatio = 1.0;
      peer.resamplerStableSec = 0;
      peer.resamplerActive = false;
      peer.resamplerSource = '';
      peer.arrivalSeqGaps = 0;
      peer.arrivalResets = 0;
      _resetArrivalEstimator(peer);
      peer.lastFrameMs = 0;
      peer.lastSeq = -1;
      peer.targetFrames = TARGET_BUFFER_FRAMES;
      peer.armed = false;
      peer.losslessStarted = false;
      peer.startupQueue = [];
      peer.lastGoodFrame = null;
      // Drop cached audio element ref so the next mute re-discovers it
      peer.audioEl = null;
      try {
        await _ensureAudio(peer.handshake.sampleRate);
        await _buildWorkletNode(peer);
        _sendLosslessAck(peer);
        _armLosslessPromotion(peer);
      } catch (e) { warn(`retry rebuild failed: ${e.message}`); }
    }
    _updateOverlay();
  }

  setInterval(() => {
    const now = Date.now();
    for (const [, p] of _peers) {
      if (!p.handshake || p.frames === 0) continue;
      const age = now - p.lastFrameMs;
      const ratioPpm = Math.round(((p.resamplerRatio || 1.0) - 1.0) * 1000000);
      if (DEBUG_ON) {
        log(`stats: frames=${p.frames} seqDrops=${p.seqDrops} audioUnderruns=${p.audioUnderruns} concealed=${p.concealed} buffer=${p.bufferFrames}f ratio=${ratioPpm}ppm ~${Math.round((p.bytes * 8) / (p.frames * REQUESTED_FRAME_MS / 1000) / 1000)}kbps state=${age < FALLBACK_MS ? 'active' : 'silent'} lastFrame=${age}ms ago`);
      }
    }
    _updateOverlay();
  }, 1000);

  if (document.body) { _ensureOverlay(); _updateOverlay(); }
  else document.addEventListener('DOMContentLoaded', () => { _ensureOverlay(); _updateOverlay(); });

  log(`Loaded v${VERSION}`);
})();
