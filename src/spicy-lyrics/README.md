# Spicy Lyrics renderer (vendored)

This directory contains the lyrics renderer from
[Spikerko/spicy-lyrics](https://github.com/Spikerko/spicy-lyrics), ported to run outside of the
Spotify desktop client.

- Upstream commit: `c22a9d7` (2026-09-26, version 6.3.98)
- License: GNU AGPL-3.0, Copyright (c) Spikerko and Spicy Lyrics contributors.
  Native Spotify as a whole is distributed under the same license (see `/LICENSE`).

The directory layout mirrors upstream (`src/…`, `project/config.ts`) so files can be diffed
against upstream directly.

## What's unchanged

The rendering core is copied verbatim: the syllable/line/static applyers, the spring-based lyrics
animator, the virtualizer, auto-scrolling, the Kawarp dynamic background, the stores and all
renderer CSS.

## What's replaced

Upstream runs inside Spotify and reads everything from the `Spicetify` global. These modules are
rewritten (same path and exports, new implementation) to run on Native Spotify's own player:

| Module | Replacement |
| --- | --- |
| `src/components/Global/SpotifyPlayer.ts` | Backed by Native Spotify's player store |
| `src/components/Pages/PageView.ts` | Builds the same page DOM inside the app's Lyrics view |
| `src/components/Utils/{Fullscreen,CompactMode,PopupLyrics}.ts` | Minimal state only; the app has no PiP/NPV card |
| `src/utils/Lyrics/fetchLyrics.ts` | Uses the public Spicy Lyrics API (`api.spicylyrics.org/v1`) through the Rust backend |
| `src/utils/Lyrics/ProcessLyrics.ts` | Empty-line pruning only (see below) |
| `src/utils/audioAnalysis.ts`, `src/components/DynamicBG/ArtistVisuals/Main.ts` | Disabled (relied on private Spotify endpoints) |

Every modified upstream file carries a `Modified for Native Spotify` note at the top describing
the change, as AGPL section 5(a) requires.

`compat/` holds a minimal `Spicetify` object (local storage, tooltips, link opening) so the
verbatim files that still touch it keep working.

## Not ported

- Romanization: upstream downloads and executes JavaScript packages (kuroshiro dictionaries,
  pinyin, aromanize) from a CDN at runtime. That isn't enabled here.
- The settings panel, lyrics manager, TTML uploader, NowBar, Now Playing View card and popup
  lyrics: they're React/Spotify UI and the app has its own equivalents.
