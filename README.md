# vdo-ninja-lossless

Browser-side lossless audio receiver for VDO.Ninja, using RTCDataChannel and AudioWorklet.

## Usage

Inject into a VDO.Ninja viewer URL:

```text
https://vdo.ninja/?room=YOURROOM&js=https://anthonytrance.github.io/vdo-ninja-lossless/viewer.js
```

Optional low-latency tuning parameters are normal top-level VDO.Ninja URL parameters:

```text
&dcBuffer=30&losslessPreroll=2
```

Defaults: `dcBuffer=30`, `losslessPreroll=2`. `losslessBufferMs` is still accepted as a backwards-compatible alias for `dcBuffer`.

## Files

- **viewer.js** - patches `RTCPeerConnection`, opens negotiated DC id=42, handles protocol v2 ack, mutes Opus while lossless is healthy, mirrors VDO.Ninja volume/mute, and shows the testing panel.
- **audio-worklet.js** - `AudioWorkletProcessor` ring buffer, loaded automatically by `viewer.js`, with buffer-depth and underrun stats.

## Status Overlay

A small testing panel shows:

- `LOSSLESS ACTIVE` / `OPUS FALLBACK` / `LOSSLESS DISABLED` / `IDLE`
- Disable lossless and Retry lossless buttons
- Viewer/worklet/protocol version
- Frames, sequence drops, AudioWorklet underruns, concealed frames, drift corrections, re-arm trim, buffer depth, approximate kbps

Screen readers receive state-change announcements only; stats are visual/testing-only and are not spammed through `aria-live`.

## Fallback

If the DataChannel goes unhealthy, Opus audio is restored and lossless stays off for that peer until Retry lossless is used.
