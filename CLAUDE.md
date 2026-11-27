# Claude Code

This repository is maintained by different coding agents. The shared,
authoritative project instructions are in **[AGENTS.md](AGENTS.md)**. Read it
before changing anything; it covers build, tests, releases, runtime wiring, and
editing conventions.

Quick reminders:

- Edit `app/`, never the generated `build/` directory.
- Tests: `node --test tests/app.test.cjs` (Node 22, no `npm install`).
- Build: `./build.sh` (Docker, Axis ACAP Native SDK).
- Release: `./release.sh <version>` (bumps the manifest, commits, tags, pushes).
- Keep the German and English dictionaries in `app/html/i18n.js` in sync.
- Do not hardcode the `?v=<version>` cache-busting query in `app/`.
