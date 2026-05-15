# vdo-ninja-lossless

Browser-side lossless audio receiver for VDO.Ninja, using RTCDataChannel and AudioWorklet.

## Usage

Inject into VDO.Ninja viewer URL:

```
https://vdo.ninja/?room=YOURROOM&js=https://anthonytrance.github.io/vdo-ninja-lossless/viewer.js
```

## Files

- **viewer.js** — patches `RTCPeerConnection`, opens negotiated DC id=42, decodes PCM frames via AudioWorklet, mutes Opus, shows stats overlay
- **audio-worklet.js** — `AudioWorkletProcessor` ring buffer, loaded automatically by viewer.js

## Status overlay

A small overlay (top-right corner) shows:
- `LOSSLESS ACTIVE` / `OPUS FALLBACK` / `IDLE`
- Frame count and drop count
- Approximate kbps

The overlay is an `aria-live` region for screen reader announcements.

## Console stats

Every second: `frames=N underruns=N ~Nkbps state=active/silent lastFrame=Nms ago`

## Fallback

If the DataChannel goes silent for 2 seconds, Opus audio is automatically restored.
