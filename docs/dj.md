# The AI DJ

The DJ is a radio host for your own music, in the spirit of Spotify's DJ. It plays sets of songs from your
listening and talks between them, and both the talking and the voice are made on your computer.

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
names the segment and writes what to say. It's only allowed to use those facts, not made-up trivia.

Songs the DJ played in the last three days aren't picked again at the start of a session. When you skip a DJ
song before halfway, that artist sits out the rest of the session.

The 2026 Web API has no recommendations, so the DJ plays only music you already listen to.

## How it talks

The DJ plays one set at a time. While a set plays, it prepares the next one: the model writes the line, and the
voice reads it into audio ahead of time. During a set's last song, the next set goes into Spotify's queue.

Between sets, the DJ's talk is an **item of its own**, as long as the line takes. The player bar shows it like a
song: the segment's name, "Your DJ", its own progress bar and length. Play/pause pauses the DJ (and any music
under it), and next skips the rest of what it's saying. The queue lists it before the set it introduces. Starting
the DJ fades out whatever was playing, so its greeting is an item of its own too.

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
Your volume and other Spotify apps see no change. The voice follows the volume slider, so it sits at the same
loudness as the music.

What it says shows up as captions: in the player bar where the current lyric line usually is, and over the
lyrics view. Each word lights up as it's spoken, the same way synced lyrics do. The DJ page keeps a list of
everything it said this session.

If the model is too slow or its answer isn't usable, the DJ picks the songs itself and talks from a template
("That was … Up next, …"). If the voice fails, it plays on without talking. The DJ page marks lines that came
from a template.

If you skip ahead into the next set before the DJ has introduced it, the DJ still talks first: the song waits at
its start and comes in where the rest of the line fits.

The DJ plays on this computer's built-in player. It stops when you play something else, or move the music to
another device. Songs it already added to Spotify's queue stay there; Spotify has no way to take them out.

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
The voice still runs on this computer.

## Privacy

The model and the voice run on your computer. Your listening, your instructions and what the DJ says never
leave it, except to a model server you set up yourself. The local model server listens on 127.0.0.1 only,
behind a random key, and is started with `--offline`.

## Platforms

Windows (x64, arm64), macOS (Apple silicon, Intel) and Linux (x64, arm64; glibc 2.34 or newer, as on Ubuntu
22.04). On other systems the DJ's switch is off and can't be turned on.
