# ADR 0009: One synchronized timeline and selection-driven export

**Status:** Accepted, implemented (2026-11-27)

## Context

The app shows one to six camera channels at once. Users compare channels at the
same moment and export the same time range. Separate, drifting timelines would
make both tasks unreliable. Export used to be a persistent form in a sidebar,
far away from the time selection.

## Decision

- There is **one shared wall-clock time** for all visible tiles. Layout changes,
  live, pause, seek, skip, and playback apply to every visible tile.
- Every tile independently resolves the recording for its own channel at that
  shared time. A channel without footage holds its last frame; the other tiles
  continue.
- The timeline has **exactly one lane per visible channel**, in tile order.
  Duplicate tiles share a lane.
- All recordings are blue; event recordings are yellow and are drawn above
  blue, so an event overlapping continuous footage remains yellow.
- A time selection opens one export bar. Channel chips choose the channels for
  export (all on by default). Saving produces one file per selected channel.
- Export options (name, exact times, merge, password, audio) live behind one
  options popover and never start the export themselves.
- The export popover opens upwards and stays inside the viewport. A list of
  individual clip links is not part of the UI.

## Consequences

- Browser download limits still apply; only the first file starts
  automatically. Users should merge each channel into one file.
- Multi-channel timeline refresh performs one `list.cgi` request per visible
  channel and must abort stale requests.
- Any future playback feature must preserve the shared-time rule. Independent
  per-tile playheads are explicitly rejected.
