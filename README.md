# vdo-ninja-lossless

Browser-side lossless audio receiver for VDO.Ninja, using RTCDataChannel and AudioWorklet.

## Usage

Inject into VDO.Ninja viewer URL:

```
https://vdo.ninja/?room=YOURROOM&js=https://anthonytrance.github.io/vdo-ninja-lossless/viewer.js
```

## Files

- **viewer.js** — patches `RTCPeerConnection`, opens negotiated DC id=42, handles protocol v2 ack/FEC, mutes Opus while lossless is healthy, mirrors VDO.Ninja volume/mute, and shows the testing panel
- **audio-worklet.js** — `AudioWorkletProcessor` ring buffer, loaded automatically by viewer.js, with buffer-depth/overrun/underrun stats

## Status overlay

A small testing panel (top-right corner) shows:
- `LOSSLESS ACTIVE` / `OPUS FALLBACK` / `LOSSLESS DISABLED` / `IDLE`
- Disable lossless and Retry lossless buttons
- Viewer/worklet/protocol version
- Frames, drops, late frames, FEC repaired/unrepaired, zero-filled frames, buffer depth, approximate kbps

Screen readers receive state-change announcements only; stats are visual/testing-only and are not spammed through `aria-live`.

## Stats

Testing builds show visible stats by default. Add `losslessStats=0` or `losslessStats=false` to the URL to hide detailed stats.

## Fallback

If the DataChannel goes unhealthy, Opus audio is restored and lossless stays off for that peer until Retry lossless is used.
