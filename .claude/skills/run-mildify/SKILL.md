---
name: run-mildify
description: Run, start, drive and screenshot the Mildify desktop app's UI headlessly (views, themes, sign-in screen, lyrics harness) without Spotify or a Tauri window. Use when asked to run the app, take screenshots, or check a frontend change in a browser.
---

# Run Mildify (frontend + fake Tauri backend)

Mildify is a Tauri 2 app, but the container has no Spotify login, no display and no webkit stack. The UI is plain
Svelte, so the agent path is: Vite dev server + headless Chromium (Playwright) + `mock.js`, which stands in for
the Tauri backend (`invoke`/events) and serves fake library data. You see the real UI and layout; playback, lyrics
fetching, the DJ and the Rust backend are **not** exercised. For those, see the Rust tests in CLAUDE.md.

Paths are relative to the repo root.

## Prerequisites

Playwright and Chromium are preinstalled in the container (`/opt/node-tools`, `/opt/pw-browsers`); the driver uses
them directly. Nothing to apt-get.

## Setup

```bash
npm ci        # not `npm install`: that rewrites package-lock.json
```

## Run (agent path)

```bash
npm run dev > /tmp/vite.log 2>&1 &   # Vite on :1420
echo $! > /tmp/vite.pid
for i in $(seq 30); do curl -sf localhost:1420 >/dev/null && break; sleep 1; done

node .claude/skills/run-mildify/driver.mjs /tmp/shots            # everything: 23 PNGs
node .claude/skills/run-mildify/driver.mjs /tmp/shots views      # or any of: views themes setup lyrics

kill $(cat /tmp/vite.pid)
```

Output is 1360x860 PNGs: `01-home` … `12-settings-more` (views, queue panel, settings), `theme-<name>` (all nine
themes on Home), `13-setup` (signed-out first-run screen), `14-lyrics-harness` (`/lyrics-harness.html`). **Look at
them**; a blank frame means the mock or dev server failed. `PAGEERR` lines in the output are uncaught page errors.

To drive your own flow, copy the `page()` helper from `driver.mjs`: `addInitScript({path: "mock.js"})` before
`goto("http://localhost:1420/")`. Set `window.__SIGNED_OUT = true` first for the setup screen. Add fake data or
commands in `mock.js` (`api()` routes by Web API path, `handlers` maps Tauri command names).

## Run (human path)

`npm run tauri dev` needs Rust, WebKitGTK, a display and a Spotify developer app plus Premium account. Not usable
headless and not tried here.

## Gotchas

- Don't `pkill -f vite`: in this shell it matches and kills the calling shell (exit 144). Kill the saved PID.
- Unmocked Tauri commands resolve to `null` and `plugin:*` calls too, so views depending on them show empty states
  rather than errors. Add a handler in `mock.js` when you need one.
- The player bar shows a playing track because the mock answers `/me/player` with `is_playing: true`; the position
  keeps ticking, so the time differs between runs.
- Covers are generated SVG data URIs, not network images.
- The driver imports Playwright from `/opt/node-tools/node_modules/playwright` (override with `PLAYWRIGHT_DIR`);
  it is not a project dependency, so a bare `import "playwright"` fails.

## Tests

```bash
npm test      # Vitest (jsdom), frontend only; passes in this container
```
