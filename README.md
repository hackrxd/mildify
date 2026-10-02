# Native Spotify

A custom desktop Spotify client. It browses your music through the **Spotify Web API** and plays it
locally through **Spotify Connect**, using an embedded [librespot](https://github.com/librespot-org/librespot)
device — no official Spotify app required.

Built with Tauri 2 (Rust) and Svelte 5.

## How it works

```
┌──────────────────────────── Native Spotify ─────────────────────────────┐
│  Svelte UI ──invoke──▶ Rust backend                                     │
│                         ├─ webapi.rs   Web API proxy (your client ID,   │
│                         │              token never reaches the UI)      │
│                         └─ device.rs   librespot Connect device ──▶ 🔊  │
└─────────────────────────────────────────────────────────────────────────┘
         │  "play album X on device D"            ▲ audio stream
         ▼                                        │
   api.spotify.com ───────── Spotify Connect ─────┘
```

- **Selection and metadata**: the UI calls the Web API (through the backend) for search, albums,
  playlists and your library, and starts playback with `PUT /me/player/play?device_id=…`.
- **Playback**: the backend runs librespot in-process as a Connect device named "Native Spotify".
  Spotify streams to it like any other speaker. When it's the active device, play/pause/seek/volume
  go straight to it without a network round-trip, and its player events update the UI live.
- You can also pick any other Connect device (phone, speaker, desktop app) from the device menu
  and control it from here.

## Requirements

- **Spotify Premium** (librespot playback and Web API playback control both need it).
- A **Spotify developer app** of your own (free).
- Platform build tools:
  - Windows: Visual Studio Build Tools with the C++ workload, and the Windows 11 SDK.
  - macOS: Xcode Command Line Tools (`xcode-select --install`).
  - Linux (Debian/Ubuntu): `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libasound2-dev build-essential`.
    Other distros need the same WebKitGTK 4.1 and ALSA development packages.
- [Rust](https://rustup.rs) (stable) and Node.js 20+.

## Setup

1. Create an app at <https://developer.spotify.com/dashboard>.
   - Select **Web API**.
   - Add the redirect URI `http://127.0.0.1:8898/callback`.
2. Install and run:

   ```bash
   npm install
   npm run tauri dev
   ```

3. Paste your app's Client ID into the setup screen and sign in. Your browser opens twice: once
   to approve your developer app (Web API), then once to authorize this computer as a playback
   device (librespot).

Tokens and librespot credentials are cached in the app's data directory, so you only sign in once.

To build an installer for the computer you're on: `npm run tauri build`. It lands in
`src-tauri/target/release/bundle/` (`.msi`/`.exe` on Windows, `.dmg`/`.app` on macOS,
`.deb`/`.rpm`/`.AppImage` on Linux).

Tests: `npm test` runs the frontend's (Vitest), and `cargo test --lib` in `src-tauri/` runs the
backend's. Neither needs a Spotify account or network access.

Tauri can't build for another operating system, so the GitHub Actions workflow in
[.github/workflows/build.yml](.github/workflows/build.yml) builds all of them: Windows, macOS
(Apple silicon and Intel) and Linux. Pushes to `main` and pull requests only run the tests.
Pushing a `v*` tag builds the installers and publishes a release with them attached once the tests
and all four builds pass; starting the workflow by hand (Actions → build → Run workflow) builds
them for any branch as workflow artifacts. The macOS builds aren't
signed, so the first launch needs right-click → Open (or `xattr -cr "/Applications/Native Spotify.app"`).

## Updates

Installed copies check this repo's latest GitHub release on launch and every 6 hours, download a
newer version in the background, and install it when you click **Restart now** (or under
Settings → Updates). Windows, macOS and the Linux AppImage update themselves; `.deb` and `.rpm`
installs don't, so reinstall those by hand.

Updates are signed, and the app only installs bundles signed with the key matching the `pubkey` in
[tauri.conf.json](src-tauri/tauri.conf.json). The private key lives outside the repo
(`~/.tauri/nativespotify.key`, with its password in `nativespotify.key.password`). CI reads them from
the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. If the key
is lost, existing installs can't update anymore, and everyone has to reinstall a build with a new key.

To ship a release:

1. Bump `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. The workflow builds into a draft release and publishes it once all four builds succeed.
   Installed apps pick it up from then on. If a build fails, the draft stays unpublished: fix it,
   delete the draft and the tag, and tag again. A tag that doesn't match the version in
   `tauri.conf.json` fails before anything builds.

## Lyrics

The lyrics view (the lines button in the player bar) runs the renderer from
[Spicy Lyrics](https://github.com/Spikerko/spicy-lyrics): syllable-by-syllable highlighting,
background vocals, line-synced and static fallbacks, the animated cover-art background and the
cover panel. It's ported from the Spicetify extension with only its Spotify-client plumbing
replaced; see [src/spicy-lyrics/README.md](src/spicy-lyrics/README.md) for exactly what changed.
Lyrics come from the Spicy Lyrics API through the Nativify lyrics service (below), and the view
always credits the provider (and the community members who made a sync), as the API's terms
require.

When the window is wide enough, the player bar also shows the current line next to the song title
(hover it for the credit, click it for the lyrics view). Turn it off under Settings → Lyrics.

Romanization isn't included yet: upstream downloads and runs romanization packages from a CDN
at runtime. Lyrics that ship their own romanization still get the toggle.

## Lyrics service

Lyrics are fetched only from the Nativify lyrics service at `https://nativify.hackrvt.xyz`
([native-spotify-backend](../native-spotify-backend)). It holds the Spicy Lyrics API key, caches
responses and may require an account. If it does, sign in under Settings → Lyrics (or from the
lyrics view when it asks). The address is built into the app and can't be changed in Settings.

The app fetches lyrics for the next few songs in your queue ahead of time (Settings → Lyrics →
Load lyrics ahead: 3 songs by default, up to 20, 0 turns it off). It keeps a song's lyrics only
until that song has played, so each play gets the latest sync.

## Limitations (Spotify's, not ours)

Spotify's February 2026 changes restrict development-mode apps:

- Up to 5 users per app, and the app owner needs Premium.
- Search returns at most 10 results per category.
- Track lists are only available for playlists you own or collaborate on. Other playlists can
  still be played.
- Browse categories, new releases, artist top tracks and recommendations are gone.

librespot is pinned to a `dev` branch commit that includes fixes for Spotify's 2026 CDN changes.
Spotify changes its private protocols from time to time, which can temporarily break playback
until librespot catches up.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Space | Play / pause |
| Ctrl + → / ← | Next / previous track |
| Ctrl + ↑ / ↓ | Volume up / down |
| Ctrl + L or Ctrl + K | Search |
| Alt + ← / → | Back / forward |

## License

GNU AGPL-3.0, because the lyrics renderer is derived from Spicy Lyrics (AGPL-3.0). See
[LICENSE](LICENSE).

## Project layout

```
src/                Svelte frontend
  lib/              stores (player, session, router), Web API wrappers
  components/       shell pieces: sidebar, now-playing deck, track list…
  views/            pages: home, search, album, artist, playlist, liked, lyrics…
  spicy-lyrics/     the vendored Spicy Lyrics renderer and its compatibility layer
src-tauri/src/
  auth.rs           PKCE browser sign-in with a loopback redirect
  webapi.rs         Web API client with token refresh and rate-limit handling
  device.rs         librespot Connect device and its supervisor
  lyrics.rs         Nativify lyrics service client and sign-in
  lib.rs            Tauri commands and app state
```
