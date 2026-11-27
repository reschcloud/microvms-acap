# ADR 0010: One tools sidebar, calm tiles, and desktop-first keyboard use

**Status:** Accepted, implemented (2026-11-27)

## Context

Earlier versions spread status and controls across a topbar status menu, a
floating inspector, and several cards. Ping, network rate, and storage status
were hidden in a separate popover. The video was surrounded by too much
persistent chrome.

## Decision

- There is **one tools sidebar**. It contains, from top to bottom: ping,
  incoming stream bandwidth, the storage fill meter with encryption lock, and
  any remaining diagnostic sections.
- Status is not hidden in a separate popover. The topbar only has the brand,
  layout segments, fullscreen, and the tools toggle.
- On wide desktop screens the sidebar takes layout space; below 1100 px it
  becomes an overlay. It is open by default and its state is remembered.
- Tiles use a single status dot and quiet glass chips. The live dot is green;
  red is reserved for recording and errors. Labels, clocks, audio, and the tile
  menu appear on hover, focus, or for the active tile.
- Double-clicking a tile zooms to 1-up for that tile; a second double-click
  restores the previous multi-view including channel assignments.
- Desktop keyboard shortcuts are first-class: `Space`, `L`, arrows,
  `Shift`+arrows, `1/2/4/6`, `A`, `F`, `S`, `E`, `?`, and `Esc`.
- `F` enters theater/fullscreen with a minimal glass timeline. The transport
  auto-hides, but the timeline remains visible.
- The layout is dark graphite with one blue interaction accent. Light theme and
  channel drag-and-drop are deferred.

## Consequences

- The sidebar is the single discoverable place for diagnostics and settings.
- The topbar stays compact and stable on narrow screens.
- Theater mode needs a reliable fullscreen fallback because embedded camera
  browsers may reject the Fullscreen API.
