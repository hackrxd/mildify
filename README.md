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
- Windows: Visual Studio Build Tools with the C++ workload, and the Windows 11 SDK.
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

To build an installer: `npm run tauri build`.

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

## Project layout

```
src/                Svelte frontend
  lib/              stores (player, session, router), Web API wrappers
  components/       shell pieces: sidebar, now-playing deck, track list…
  views/            pages: home, search, album, artist, playlist, liked…
src-tauri/src/
  auth.rs           PKCE browser sign-in with a loopback redirect
  webapi.rs         Web API client with token refresh and rate-limit handling
  device.rs         librespot Connect device and its supervisor
  lib.rs            Tauri commands and app state
```
