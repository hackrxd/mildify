# Changelog

What changed in each Mildify release. A release's section becomes its GitHub release notes and the app's
What's new page. Add to **Unreleased** as you go; a release renames it to the new version and date.

## Unreleased

### Added

- Updates that only change the interface install with a reload, and your music keeps playing. Updates that
  change the app itself still need a restart, and Mildify says beforehand that it will stop the music.
- A What's new page, in Settings → Updates and in a banner after an update.

## 1.1.1 - 2026-10-03

### Fixed

- Spotify's rate limits: requests are paced, and after a long rate limit Mildify waits it out, even across
  restarts, instead of extending it.
- Your profile loads once a rate limit at launch is over, instead of staying empty.
- The playing state is polled less often while Mildify is the playing device or the window is hidden.

## 1.1.0 - 2026-10-03

### Added

- Audio-responsive effects: the player bar's cover glow and the lyrics nowbar pulse with the music, kicks
  most of all. Turn them on, and set how strong they are, in Settings.

## 1.0.0 - 2026-10-03

### Added

- Native Spotify became Mildify: new name, window title, device name and sign-in pages.
- mild-lyrics support: Mildify can serve the Spotify app's debug port for mild-lyrics (off by default).
- Seven built-in colour themes, among them Midnight.
- The lyrics view's cover background can fill the whole window, optionally dimmed, and the theme's colours
  fade along with it.
- Motion throughout: pages, cards, track rows and playlists arrive in turn, and the playing track shows a
  bouncing equalizer.

### Changed

- Safe mode turns off Quick CSS too.
