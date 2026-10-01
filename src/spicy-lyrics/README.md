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

Small edits to otherwise verbatim files:

| File | Change |
| --- | --- |
| `src/utils/Lyrics/Global/Applyer.ts` | Notices for "sign in to the lyrics server" and "lyrics aren't set up"; the footer linking upstream's Discord is removed (it's upstream's support channel, not this port's) |
| `src/utils/Lyrics/Applyer/Credits/ApplyIsByCommunity.tsx` | Uploader/maker links use the profile `url` from the public API, as its attribution terms require |

Additions: `src/components/Pages/PageState.ts` holds the page element outside an import cycle.
Upstream's esbuild bundle rewrites top-level `let` to `var`, which hides a temporal-dead-zone
read; native ES modules (Vite) don't, so the binding lives in a module with no imports.

Every modified upstream file carries a `Modified for Native Spotify` note at the top describing
the change, as AGPL section 5(a) requires.

`compat/` holds a minimal `Spicetify` object (local storage, tooltips, link opening) so the
verbatim files that still touch it keep working, the host bridge the app implements, and
`fonts.css`.

## Fonts

Upstream loads its typeface from `fonts.spikerko.org`, which only allows Spotify's origin. Rather
than work around that, `compat/fonts.css` registers [Inter](https://rsms.me/inter/) (SIL OFL 1.1)
under the same `SpicyLyrics` family name, and upstream's `LoadFonts()` isn't called.

## Trying it without the app

`/lyrics-harness.html` (with `npm run dev`) mounts the renderer with a simulated clock and a
handwritten sample sync, so the port can be checked in a browser without Tauri or an API key.

## Not ported

- Romanization: upstream downloads and executes JavaScript packages (kuroshiro dictionaries,
  pinyin, aromanize) from a CDN at runtime. That isn't enabled here.
- The settings panel, lyrics manager, TTML uploader, Now Playing View card and popup lyrics:
  they're React/Spotify UI and the app has its own equivalents.
- The NowBar's playback controls, timeline and artist/album hover cards. The NowBar itself
  (cover art, title, artists, left/right placement) is kept with a simplified updater; playback is
  controlled from the app's own player bar.
