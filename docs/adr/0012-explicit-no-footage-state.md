# ADR 0012: Explicit no-footage state for held tiles

**Status:** Accepted, implemented (2026-11-27)

## Context

A paused or held tile can be at a time with no recording. Showing a normal
picture without explanation is misleading; showing "no recording" merely
because a local timeline cache has a gap is also wrong. Duplicate channels must
behave identically.

## Decision

- A tile held without footage is **dimmed** and shows the explicit warning
  **"No recording"**. This applies per tile, not only to the active tile.
- Explicit seeks that find no recording set this state immediately.
- A manual pause does **not** trust the local timeline cache. The tile asks the
  camera for a recording at or after the paused time. Only when the camera has
  neither a matching nor a following recording does the dimmed warning appear.
- The status message is rendered for every tile. Tile-local messages must never
  depend on `activeTile()`.
- Starting a stream or entering live clears the no-footage state.

## Consequences

- Each manual pause triggers one lightweight recording lookup; the held frame
  remains visible during the request.
- A pause in a gap before the next recording stays visually normal, because the
  camera still has usable footage.
- The local timeline data is used for drawing and immediate feedback, but not
  as the sole authority for the pause warning.
