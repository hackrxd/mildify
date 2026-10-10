# The AI DJ

The DJ is a radio host for your own music, in the spirit of Spotify's DJ. It plays sets of songs from your
listening and talks between them. The voice is always made on your computer, and so is the talking, unless you
have a cloud model write it ([Cloud models](#cloud-models)).

It's **off by default**, and nothing of it is installed with Mildify. Turning it on (Settings → AI DJ, or
the DJ page in the sidebar) downloads what it runs on, once. Before that, Settings → AI DJ lets you pick its
language model and voice, so only what you picked downloads. Turning it off stops a download and unloads the
model; Settings → AI DJ → **Remove the DJ's files** deletes all of it, once you've said so under the button.

Switching to another language model stops the DJ, so while it plays, Settings asks first, under the picker, which
shows the model it's asking about until you answer. A new voice doesn't stop it: the next line uses it. A voice
from a package that isn't downloaded yet does stop it, without asking first, while it downloads.

## What it plays

The DJ reads your listening through the Spotify Web API, the same way the rest of the app does:

- your top tracks over the last few weeks, six months and all time, 50 of each,
- what you played recently,
- your liked songs: the newest 50, and 50 from each half of the rest, from somewhere else each session.

That's six requests in all. What it read serves a session started within half an hour, so stopping and starting
the DJ doesn't read it again. If Spotify refuses 50 top tracks at a time, as it may for a development-mode app, the
DJ reads them in pages of 20 instead.

From these it builds segments, the way Spotify's DJ does: **On repeat**, **Your favorites lately**,
**Throwbacks** (all-time favorites and songs you liked long ago), **Fresh in your library** and
**Rediscover** (liked songs you haven't played lately). Each segment offers the model up to 14 songs, with what's
true about each ("on repeat the last few weeks", "liked in March 2019", "explicit"). The model picks 3 to 5,
names the segment and writes what to say. It's only allowed to use those facts, and what it looked up
([Looking songs up](#looking-songs-up)), not made-up trivia.

Songs the DJ played in the last three days aren't picked again at the start of a session. When you skip a DJ
song before halfway, that artist sits out the rest of the session.

The 2026 Web API has no recommendations, so the DJ plays only music you already listen to.

The DJ page lists each set's songs with their covers, which go to the album, and their artists. A song's heart
likes it, as anywhere in the app, and right-clicking it gives the menu songs have everywhere, apart from **Add to
queue**: a song queued there would play in the middle of the DJ's set.

A song's info button says why it's there: what your listening shows (on repeat lately, one of your most played,
when you last played or liked it) and, for a song the model looked up, its genres, when and where it came out, how
well known it is, what it's sung in, artists like it, and a few lines about the artist. A set from a template keeps
what was looked up before the model gave out.

### Picking as it goes

With **Pick songs as it goes** on (Settings → AI DJ, off by default), the DJ still plans each set, but it only
commits to one song at a time: while a song plays, it picks the next and lines it up in the player's queue. What
you do changes what comes next:

- **Like a song** (the heart in the player bar, or anywhere in the app) and the DJ leans toward it for the rest of
  the set: more by that artist, or from that album, even from outside the set. It can change the song it lined up until about 35
  seconds before the one playing ends, when the player starts loading it.
- **Skip a song** before halfway and that artist sits out. Skip two in a set and the DJ moves on to a new set.
- The next set is picked as the last song of a set starts, and the DJ knows what you liked and skipped since the
  last one, so it can mention it. It introduces only the set's first song, even with **Let the DJ name every song in
  a set** on: the rest aren't picked yet.
- **Previous** goes back to the set's song before, as it would in an album, and that doesn't count as a skip. On a
  set's first song, it starts the song again.

The DJ takes over the queue while it plays this way: songs you queue yourself are replaced by its next pick. If you
skip a set's last song before the next set is ready, the music waits and the DJ starts it as soon as it can,
talking from a template if the model is still working. When the DJ stops, or you play something else, the song it
lined up comes out of the queue again.

### Looking songs up

Models that can call tools look songs up before they pick: the cloud models, Qwen3 4B, and your own model server
if you turn on **Its model can look things up**. The model is shown the songs on offer and asks about up to five
of them; then it picks, knowing what it found. For each song it can learn:

- from Spotify: when it came out and on what label, the album, how popular it is, the languages it's sung in, and
  the artist's biography, active years and similar artists (read through the built-in player, so these need it
  running), plus the artist's genres from the Web API,
- from [MusicBrainz](https://musicbrainz.org), with **Look up genres on MusicBrainz** on (Settings → AI DJ, on by
  default): the song's genres and tags. The song's title, artist and ISRC code go to musicbrainz.org, at most one
  request a second, as MusicBrainz asks.

What's found is kept for a month, so a song is looked up once. If a look-up fails or takes too long, the DJ picks
without it. Qwen2.5 1.5B doesn't look songs up: it picks from what it's given.

## How it talks

The DJ plays one set at a time. While a set plays, it prepares the next one: the model writes the line, and the
voice reads it into audio ahead of time. During a set's last song, the next set goes into Spotify's queue.

Between sets, the DJ's talk is an **item of its own**, as long as the line takes. The player bar shows it like a
song: the segment's name, "Your DJ", its own progress bar and length. Play/pause pauses the DJ (and any music
under it), and next skips the rest of what it's saying. The queue lists it before the set it introduces, and a
right-click on it there opens that set's menu. Starting the DJ fades out whatever was playing, so its greeting is
an item of its own too.

The DJ says hello once, at the start. After that it talks like a host mid-show: it's told which set this is and
what it said lately, so it carries on instead of welcoming you again, and doesn't repeat itself. A model on your
computer is reminded of its last three lines, a cloud model of its last six and how they started. Each line leads
a different way from the two before: why the song is here, what ties the set together, how it follows the song
that's ending, the time of day, or your request.

It introduces the set's first song and lets the rest play without reading out the list; **Let the DJ name every
song in a set** (Settings → AI DJ) lets it mention them all, unless it picks songs as it goes. The set starts with
the song its line brings in, whatever order the model gave, and a line the model left unfinished ends at its last
whole sentence.

**How much your DJ talks** (Settings → AI DJ) sets how long its lines are: **Brief** is a sentence or two,
**Normal** (the default) up to three, and **Chatty** up to four. A line that runs well past that is cut to whole
sentences, keeping the one that brings in the song. With **Just play** the DJ has no voice: the music plays straight through
from song to song, and what it would have said shows as captions for about as long as it would take to say. A change
applies from its next set.

The DJ greets you by the first name on your Spotify account, when it looks like a name rather than a username, or by
what you put under **What your DJ calls you** (Settings → AI DJ). After the opening it says your name only now and
then: every fourth set on Normal and Chatty, and never again on Brief or Just play. With **Use my name** off, it
never does.

At its edges, the DJ's item can overlap the songs. It times this with the songs' **lyrics**: a synced lyric's
first line is where the next song's singer comes in, and its last line is where the finishing song's singer stops.
If you've nudged a song's lyric timing in the lyrics view, the DJ goes by that too.

- **Allow DJ to talk over beginning of track** (Settings → AI DJ, on by default): the next song comes in under the
  last few seconds of the talk (at most 5, and at most half of it), so the DJ is done before the first sung line.
  When the song's intro is too short for that (under about 2 seconds), or its lyrics aren't synced, the song starts
  after the DJ. Off, songs always start once the DJ is done.
- **Allow DJ to talk over end of track** (on by default): the DJ starts over the last few seconds of the finishing
  song (at most 5), once nobody is singing. Without a synced lyric, it assumes the last 3 seconds are free. With
  less than about 1.5 seconds free, it waits for the song to finish, as it does with this off.

Whatever doesn't fit over the songs, the DJ says on its own: the finishing song plays to its end and the music goes
quiet right there, and the next song waits at its start until its time in the line. It never talks over anyone
singing.

While it talks over music, the music is turned down inside the player's own output, not with the volume slider.
Your volume and other Spotify apps see no change. The voice plays on this computer's sound output, as the music
does, and follows the volume slider, so it sits at the same loudness as the music.

What it says shows up as captions: in the player bar where the current lyric line usually is, and over the
lyrics view. Each word lights up as it's spoken (without a voice, at about the pace it would be), the same way synced
lyrics do. The DJ page keeps a list of everything it said this session.

If the model is too slow or its answer isn't usable, the DJ picks the songs itself and talks from a template. It
has a few for each moment (the opening, after a set, after a set you skipped, your request, a song you liked), never
uses the same one twice in a row, and on Normal and Chatty says why the first song is here. If the voice fails, it
plays on without talking, shows what it would have said as captions, and says why. The DJ page marks lines that came
from a template, and why. When the model fails in a way you can fix, such as a cloud provider refusing your key or
your account running out of credit, the DJ says so once and plays on from templates. Removing the key the DJ is
using stops it.

The DJ page keeps saying what's wrong with the model or the voice until it's fixed, with a button to the DJ's
settings, and through stopping and starting again. The model's note goes once the model answers again, or after you
change its model, server or key; the voice's once a line plays through, or after you pick another voice. A change
that doesn't fix it is told again.

If you skip ahead into the next set before the DJ has introduced it, the DJ still talks first: the song waits at
its start and comes in where the rest of the line fits.

The DJ plays on this computer's built-in player. It stops when you play something else, or move the music to
another device. Songs it already added to Spotify's queue stay there; Spotify has no way to take them out.

## Asking for a set, and skipping one

While the DJ is on, **Ask for the next set** on the DJ page takes a request in your own words: "something
upbeat", "more Radiohead", "the 90s", "songs for a rainy evening". The DJ offers its model the songs from your
listening that the request names (by artist, album, title, decade or year: "U2", "the eighties", "2012") first, then a spread of the rest for it to
judge a mood or genre by, and the set it picks says it's your request. If the next set is already picked but not yet
introduced, the request takes its place; once its introduction has started, the request is the set after it. Never
mind takes a request back.

Things a request says to leave out stay out: "anything but Drake", "no more 80s", "no Drake, but Future". A "but"
can turn the other way too: "Drake but also Future", "nothing but Radiohead". When the
model doesn't answer, the DJ plays only songs the request names, and if there aren't enough of those it plays an
ordinary set while your request waits for the next one.

**Skip this set**, beside the set playing, stops the music and has the model pick the next set again, from the song
you skipped: it hears that you skipped the set, so it goes somewhere else. The music waits up to 8 seconds for it
before the DJ talks from a template. A next set whose introduction has already started plays as it is. Leaving the
set doesn't count as skipping the song that was playing. The button shows only while the set can be skipped: not
while the DJ talks or brings the next set in, nor while the music plays on another device.

Each set's **…** button, or a right-click on its name, opens its menu: **Skip this set** for the set playing, and
**Copy the song list**, which copies the set's name and its songs, numbered, to paste anywhere.

## Telling it what to do

Under **Tell your DJ** (on the DJ page and in Settings) you can write instructions, up to 1000 characters. It
reads them every time it plans a set. For example:

```
Talk like a late-night radio host. Keep it short.
No explicit songs.
Mention the year a song came out.
Call me Captain.
```

Instructions can change how it talks and which of the offered songs it picks, but not where its songs come
from. The voices speak English, so a DJ told to speak another language will read it with an English accent.

## What it downloads

Everything comes from the projects' own releases and goes in a `dj` folder in the app's data directory
(`~/.local/share/dev.hackrxd.nativespotify/dj` on Linux, `~/Library/Application Support/dev.hackrxd.nativespotify/dj`
on macOS, `%APPDATA%\dev.hackrxd.nativespotify\dj` on Windows).

| Part | From | Size | License |
| --- | --- | --- | --- |
| Language model runtime | [llama.cpp](https://github.com/ggml-org/llama.cpp) b11382, CPU build (Metal on Apple silicon) | 12–19 MB | MIT |
| Speech runtime | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) v1.13.8 | 20–44 MB | Apache-2.0 |
| Model: Qwen2.5 1.5B Instruct (default) | [Qwen on Hugging Face](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF), Q4_K_M | 1.1 GB | Apache-2.0 |
| Model: Qwen3 4B | [Qwen on Hugging Face](https://huggingface.co/Qwen/Qwen3-4B-GGUF), Q4_K_M | 2.5 GB | Apache-2.0 |
| Voices: Kokoro (default) | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), via sherpa-onnx's release | 103 MB | Apache-2.0 |
| Voices: Light | [KittenTTS](https://github.com/KittenML/KittenTTS) nano, via sherpa-onnx's release | 27 MB | Apache-2.0 |

Only the parts your settings need are downloaded: the two runtimes, one model and one voice package. That's
about 1.3 GB with the defaults. Downloads resume where they stopped. Each one is checked before it's used, against
a SHA-256 hash pinned in the app (`src-tauri/src/dj/manifest.rs`); the models come from a fixed commit of their
Hugging Face repository, so a file changed there later is never picked up.

The Qwen2.5 model needs about 2 GB of memory while the DJ is on, and Qwen3 4B about 4 GB. The model is unloaded
when you stop the DJ, or after 10 minutes without use.

## Your own model server

If you already run a local model server, pick **Your own model server** under Settings → AI DJ → Language model.
Enter its address and model name; nothing is downloaded for the model then. Anything with an OpenAI-style
`/v1/chat/completions` API works:

| Server | Address | Model name |
| --- | --- | --- |
| [Ollama](https://ollama.com) | `http://127.0.0.1:11434` | e.g. `llama3.2`, `qwen2.5:7b` |
| [LM Studio](https://lmstudio.ai) | `http://127.0.0.1:1234` | as LM Studio lists it |
| llama.cpp's `llama-server` | `http://127.0.0.1:8080` | anything |

The DJ asks for JSON that fits a schema. A server that ignores that still works if the model answers in JSON.
The voice still runs on this computer. If the model supports tool calls, turn on **Its model can look things up**
so it can look songs up before picking.

## Cloud models

Under Settings → AI DJ → Language model you can pick **OpenAI**, **Anthropic** or **Google Gemini** instead.
They usually write better than the downloaded models. You need your own API key from that provider:

| Provider | Where to get a key | Models |
| --- | --- | --- |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | the chat models your key can use |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Claude models; Claude Opus 5.5 until you pick another |
| Google Gemini | [aistudio.google.com](https://aistudio.google.com/apikey) | Gemini models |

Paste the key and press Save. It's kept in your system's keychain (macOS Keychain, Windows Credential Manager, or
the Secret Service on Linux, such as GNOME Keyring or KWallet). Where there's no keychain, it's kept in a file in
the app's data folder that only you can read. The key is sent only to its provider, never shown again, and
**Remove key** deletes it, asking first when the DJ is playing with it, since that stops it. Once a key is saved,
Settings lists the models it can use, newest first.

What the DJ uses is billed to your account with the provider; each set is one or two short requests. Nothing is
downloaded for a cloud model, and the voice is still made on your computer. For Anthropic's newest models, the DJ
asks for a short think, and lets Anthropic hand a request its model declines to another model rather than fail.
If a request fails anyway, the DJ talks from a template and says why in the log.

## Privacy

With a downloaded model, the model and the voice run on your computer. Your listening, your instructions and what
the DJ says never leave it, except to a model server you set up yourself. The local model server listens on
127.0.0.1 only, behind a random key, and is started with `--offline`. The app talks to it, and to a model server of
your own on this computer, directly, never through a proxy set for your system.

With a cloud model, what the DJ is asked goes to that provider: the name it calls you (none with **Use my name**
off), the songs it's choosing from with when you played or liked them, what it looked up about them, what it said
before in this session, and your instructions.
Song look-ups ask Spotify, and MusicBrainz if you allow it.

### What it remembers

The DJ remembers, from one session to the next:
- what it played, for a month;
- what you skipped and liked while it played, for up to a year, fading as it goes;
- how its sets went, for two months;
- how it opened lately.

It's kept in the app's own storage on this computer, at most 128 KB, and never sent anywhere. A model on your
computer or your own server is told how the DJ opened lately, so it greets you some other way. A cloud model is
told nothing from earlier sessions. Settings → AI DJ → **What your DJ remembers** → **Forget it** clears it all.
Removing the DJ's files doesn't.

## Platforms

Windows (x64, arm64), macOS (Apple silicon, Intel) and Linux (x64, arm64; glibc 2.34 or newer, as on Ubuntu
22.04). On other systems the DJ's switch is off and can't be turned on.
