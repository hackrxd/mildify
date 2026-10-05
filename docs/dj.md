# The AI DJ

The DJ is a radio host for your own music, in the spirit of Spotify's DJ. It plays sets of songs from your
listening and talks between them. The voice is always made on your computer, and so is the talking, unless you
have a cloud model write it ([Cloud models](#cloud-models)).

It's **off by default**, and nothing of it is installed with Mildify. Turning it on (Settings → AI DJ, or
the DJ page) downloads what it runs on, once. Turning it off stops a download and unloads the model; Settings
→ AI DJ → **Remove the DJ's files** deletes all of it.

## What it plays

The DJ reads your listening through the Spotify Web API, the same way the rest of the app does:

- your top tracks over the last few weeks, six months and all time,
- what you played recently,
- your liked songs: the newest, and two pages from further back.

From these it builds segments, the way Spotify's DJ does: **On repeat**, **Your favorites lately**,
**Throwbacks** (all-time favorites and songs you liked long ago), **Fresh in your library** and
**Rediscover** (liked songs you haven't played lately). Each segment offers the model up to 14 songs, with what's
true about each ("on repeat the last few weeks", "liked in March 2019", "explicit"). The model picks 3 to 5,
names the segment and writes what to say. It's only allowed to use those facts, and what it looked up
([Looking songs up](#looking-songs-up)), not made-up trivia.

Songs the DJ played in the last three days aren't picked again at the start of a session. When you skip a DJ
song before halfway, that artist sits out the rest of the session.

The 2026 Web API has no recommendations, so the DJ plays only music you already listen to.

### Picking as it goes

With **Pick songs as it goes** on (Settings → AI DJ, off by default), the DJ still plans each set, but it only
commits to one song at a time: while a song plays, it picks the next and lines it up in the player's queue. What
you do changes what comes next:

- **Like a song** (the heart in the player bar, or anywhere in the app) and the DJ leans toward it for the rest of
  the set: more by that artist, or from that album, even from outside the set. It can change the song it lined up until about 35
  seconds before the one playing ends, when the player starts loading it.
- **Skip a song** before halfway and that artist sits out. Skip two in a set and the DJ moves on to a new set.
- The next set is picked as the last song of a set starts, and the DJ knows what you liked and skipped since the
  last one, so it can mention it.
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
under it), and next skips the rest of what it's saying. The queue lists it before the set it introduces. Starting
the DJ fades out whatever was playing, so its greeting is an item of its own too.

The DJ says hello once, at the start. After that it talks like a host mid-show: it's told which set this is and
what it said before, so it carries on ("next up…") instead of welcoming you again, and doesn't repeat itself. It
introduces the set's first song and lets the rest play without reading out the list; **Let the DJ name every song
in a set** (Settings → AI DJ) lets it mention them all.

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
lyrics view. Each word lights up as it's spoken, the same way synced lyrics do. The DJ page keeps a list of
everything it said this session.

If the model is too slow or its answer isn't usable, the DJ picks the songs itself and talks from a template
("That was … Up next, …"). If the voice fails, it plays on without talking, and says why. The DJ page marks lines
that came from a template, and why. When the model fails in a way you can fix, such as a cloud provider refusing
your key or your account running out of credit, the DJ says so once and plays on from templates. Removing the key
the DJ is using stops it.

If you skip ahead into the next set before the DJ has introduced it, the DJ still talks first: the song waits at
its start and comes in where the rest of the line fits.

The DJ plays on this computer's built-in player. It stops when you play something else, or move the music to
another device. Songs it already added to Spotify's queue stay there; Spotify has no way to take them out.

## Asking for a set, and skipping one

While the DJ is on, **Ask for the next set** on the DJ page takes a request in your own words: "something
upbeat", "more Radiohead", "the 90s", "songs for a rainy evening". The DJ offers its model the songs from your
listening that the request names (by artist, album, title or decade) first, then a spread of the rest for it to
judge a mood or genre by, and the set it picks says it's your request. If the next set is already picked but not yet
introduced, the request takes its place; once its introduction has started, the request is the set after it. Never
mind takes a request back.

**Skip this set**, beside the set playing, moves on to the next set straight away: its introduction, then its
songs. If the next set isn't picked yet, the music waits up to 8 seconds for the model before the DJ talks from a
template. The model hears that you skipped the last set, so it goes somewhere else, and leaving the set doesn't
count as skipping the song that was playing.

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
about 1.3 GB with the defaults. Downloads resume where they stopped. Each one is checked before it's used: the
runtimes and voices against SHA-256 hashes pinned in the app (`src-tauri/src/dj/manifest.rs`), and the models
against the hash Hugging Face publishes for the file.

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
**Remove key** deletes it. Once a key is saved, Settings lists the models it can use, newest first.

What the DJ uses is billed to your account with the provider; each set is one or two short requests. Nothing is
downloaded for a cloud model, and the voice is still made on your computer. For Anthropic's newest models, the DJ
asks for a short think, and lets Anthropic hand a request its model declines to another model rather than fail.
If a request fails anyway, the DJ talks from a template and says why in the log.

## Privacy

With a downloaded model, the model and the voice run on your computer. Your listening, your instructions and what
the DJ says never leave it, except to a model server you set up yourself. The local model server listens on
127.0.0.1 only, behind a random key, and is started with `--offline`.

With a cloud model, what the DJ is asked goes to that provider: your first name, the songs it's choosing from
with when you played or liked them, what it looked up about them, what it said before, and your instructions.
Song look-ups ask Spotify, and MusicBrainz if you allow it.

## Platforms

Windows (x64, arm64), macOS (Apple silicon, Intel) and Linux (x64, arm64; glibc 2.34 or newer, as on Ubuntu
22.04). On other systems the DJ's switch is off and can't be turned on.
