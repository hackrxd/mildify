# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Native Spotify is a desktop Spotify client: Tauri 2 (Rust) backend, Svelte 5 + TypeScript frontend. It browses
through the Spotify Web API and plays through an embedded librespot Spotify Connect device.

## Commands

```bash
npm install
npm run tauri dev        # run the app (Vite on :1420 + debug Rust build)
npm run check            # svelte-check: type-checks the whole frontend, including the vendored renderer
npm run build            # frontend only, into dist/ (tauri build runs this itself)
npm run tauri build      # installers for the current OS, into src-tauri/target/release/bundle/
npm test                 # Vitest (jsdom): src/**/*.test.ts
cd src-tauri && cargo test --lib
cd src-tauri && cargo clippy
```

Frontend tests sit next to the module they test (`src/lib/*.test.ts`); tests for the vendored renderer live in
`src/spicy-lyrics/tests/` so the upstream tree stays diffable. Rust tests are `#[cfg(test)] mod tests` at the
bottom of each file and never touch the network: logic that depends on the clock or environment takes them as
parameters (`OutputClock::heard_at`, `webkit::picks_wayland`, `lyrics::cached`), and the sign-in redirect is
tested over a real loopback socket. Rune modules are tested with `vi.resetModules()` and a dynamic import per
test, so each test gets a fresh singleton.

To check the lyrics renderer without Tauri or the lyrics service, run `npm run dev` and
open `http://localhost:1420/lyrics-harness.html` (`src/dev/lyrics-harness.ts`: fake host, simulated clock,
sample syllable sync).

## Architecture

**The UI never talks to Spotify directly.** Every Web API call goes through the `api` Tauri command
(`src/lib/ipc.ts` → `src-tauri/src/lib.rs` → `webapi.rs`), which holds the token, refreshes it and handles 429s.
`src/lib/spotify.ts` holds the typed endpoint wrappers. Backend errors reject with the `AppError` shape
(`kind`/`message`/`status`) from `error.rs`, mirrored in `ipc.ts`.

**Two kinds of sign-in.** `auth.rs` runs PKCE against the user's own developer app (client ID typed into the setup
screen, redirect `http://127.0.0.1:8898/callback`) for the Web API. Separately, librespot's OAuth (loopback port
5588) authorizes the Connect device. Tokens and credentials are cached in the app data dir.

**Playback.** `device.rs` runs librespot in-process as a Connect device with a supervisor that restarts it, and
reports its state through `device-status` events. The UI starts music with Web API calls
(`PUT /me/player/play?device_id=…`). When the embedded device is the active one, transport commands skip the Web
API (`device_command`), and librespot's player events reach the UI as `local-player` events.
`src/lib/player.svelte.ts` merges those events with Web API polling: local events win for about 2.5 s after they
arrive. It also interpolates the playback position: `position` updates at 4 Hz for UI, and `positionNow()` is
per-frame for lyrics.

**Frontend state** lives in Svelte 5 rune classes in `src/lib/*.svelte.ts`, as singletons (`session`, `player`,
`router`, `lyrics`, …). Routing is the in-memory `router` store; views live in `src/views/`.

**Lyrics.** `src/spicy-lyrics/` is a vendored port of the Spicy Lyrics renderer (AGPL-3.0), aliased as the
`spicy-lyrics-renderer` module in `vite.config.ts`. The app plugs into it through `setHost()`
(`compat/host.ts`, implemented in `src/lib/lyrics.svelte.ts`). The rendering core is kept verbatim so it can be
diffed against upstream. Any upstream file you modify needs a `Modified for Native Spotify` note at the top
(AGPL §5(a)) and an entry in `src/spicy-lyrics/README.md`. Lyrics are fetched only from the Nativify lyrics
service (`lyrics.rs`; the URL is fixed in the backend), which may require its own account login.
The lyrics clock is shifted by `lyrics.totalOffsetMs`: the global offset plus the playing song's own nudge
(`songOffsets`, by track id). Anything that times lines against `player.positionNow()` must subtract it, as the
host and `DeckLyric` do. The text size scales the renderer's `--DefaultLyricsSize` from `Lyrics.svelte`'s styles,
not from the vendored CSS. The renderer's Kawarp background normally sits in its `.ContentBox`; with
`lyrics.backdrop` on, `mount(host, backdrop)` paints it into `App.svelte`'s fixed `.backdrop` behind the whole shell,
whose panels then turn transparent (or tinted, `lyrics.backdropDim`).

