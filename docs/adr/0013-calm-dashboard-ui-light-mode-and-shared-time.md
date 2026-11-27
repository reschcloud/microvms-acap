# ADR 0013: Calm dashboard UI, light mode, and a kept shared time

**Status:** Accepted, implemented (2026-11-27). Supersedes the sidebar and tile
styling parts of ADR 0010 and the "store audio as off" rule of ADR 0011.

## Context

The previous UI used many text sizes (10–16 px), a tools sidebar that was open
by default, a status dot plus several glass chips per tile, and a dark theme
only. Users had to read a lot before acting. A review also found behavior that
broke the shared wall clock of ADR 0006: changing the layout or zooming a tile
resumed paused tiles, the arrow key skipped "forward" in live view by
reconnecting every stream, and the typed jump time moved only the active tile.

## Decision

UI, in the style of a car dashboard:

- **One text size** (`--fs: 15px`) everywhere, the timeline canvas included.
  Hierarchy comes from weight and color only. The single exception is the step
  number drawn inside the skip icons.
- **Few, self-explanatory controls.** A centered transport (5 s/30 s back,
  play/pause, 30 s forward), "Save image" on the left, a red "Live" button on
  the right that only appears when it can do something. The timeline toolbar
  keeps day navigation, zoom, a two-color legend, "Time" and "Save clip"; the
  "whole day" button was removed (the date picker and "Today" cover it).
- **Secondary information is out of the way.** Ping, bandwidth, storage, device
  name, language, appearance, and help live in a settings sheet that is
  **closed by default**. The topbar keeps the recording status chip.
- **Tiles** show only what matters: channel name (multi-channel only), clock,
  and one state pill (Live red, Playback blue, others neutral). Empty slots only
  show "Choose channel". Overlays on video stay dark in both themes.
- **Light mode.** Appearance is Auto (follows the OS), Light, or Dark, stored as
  `minivms.theme`. An inline script in `<head>` applies it before the first
  paint. Both palettes define the same tokens; the timeline canvas re-reads its
  colors (`--tl-*`, `--continuous`, …) after every theme change.

Behavior:

- Layout changes and tile zoom keep the **shared time state**: all live stays
  live, all paused stays paused at the same instant, otherwise playback resumes
  at the shared time. Selecting the current layout again does nothing.
- A seek in a multi-view moves the shared clock to the **earliest footage of any
  visible tile**. Tiles without footage at that instant hold with "No recording"
  and start by themselves when the clock reaches their next recording. A tile
  whose recording ends waits the same way instead of jumping ahead alone.
  Pause, resume and the skip buttons act on this shared clock.
- Skipping forward never touches a tile that is live.
- The typed jump time seeks every visible tile.
- Ambiguous source choices belong to their tile; the card shows the active
  tile's list.
- Audio fallback: only an RTSP rejection disables audio, for the tile and the
  current session only. The saved preference is kept. Playback requests audio
  only for recordings that report an audio track.
- Further export parts are listed as visible links in the export bar.

## Consequences

- Tests guard the single font size, both theme palettes, the pre-paint theme
  script, and each behavior fix above.
- `LANE_TOP`/`LANE_HEIGHT` in `app.js` and `.tl-label` heights in `style.css`
  must stay in sync.
- On phones the 30 s back button is hidden; `Shift`+`←` and the timeline remain.
