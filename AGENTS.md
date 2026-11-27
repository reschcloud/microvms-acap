# Micro VMS ACAP

## Build and verify

- Releases are automated: `./release.sh <version>` bumps `app/manifest.json`, commits, tags and pushes; `.github/workflows/release.yml` then builds and publishes the `.eap` (and fails if tag and manifest version differ). `tests.yml` runs the Node tests on every push/PR. Pushing `build/` artifacts is not needed.
- Run `./build.sh` with Docker (Axis ACAP Native SDK 12.11.1, see `Dockerfile`). It replaces the entire ignored `build/` directory with the packaged app tree: `build/Micro_VMS_<version>_all.eap`, one architecture-`all` package. Edit `app/`, not `build/`.
- The Dockerfile appends `?v=<manifest version>` to every local CSS/JS URL in `html/index.html`. ACAP serves static files with long cache headers, and without this an update keeps the old `style.css`/`app.js` in the browser (broken layout, missing features). Do not hardcode `?v=` in `app/`.
- Run `node --test tests/app.test.cjs` with Node 22 (no npm install) for mocked VAPIX/playback tests; for shell changes use `sh -n build.sh && sh -n app/microvms && sh -n release.sh`. Dependabot tracks the Docker SDK image and the GitHub Actions, not the vendored JavaScript; the Node version in the workflows is pinned and updated by hand.
- For an end-to-end smoke test, install the `.eap` in Axis Apps, start it, and open `/local/microvms/index.html` on the camera. The UI uses the camera's existing login and same-origin VAPIX/RTSP-over-WebSocket endpoints. A static preview needs mocked API responses; it does not verify streaming or export. Playback/export checks need a camera with recordings on configured SD/NAS storage.

## Runtime wiring

- `app/microvms` only keeps ACAP in the Running state so the camera shows **Open**. `app/html/index.html` loads classic scripts directly: `i18n.js`, the vendored media-stream library, and `mkvconcat.js` provide globals before `app.js` starts; `ptz.js` consumes `window.MicroVms` and subscribes synchronously to `microvms:mode` and `microvms:channel`. Keep both DE and EN dictionaries in sync when adding UI text. The legacy `minivms.*` storage keys are intentional so same-origin preferences survive the rename.
- Channel handling: VAPIX `camera=N` is 1-based, while `Image.I#` is 0-based. Numbered recording sources are mapped only with evidence (`0` vs. the physical channel count). The gray timeline track allows explicit playback/export of one ambiguous recording by ID without assigning it to a channel; `Quad` is not a numbered channel.

## UI conventions

- One text size: every rule uses `var(--fs)` (15 px); hierarchy comes from weight and color. A test enforces this. The canvas draws with the same size (`FONT_PX` in `app.js`).
- Dark and light theme share all rules and differ only in the tokens of `:root[data-theme="dark"|"light"]`. New colors need a token in both blocks; the timeline canvas reads `--tl-*`, `--continuous`, `--triggered`, `--sel`, `--line`, `--muted` and `--live` via `readColors()`.
- `LANE_TOP`/`LANE_HEIGHT` in `app.js` must match the `.tl-label` heights in `style.css`.
- Keep the main view minimal: secondary status belongs in the settings sheet (`#inspector`), see ADR 0013.