**Themes and extensions.** `mods.rs` lists `themes/` and `extensions/` in the app config dir and serves them
over the `nsmod` URI scheme (`nsmod://localhost/…`, `http://nsmod.localhost/…` on Windows; allowed in the CSP),
refusing paths that leave those folders. Built-in themes are stylesheets in `src/themes/`, listed in its
`index.ts` with `builtin:` ids and linked from the app's own assets. `src/lib/mods.svelte.ts` links the active
theme and Quick CSS at the end of `<body>`, imports enabled extensions as ES modules once the session is ready,
and hands each the `ExtensionApi`. Everything an extension registers through it is undone when it's turned off;
window focus re-reads the folders, so edits apply live. `--safe-mode` loads none of it. User-facing guide:
`docs/mods.md`.

**Vendored librespot-core.** librespot is pinned to a dev-branch commit (`Cargo.toml`), and `librespot-core` is
patched from `src-tauri/vendor/librespot-core` so free accounts log an error instead of exiting the process. That
error is surfaced as the `premium_required` device state. See `vendor/librespot-core/PATCHED.md`.

**Linux WebKitGTK workaround.** `src-tauri/src/webkit.rs` runs before GTK starts. With NVIDIA's proprietary
driver on Wayland, it sets `WEBKIT_FORCE_DMABUF_RENDERER=1` and `__NV_DISABLE_EXPLICIT_SYNC=1`. The AppImage
bundles Ubuntu 22.04's WebKitGTK, whose Debian patch otherwise falls back to software rendering on NVIDIA; the
lyrics view then drops to about 20 fps. Without the explicit-sync variable, KWin kills the app with a Wayland
protocol error. Under X11 the forced renderer draws nothing, so the workaround is Wayland-only.

## Spotify API constraints (February 2026 development-mode rules)

Spotify rejects requests that exceed these limits with a 400 "Invalid limit". Check new endpoints against them:

- `/search`: `limit` at most 10.
- `/artists/{id}/albums`: `limit` at most 10.
- Playlist track lists only for playlists the user owns or collaborates on. Items moved from `track` to `item`;
  use `itemTrack()`.
- Browse, new releases, artist top tracks and recommendations are gone, as are `popularity` and `followers`.
- The library uses the unified `/me/library` endpoints with full URIs, at most 40 per call.

## Releases

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`) and `package.json`
   (+ `package-lock.json`).
2. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. `.github/workflows/build.yml` fails early if the tag doesn't match `tauri.conf.json`. It builds Windows, macOS
   (arm64 and x64) and Linux (on ubuntu-22.04) into a draft release, then publishes it once all four builds
   and the test job pass. Installed apps update from that release's `latest.json`. Update bundles are signed
   with `TAURI_SIGNING_PRIVATE_KEY`; the matching pubkey is in `tauri.conf.json`.

Pushes to `main` and pull requests only run the test job. Installers are built only for version tags, or by
starting the workflow by hand (`gh workflow run build.yml --ref <branch>`).

## Commit conventions

Small commits, usually one file or concern each, with a lowercase `area(scope): summary` subject and no body.
Areas seen in history: `rust(...)`, `ts(...)`, `svelte(...)`, `config(...)`, `docs`, `depend`, `vendor(...)`.
Examples: `ts(api): artist albums 10 per page, the development-mode cap`, `svelte(views): artist page with
discography`. A version bump is three commits: `config(tauri): version X`, `config: rust crate version X`,
`config: npm package version X`.
If needed, check previous commits in the repository.