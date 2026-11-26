# Micro VMS ACAP

## Build and verify

- Run `./build.sh` with Docker. It uses Axis ACAP Native SDK 12.11.0 and replaces the entire ignored `build/` directory with the packaged app tree. Edit `app/`, not `build/`. The aarch64 SDK image still produces one architecture-`all` package: `build/Micro_VMS_0_2_3_all.eap` for manifest version `0.2.3`.
- Run `node --test tests/app.test.cjs` with Node 22 (no npm install) for mocked VAPIX/playback tests; for shell changes use `sh -n build.sh` and `sh -n app/microvms`. Dependabot tracks the Docker SDK image only, not the vendored JavaScript.
- For an end-to-end smoke test, install the `.eap` in Axis Apps, start it, and open `/local/microvms/index.html` on the camera. The UI uses the camera's existing login and same-origin VAPIX/RTSP-over-WebSocket endpoints. A static preview needs mocked API responses; it does not verify streaming or export. Playback/export checks need a camera with recordings on configured SD/NAS storage.

## Runtime wiring

- `app/microvms` only keeps ACAP in the Running state so the camera shows **Open**. `app/html/index.html` loads classic scripts directly: `i18n.js`, the vendored media-stream library, and `mkvconcat.js` provide globals before `app.js` starts; `ptz.js` consumes `window.MicroVms` and subscribes synchronously to `microvms:mode` and `microvms:channel`. Keep both DE and EN dictionaries in sync when adding UI text. The legacy `minivms.*` storage keys are intentional so same-origin preferences survive the rename.
- Channel handling: VAPIX `camera=N` is 1-based, while `Image.I#` is 0-based. Numbered recording sources are mapped only with evidence (`0` vs. the physical channel count). The gray timeline track allows explicit playback/export of one ambiguous recording by ID without assigning it to a channel; `Quad` is not a numbered channel.
