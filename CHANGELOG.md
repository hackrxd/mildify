# Changelog

What changed in each Mildify release. A release's section becomes its GitHub release notes and the app's
What's new page. Add to **Unreleased** as you go; a release renames it to the new version and date.

## Unreleased

### Added

- An AI DJ, off until you turn it on in Settings → AI DJ. It plays sets from your top tracks, recent plays and
  liked songs, and talks between them like a radio host, with a language model and voice that run on your
  computer. Turning it on downloads them once (about 1.3 GB); nothing is downloaded before, and Settings can
  remove it all again. Its talk plays like a song of its own between sets, with its own progress, pause and skip,
  and can start over the end of a song and run into the beginning of the next. It uses the songs' lyrics to
  never talk over the singing. Settings can keep it off either song. It turns the music down while it talks,
  and shows what it says as captions in the player bar and the lyrics view. Its page has an on-air light and moves
  with the show: the next set glides up as it starts, and a highlight follows the song playing. Turn on "Pick songs
  as it goes" and it picks each next song while one plays, so liking a song brings more like it and skipping moves
  it on. Tell it how to talk and what to play under "Tell your DJ", or point it at a model server you already run,
  like Ollama or LM Studio.

## 1.1.4 - 2026-10-04

### Added

- A Midnight (Dark) theme: Midnight with deeper blue-black panels.

### Changed

- The theme colour variables have names that say what they colour: `--bg`, `--surface`, `--surface-raised`,
  `--border`, `--text`, `--text-muted`, `--highlight` and `--on-highlight`. Themes using the old names still work;
  extensions that read them should switch.

## 1.1.3 - 2026-10-04

### Fixed

- Banners (an update ready, What's new, signing in for playback) can be clicked again on Home and on album, artist
  and playlist pages, whose headers covered them.

## 1.1.2 - 2026-10-04

### Added

- From the next update on, updates that only change the interface install with a reload, and your music keeps
  playing. Updates that change the app itself still need a restart, and Mildify says beforehand that it will stop
  the music.
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
