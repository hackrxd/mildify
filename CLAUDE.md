# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Mildify is a desktop Spotify client: Tauri 2 (Rust) backend, Svelte 5 + TypeScript frontend. It browses
through the Spotify Web API and plays through an embedded librespot Spotify Connect device.

## Commands

```bash
npm install
npm run tauri dev        # run the app (Vite on :1420 + debug Rust build)
npm run check            # svelte-check: type-checks the whole frontend, including the vendored renderer
npm run build            # frontend only, into dist/ (tauri build runs this itself)
npm run tauri build      # installers for the current OS, into src-tauri/target/release/bundle/
npm run tauri build -- --bundles deb   # one quick bundle for local testing (the AppImage takes longest)
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
(`src/lib/ipc.ts` → `src-tauri/src/lib.rs` → `webapi.rs`), which holds the token, refreshes it and paces requests:
at most 40 per rolling 30 s (the rest wait), and after a 429 longer than 5 s it fails every request locally until
it's over, kept across restarts in `webapi_cooldown.json`, since requests sent during a rate limit can extend it.
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
per-frame for lyrics. The sink also feeds `meter.rs`: with Audio-responsive Effects on, each packet's loudness is
filed under when it will be heard and sent as `audio-level` events, which `src/lib/audiofx.svelte.ts` turns into the
`--audio-pulse` CSS variable on the player bar, whose cover glow grows with it.

**Frontend state** lives in Svelte 5 rune classes in `src/lib/*.svelte.ts`, as singletons (`session`, `player`,
`router`, `lyrics`, …). Routing is the in-memory `router` store; views live in `src/views/`.

**Lyrics.** `src/spicy-lyrics/` is a vendored port of the Spicy Lyrics renderer (AGPL-3.0), aliased as the
`spicy-lyrics-renderer` module in `vite.config.ts`. The app plugs into it through `setHost()`
(`compat/host.ts`, implemented in `src/lib/lyrics.svelte.ts`). The rendering core is kept verbatim so it can be
diffed against upstream. Any upstream file you modify needs a `Modified for Mildify` note at the top
(AGPL §5(a)) and an entry in `src/spicy-lyrics/README.md`. Lyrics are fetched only from the Nativify lyrics
service (`lyrics.rs`; the URL is fixed in the backend), which may require its own account login.
The lyrics clock is shifted by `lyrics.totalOffsetMs`: the global offset plus the playing song's own nudge
(`songOffsets`, by track id). Anything that times lines against `player.positionNow()` must subtract it, as the
host and `DeckLyric` do. The text size scales the renderer's `--DefaultLyricsSize` from `Lyrics.svelte`'s styles,
not from the vendored CSS. The renderer's Kawarp background normally sits in its `.ContentBox`; with
`lyrics.backdrop` on, `mount(host, backdrop)` paints it into `App.svelte`'s fixed `.backdrop` behind the whole shell,
whose panels then turn transparent (or tinted, `lyrics.backdropDim`). The theme's colours cross-fade with it over
`BACKDROP_FADE_MS`, and `unmount(lingerMs)` keeps the background running until the fade out ends.

**Themes and extensions.** `mods.rs` lists `themes/` and `extensions/` in the app config dir and serves them
over the `nsmod` URI scheme (`nsmod://localhost/…`, `http://nsmod.localhost/…` on Windows; allowed in the CSP),
refusing paths that leave those folders. Built-in themes are stylesheets in `src/themes/`, listed in its
`index.ts` with `builtin:` ids and linked from the app's own assets. `src/lib/mods.svelte.ts` links the active
theme and Quick CSS at the end of `<body>`, imports enabled extensions as ES modules once the session is ready,
and hands each the `ExtensionApi`. Everything an extension registers through it is undone when it's turned off;
window focus re-reads the folders, so edits apply live. `--safe-mode` loads none of it. User-facing guide:
`docs/mods.md`.

**AI DJ.** Off by default, and nothing of it ships with the app. `src-tauri/src/dj/` downloads its runtimes
(llama.cpp's `llama-server`, sherpa-onnx's TTS program), the chosen GGUF model and voice into `<app data>/dj/`, only
while `config.dj.enabled` (`install.rs`: resumable, SHA-256 pinned in `manifest.rs`, models from a fixed Hugging
Face commit, unpacked beside its folder and moved in once complete). `engine.rs` runs `llama-server` on a random loopback
port with an API key, `--jinja` and `--offline`. `chat.rs` asks it, the user's own OpenAI-style server, or a cloud
provider (`DjConfig.provider`: OpenAI, Gemini through its OpenAI-compatible endpoint, Anthropic's Messages API)
with the user's key, which `secrets.rs` keeps in the system keychain (`keyring`; a 0600 file without one) and never
hands the UI (`DjConfig.api_keys` only flags which are saved, so the keychain is read, off the async workers, only
when a cloud model is asked); `voice.rs` reads lines to WAV
and times each sentence from the program's per-sentence sample counts, and `speaker.rs` plays them on the default
output through rodio, as the music plays (`dj_voice`, reporting back in `dj-voice` events). Not through the web view:
WebKitGTK's Web Audio needs GStreamer plugins that many systems lack. The UI does the rest: `djPicks.ts` builds
segments from top tracks, recent plays and liked songs (read by `djListening.ts`), and `djTalk.ts` asks for
`{name, songs, talk}` against a JSON schema
(llama.cpp writes properties alphabetically, so the songs come before the talk), falling back to templates. Later
sets are told their number and what was said before, so they don't greet again, and only the first song is named
unless `dj.nameAll`. When `DjStatus.tools` says the model can call tools, a first request offers `look_up_songs`;
`dj_song_info` (`songinfo.rs`: librespot metadata through the device's session, Web API artist genres, MusicBrainz
at 1 request/s, kept a month) answers, and the facts go into the JSON request as plain text, the same for every
provider;
`djTiming.ts` plans the talk around both songs' synced lyrics (shifted by the song's own `songOffsets` nudge): the
talk is an item of its own (`dj.onAir`, shown by the player bar and queue), overlapping 1.5 to 5 s of the finishing
song's outro and of the next song's intro (under at most half the line), or none, each behind a setting
(`overEnd`/`overStart`). `dj.svelte.ts` plays a set with `playUris(…, here)` and queues the next during its last
song; cues on the song's clock (`player.positionNow()`) start the talk and, when it outlasts both overlaps, silence
the music right at the song's end. Spotify's queued song is caught as it comes up, paused, and brought in from its
start by a cue on the line's clock (`Voice.now()`, kept in the page between the backend's reports, which stands still
while paused). While it talks, `dj_duck` lowers
the music in the sink (`duck.rs`, by heard time, lifting itself after 90 s if nobody does, so the DJ says it again
every 30 s). Captions are `LyricLine`s, so `DjCaption` reuses the lyric sweep. With `dj.live` (Settings: "Pick songs
as it goes") a set keeps the model's picks as `plan` and grows song by song (a new object per step, same `id`):
`#goLive` picks each next song with `djPicks.nextInSet` (likes noticed through `liked.has`, skips, the plan) and
lines it up with the device's `clear_queue` + `queue` commands (librespot's own queue), and the next set is
picked only as the last song starts. Only songs a set was started with sit behind the player, so Next and
Previous go through `dj.skipTalk()`/`dj.previous()`, which line up a song before moving. `dj.request(text)` makes the next set a
requested one (`requestSegment`/`requestChoices`), replacing an `upNext` not yet introduced (its queue cleared after
what's on its way through `#queuing`, its hand-over dropped by `#dropHandOver`, a set still being picked ignored
through `#prepareGen`); `dj.skipSet()` clears the queue, holds the music and picks the next set again from the song
playing, waiting `SKIP_WAIT_MS` for it before rushing to a template (a template for a request plays only songs it
names).
User guide: `docs/dj.md`.

**mild-lyrics bridge.** `devtools.rs` serves what mild-lyrics reads from the Spotify app's
`--remote-debugging-port`: `/json` with one `xpui` page target, and its websocket's `Runtime.evaluate`. It runs
nothing it's sent: `recognise` matches mild-lyrics' player scripts (controls only as whole calls), asks the window
for a player snapshot or control over `devtools-ask` (`src/lib/devtools.ts` answers through `devtools_answer`), and
replies with the value that script returns in Spotify; anything else gets a JavaScript error back. Off unless
Settings turns it on (port 9222) or the app is started with `--remote-debugging-port=N`; loopback only, and it
refuses requests with an Origin or a non-IP, non-localhost Host, as Chromium does.

**Updates.** `src/lib/updater.svelte.ts` asks the backend first (`ui_update`, `src-tauri/src/ui.rs`): each
release also ships its built UI as a signed `ui-X.tar.gz`, announced by `ui.json` beside `latest.json`. Every build
writes `dist/build.json` (`scripts/build-info.ts`): the version and a hash of everything under `src-tauri` plus the
`@tauri-apps` JS package versions, the backend id. When the release's backend id matches the binary's, the bundle
is unpacked into `<app data>/ui/` and `ui.rs` serves it through the `tauri://` asset provider instead of the
embedded UI; a webview reload switches to it, and playback carries on. Any difference goes to the full updater,
whose restart stops the music, and the UI says so. A downloaded UI is ignored once the binary's own is as new, and
under `--safe-mode`.

**Changelog.** `CHANGELOG.md` is the one list of user-facing changes: `## X.Y.Z - date` sections of `### Added`/
`Changed`/`Fixed` items, written for users, newest first. Add a line under `## Unreleased` with any change a user
would notice. `src/lib/changelog.ts` parses it (imported `?raw`) for the What's new page (`src/views/Changelog.svelte`),
which `src/lib/whatsnew.svelte.ts` offers in a banner on the first launch after the interface's version changes.

**Vendored librespot-core.** librespot is pinned to a dev-branch commit (`Cargo.toml`), and `librespot-core` is
patched from `src-tauri/vendor/librespot-core` so free accounts log an error instead of exiting the process. That
error is surfaced as the `premium_required` device state. See `vendor/librespot-core/PATCHED.md`.

**Linux WebKitGTK workaround.** `src-tauri/src/webkit.rs` runs before GTK starts. With NVIDIA's proprietary
driver on Wayland, it sets `WEBKIT_FORCE_DMABUF_RENDERER=1` and `__NV_DISABLE_EXPLICIT_SYNC=1`. The AppImage
bundles Ubuntu 24.04's WebKitGTK, whose Debian patch otherwise falls back to software rendering on NVIDIA; the
lyrics view then drops to about 20 fps. Without the explicit-sync variable, KWin kills the app with a Wayland
protocol error. Under X11 the forced renderer draws nothing, so the workaround is Wayland-only. The AppImage is
built on 24.04 for its WebKitGTK 2.52: 22.04's 2.50 made sung lyrics shimmy. `.deb` and `.rpm` use the system's
WebKitGTK and are still built on 22.04, for its older glibc.

## Spotify API constraints (February 2026 development-mode rules)

Spotify rejects requests that exceed these limits with a 400 "Invalid limit". Check new endpoints against them:

- `/search`: `limit` at most 10.
- `/artists/{id}/albums`: `limit` at most 10.
- Playlist track lists only for playlists the user owns or collaborates on. Items moved from `track` to `item`;
  use `itemTrack()`.
- Browse, new releases, artist top tracks and recommendations are gone, as are `popularity` and `followers`.
- The library uses the unified `/me/library` endpoints with full URIs, at most 40 per call.

## Releases

1. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z - YYYY-MM-DD` and put a fresh `## Unreleased` above it
   (commit: `docs(changelog): X.Y.Z`).
2. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`) and `package.json`
   (+ `package-lock.json`).
3. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.
4. `.github/workflows/build.yml` fails early if the tag doesn't match `tauri.conf.json`, or if `CHANGELOG.md` has no
   section for it (`scripts/release-notes.mjs`, also a test against `package.json`'s version). That section is the
   GitHub release's notes, above GitHub's generated list. It builds Windows, macOS (arm64 and x64) and Linux
   (`.deb`/`.rpm` and the interface bundle on ubuntu-22.04, the AppImage on ubuntu-24.04) into a draft release,
   then publishes it once all five builds and the test job pass. Installed apps update from that release's
   `ui.json` (reload only, when `src-tauri` is unchanged) or `latest.json`. Update bundles are signed with
   `TAURI_SIGNING_PRIVATE_KEY`; the matching pubkey is in `tauri.conf.json`.

Pushes to `main` and pull requests only run the test job, which also runs `scripts/platform-deps.mjs`: every release
target must get the same direct dependencies, since a shared one written below a `[target.'cfg(…)'.dependencies]`
table silently becomes that platform's only. Installers are built only for version tags, or by
starting the workflow by hand (`gh workflow run build.yml --ref <branch>`).

A tag run can't reuse another tag's caches, so `.github/workflows/rust-cache.yml` keeps the release builds'
dependency cache warm on `main`: it builds each platform without bundling when `Cargo.toml`/`Cargo.lock` change,
and every three days restores the caches so they aren't evicted. Its matrix, setup steps and `shared-key` must match
the build job's.

## Commit conventions

Small commits, usually one file or concern each, with a lowercase `area(scope): summary` subject and no body.
Areas seen in history: `rust(...)`, `ts(...)`, `svelte(...)`, `config(...)`, `docs`, `depend`, `vendor(...)`.
Examples: `ts(api): artist albums 10 per page, the development-mode cap`, `svelte(views): artist page with
discography`. A version bump is three commits: `config(tauri): version X`, `config: rust crate version X`,
`config: npm package version X`.
If needed, check previous commits in the repository.