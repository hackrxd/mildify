# Changelog

What changed in each Mildify release. A release's section becomes its GitHub release notes and the app's
What's new page. Add to **Unreleased** as you go; a release renames it to the new version and date.

## Unreleased

### Added

- "How much your DJ talks", in Settings → AI DJ: Brief, Normal or Chatty lines, or Just play, where the music plays
  straight through and what the DJ would say shows only as captions.
- "What your DJ calls you" and "Use my name", in Settings → AI DJ.
- "Speaking speed", in Settings → AI DJ: the DJ's voice can talk up to 20% slower or 30% faster.
- "Hear it", beside the DJ's voice in Settings, plays a short line in that voice at the speed set.
- Four more voices for the DJ: Nicole and Sky (American), Isabella and Lewis (British). Settings lists the voices by
  the package they download in, and asks before a voice that has to download first stops the DJ while it plays.
- Settings asks before a change that stops the DJ while it plays, switching its model or removing the key it uses,
  and before removing the DJ's files.
- Each of the DJ's songs can say why it's there: what your listening shows, and what the DJ looked up about it.
- Each set on the DJ page has a menu, from its "…" button or a right-click on its name: skip it, or copy its song
  list. Its "Skip this set" button shows only while the set can be skipped.
- Songs in the queue panel have the right-click menu songs have elsewhere, and the DJ's item there opens its set's
  menu.
- Your DJ remembers, on this computer and for each Spotify account, what it played and what you skipped and liked
  while it played. With a model on your computer or your own server, it also greets you some other way than it did
  lately. Settings → AI DJ can forget it.

### Changed

- Asking the DJ for a set understands short artist names like U2, decades in words ("the eighties") and single
  years, and "but" both ways: "no Drake, but Future", "Drake but also Future".
- Picking another voice for the DJ no longer stops the music: the set carries on, and the DJ switches to the new
  voice after any line it already has ready. Only a voice that still has to download ends the session.
- When the DJ's voice fails, what it would have said shows as captions while the music plays on.
- The DJ no longer calls you by a username from your Spotify account, and after its greeting it says your name only
  now and then.
- The DJ repeats itself less: each line starts a different way from the two before, and it remembers more of what it
  said.
- When the DJ talks from a template, it has a few for each moment and never uses the same one twice in a row. On Normal
  and Chatty, it says why the song is here.
- A cloud model that writes the DJ more than it asked for is cut to whole sentences, keeping the one that brings in
  the song.
- The DJ page says which model writes what the DJ says and which voice reads it out, whichever model you use.
- The DJ reads your top tracks 50 at a time, digs up different old likes each session, and doesn't read your
  listening again when it's started within half an hour of the last time.
- When you skip a DJ song, its artist sits out the next two sets, or the rest of the session once you've skipped them
  twice, instead of always the rest of the session. A song you skip stays out for three weeks. Asking for either by
  name brings it back.
- The DJ offers more of what you're likely to want: more by artists you liked while it played, less of what you
  skipped or it played lately.
- With "Pick songs as it goes" on, liking a song before a set's last one can run the set a song or two longer when
  there's more like it, and a set you asked for an artist in can play them back to back. Keeping an artist from
  playing twice running counts featured artists too.
- The DJ is in the sidebar while it's off too, so you can find it before turning it on. Its page's "Choose a model
  and voice" opens Settings at the AI DJ, which shows the model and voice to pick before anything downloads.
- When the DJ's model or voice fails in a way you can fix, the DJ page says so until it's fixed, with a button to the
  DJ's settings, instead of only in a notice that goes away.
- The DJ page's songs have their covers, artist links, a heart, and the right-click menu songs have elsewhere.
- The DJ's voice says numbers, symbols and some artists' names the way a host would: "#1" as "number one", 1999 as
  "nineteen ninety-nine", "the 90s" as "the nineties", "feat." as "featuring", and SZA, A$AP Rocky and P!nk as
  they're said. The captions still show them as they're written.

### Fixed

- The DJ's voice no longer stops mid-sentence after an initial or an abbreviation, as in J. Cole or Mr. Brightside,
  and its captions no longer break there.
- In Settings, buttons beside a setting sit side by side instead of stacked, and keep their words on one line.
- A song's menu opens when two of its artists share a name, or an extension adds an entry named like one of the
  app's own. An extension's entry that fails is left out, or says what went wrong, instead of breaking the menu.
- The DJ page no longer says turning the DJ on downloads "0 B" when its files are already there, or a language model
  when a cloud model or your own server writes what it says.
- With "Pick songs as it goes" on, the DJ introduces only a set's first song, even when it may name every song: the
  rest aren't picked yet. Settings says so, and keeps your choice for when it picks whole sets.
- The DJ's set starts with the song its line introduces, and a line the model left unfinished ends at its last
  whole sentence instead of mid-word.
- The DJ's Qwen3 4B model now downloads from a fixed version with a checked hash, like everything else it
  downloads, so a later change to the file can't slip in.
- Quote marks in what you tell the DJ, or ask it for, can no longer get mixed up with its own instructions.
- An extension you turn off can no longer add styles, pages or menu items back, or keep asking Spotify for things,
  from a timer it left running.
- When the DJ's model runs out of room or declines to answer, the DJ says so, instead of that it "didn't answer in
  JSON"; and an API key a provider repeats in an error is never shown in full.
- Quitting while the DJ's model is still loading no longer leaves it running in the background, and turning the DJ
  off or removing its files no longer waits for the model to finish loading.
- After you skip a set or ask for another, the DJ's model drops the set it was still working on, instead of making
  the new one wait behind it.
- The DJ talks to a model on your computer directly, even when your system sends web traffic through a proxy, and
  says plainly when a model server can't be reached or its model stopped.
- A busy or rate-limited model is asked once more after a short wait, before the DJ talks from a template; when the
  provider asks for a longer wait, the DJ says how long.
- When the DJ looks songs up before picking, every song gets Spotify's facts first, so a slow MusicBrainz no longer
  leaves the last songs with nothing.

## 1.3.0 - 2026-10-06

### Added

- The AI DJ can write its talk with a cloud model: OpenAI, Anthropic or Google Gemini, with your own API key, which
  is kept in your system's keychain. Pick the provider and model in Settings → AI DJ; the voice is still made on
  your computer.
- Before picking a set, the DJ can look songs up: their genres, release date and label, how popular they are, and
  the artist's story, from Spotify, and from MusicBrainz if you allow it. Cloud models and Qwen3 4B do this, and so
  can your own model server if you say its model supports it.
- "Let the DJ name every song in a set", in Settings → AI DJ.
- Ask the DJ for its next set in your own words ("something upbeat", "more Radiohead", "the 90s") on the DJ page,
  and skip the rest of a set you aren't feeling with "Skip this set".

### Changed

- The DJ doesn't greet you again with every set: after the opening it carries on the show ("next up…") and doesn't
  repeat what it said before.
- The DJ introduces only the first song of a set, instead of reading out the whole set list.
- The Linux AppImage needs glibc 2.39 or newer (Ubuntu 24.04, Debian 13, Fedora 40 and later). On older systems,
  install the .deb or .rpm instead.

### Fixed

- In the Linux AppImage, sung lyrics no longer shimmy: it now comes with a newer WebKitGTK (2.52).
- With "Pick songs as it goes" on, pressing Next or Previous several times quickly no longer runs past the DJ's set
  or stops the music, and Previous on a set's first song starts it again.

## 1.2.0 - 2026-10-04

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
