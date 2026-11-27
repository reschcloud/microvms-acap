# ADR 0011: Per-tile audio with mute fallback; recording is owned by AXIS OS

**Status:** Accepted, implemented (2026-11-27); audio fallback refined by ADR 0013

## Context

Audio can make an RTSP request fail on cameras that do not support AAC or have
no audio source. The app also used to create and remove continuous recording
profiles, duplicating a function that belongs in AXIS OS.

## Decision

- Audio is controlled **per tile**. Several tiles may play audio at once.
- Audio starts muted. The browser's first user gesture unlocks playback.
- The on/off choice is stored per channel. After reload the audio track is
  requested, but remains muted until the first gesture.
- If the camera rejects the stream while audio is enabled (for example
  `RTSP 400 Bad Request`), the app disables audio for that tile, stores it as
  off, shows a short warning, and retries the video **without audio**. The
  picture must remain usable.
- The app **does not create, change, or delete continuous recording profiles**.
  Recording setup, schedules, event rules, and audio recording are handled in
  AXIS OS. The app only displays whether the camera reports an active recording
  and lists/plays/exports existing recordings.
- The status chip is informational only; it is not a recording control.

## Consequences

- A camera without AAC or without an audio source degrades to silent video
  instead of a broken stream.
- Users must configure recordings in AXIS OS; the app's documentation and UI
  must not imply otherwise.
- Existing recordings remain playable and exportable; missing audio tracks are
  not an error.
