// The AI DJ: plays sets of songs from the user's own listening and talks between them, in a voice made on
// this computer. The backend (src-tauri/src/dj/) downloads and runs the model and voice; this side picks
// the songs (djPicks.ts), plans the talk around the songs' lyrics (djTiming.ts) and plays it all.
//
// A session plays one set at a time. The first starts after the DJ's greeting; each next one is prepared
// while the current one plays and queued during its last song, so the music carries on without a gap.
// The DJ starts talking over the end of that last song once its singer has finished, the music turned
// down in the player's own output, and the next set's first song comes in under the voice. When the line
// is too long for that, the next song waits until the DJ is nearly done, so it never talks over vocals.

import { listen } from "@tauri-apps/api/event";
import {
  buildPool,
  choicesFor,
  fallbackPick,
  INSTRUCTIONS_MAX,
  nextSegment,
  readAnswer,
  segmentMessages,
  segmentSchema,
  type Candidate,
  type Listening,
  type Pick,
  type SegmentId,
} from "./djPicks";
import { captionLines, DUCK_DOWN_MS, DUCK_LEVEL, DUCK_UP_MS, planTalk, vocals, volumeGain, type Vocals } from "./djTiming";
import { backend, type DjConfig, type DjInstall, type DjStatus } from "./ipc";
import type { LyricLine } from "./lyricLines";
import { player } from "./player.svelte";
import { session } from "./session.svelte";
import * as sp from "./spotify";
import { toasts } from "./toasts.svelte";
import type { Paging, PlayHistory, SavedTrack, Track } from "./types";
import { idFromUri } from "./util";

const INSTRUCTIONS_KEY = "nativify:djInstructions";
const PLAYED_KEY = "nativify:djPlayed";
/** Songs the DJ played this recently aren't picked again in a new session. */
const PLAYED_MEMORY_MS = 3 * 24 * 60 * 60 * 1000;
const PLAYED_KEPT = 400;
/** Waiting longer than this for the model, the DJ talks from a template instead. */
export const MODEL_TIMEOUT_MS = 90_000;
/** The first answer may have to wait for the model to load. */
export const OPENING_TIMEOUT_MS = 150_000;
/** Roughly how long a play request takes to be heard. */
export const PLAY_LATENCY_MS = 900;
/** A finishing song that has to wait is paused this far before its end, before the next one is decoded. */
export const HOLD_EARLY_MS = 700;
/** With this little of a set's last song left and nothing ready, the DJ stops waiting for the model. */
export const RUSH_MS = 30_000;
export const TICK_MS = 200;
/** A DJ song left before this share of it played counts as skipped. */
const SKIP_SHARE = 0.5;
/** Something the DJ didn't pick playing this long means the listener moved on. */
export const FOREIGN_MS = 2500;
/** A set asked for this long ago that still hasn't started isn't going to. */
export const START_TIMEOUT_MS = 15_000;

export interface Spoken {
  id: number;
  durationMs: number;
  lines: LyricLine[];
  buffer: AudioBuffer;
}

export interface DjSet {
  segment: SegmentId;
  name: string;
  songs: Candidate[];
  talk: string;
  /** Written by the model, or from a template. */
  byModel: boolean;
  /** The talk, read aloud; null when the voice failed and the DJ plays on without it. */
  speech: Spoken | null;
  /** The first song's vocals, for timing the talk. */
  firstVocals: Vocals | null;
}

function load<T>(key: string, fallback: T, read: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : read(raw);
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applies for this session.
  }
}

/** Songs the DJ played lately, by URI, so a new session doesn't start with the same ones. */
function playedLately(now = Date.now()): Map<string, number> {
  const raw = load<unknown>(PLAYED_KEY, {}, JSON.parse);
  const out = new Map<string, number>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [uri, at] of Object.entries(raw)) {
      if (typeof at === "number" && now - at < PLAYED_MEMORY_MS) out.set(uri, at);
    }
  }
  return out;
}

function rememberPlayed(uri: string, now = Date.now()) {
  const played = playedLately(now);
  played.delete(uri);
  played.set(uri, now);
  const kept = [...played].slice(-PLAYED_KEPT);
  persist(PLAYED_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** Everything the DJ reads about the user's listening. Each part is optional; all failing is an error. */
export async function loadListening(): Promise<Listening> {
  const range = async (r: sp.TimeRange) => {
    const pages = await Promise.allSettled([sp.topTracksIn(r, 0), sp.topTracksIn(r, 20)]);
    const ok = pages.filter((p) => p.status === "fulfilled").map((p) => (p as PromiseFulfilledResult<Paging<Track>>).value);
    if (!ok.length) throw (pages[0] as PromiseRejectedResult).reason;
    return ok.flatMap((p) => p.items);
  };
  const liked = async () => {
    const first = await sp.savedTracks(0);
    const items = [...first.items];
    // The newest likes, and two pages from further back for throwbacks.
    if (first.total > 100) {
      const older = [0.4, 0.8].map((f) => Math.floor((f * (first.total - 50)) / 50) * 50).filter((o) => o >= 50);
      const pages = await Promise.allSettled([...new Set(older)].map((o) => sp.savedTracks(o)));
      for (const p of pages) if (p.status === "fulfilled") items.push(...(p.value as Paging<SavedTrack>).items);
    }
    return items;
  };
  const recent = async () => (await sp.recentlyPlayed()).items;
  const parts = await Promise.allSettled([range("short_term"), range("medium_term"), range("long_term"), recent(), liked()]);
  if (parts.every((p) => p.status === "rejected")) throw (parts[0] as PromiseRejectedResult).reason;
  const [short, medium, long, played, saved] = parts.map((p) => (p.status === "fulfilled" ? p.value : []));
  return {
    topShort: short as Track[],
    topMedium: medium as Track[],
    topLong: long as Track[],
    recent: played as PlayHistory[],
    saved: saved as SavedTrack[],
  };
}

async function songVocals(uri: string): Promise<Vocals | null> {
  try {
    return vocals(await backend.lyrics(idFromUri(uri)));
  } catch {
    return null;
  }
}

/** Plays the DJ's lines through the window's audio, at the music's volume. */
export class Voice {
  #ctx: AudioContext | null = null;
  #source: AudioBufferSourceNode | null = null;
  #gain: GainNode | null = null;
  #startedAt = 0;

  /** Call from a click: the window only lets audio start from one. */
  ensure(): AudioContext | null {
    if (!this.#ctx && typeof AudioContext !== "undefined") this.#ctx = new AudioContext();
    this.#ctx?.resume().catch(() => {});
    return this.#ctx;
  }

  decode(wav: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensure();
    if (!ctx) return Promise.reject(new Error("This window can't play audio"));
    return ctx.decodeAudioData(wav);
  }

  play(buffer: AudioBuffer, gain: number, onEnd: () => void) {
    const ctx = this.ensure();
    if (!ctx) return onEnd();
    this.stop();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    this.#gain = ctx.createGain();
    this.#gain.gain.value = gain;
    source.connect(this.#gain).connect(ctx.destination);
    source.onended = () => {
      if (this.#source === source) this.#source = null;
      onEnd();
    };
    this.#source = source;
    this.#startedAt = ctx.currentTime;
    source.start();
  }

  setGain(gain: number) {
    if (this.#gain) this.#gain.gain.value = gain;
  }

  /** ms into the line playing now. */
  now(): number {
    return this.#ctx && this.#source ? (this.#ctx.currentTime - this.#startedAt) * 1000 : 0;
  }

  stop() {
    const source = this.#source;
    this.#source = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
  }
}

/** Something to do when the finishing song reaches a position. */
interface Cue {
  at: number;
  fire: () => void;
  fired: boolean;
  armed: boolean;
}

class Dj {
  /** The backend's view: settings, downloads, disk use. */
  status = $state<DjStatus | null>(null);
  /** The listener's own instructions for the DJ. */
  instructions = $state(load(INSTRUCTIONS_KEY, "", (raw) => raw.slice(0, INSTRUCTIONS_MAX)));
  phase = $state<"off" | "starting" | "on">("off");
  /** What the DJ is busy with, for the DJ page. */
  activity = $state<string | null>(null);
  /** The set playing now. */
  current = $state.raw<DjSet | null>(null);
  /** The set after it, once it's picked. */
  upNext = $state.raw<DjSet | null>(null);
  /** What the DJ has said this session, oldest first. */
  said = $state.raw<{ name: string; talk: string; byModel: boolean }[]>([]);
  speaking = $state(false);
  /** The line being spoken, as lyric lines timed from its start. */
  caption = $state.raw<LyricLine[] | null>(null);

  enabled = $derived(!!this.status?.settings.enabled);
  ready = $derived(!!this.status?.settings.enabled && !!this.status?.ready);

  #voice = new Voice();
  #run = 0;
  #ticker: ReturnType<typeof setInterval> | undefined;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #pool: Candidate[] = [];
  #segments: SegmentId[] = [];
  #played = new Set<string>();
  #skippedArtists = new Set<string>();
  #preparing: Promise<void> | null = null;
  #rush: (() => void) | null = null;
  #queued: "no" | "pending" | "done" | "failed" = "no";
  #cues: Cue[] = [];
  /** The song a transition was planned on. */
  #plannedOn: string | null = null;
  #lastVocals: Vocals | null = null;
  #lastUri: string | null = null;
  #lastPos = 0;
  #lastDuration = 0;
  #foreignSince: number | null = null;
  #remoteSince: number | null = null;
  /** A set started with a play request, whose first song hasn't come up yet. */
  #awaiting: DjSet | null = null;
  /** The finishing song is paused, waiting for the next set. */
  #holding = false;
  #ducked = false;
  #outOfSongs = false;
  /** The set whose talk the DJ has given. */
  #announced: DjSet | null = null;

  constructor(voice?: Voice) {
    if (voice) this.#voice = voice;
  }

  async init() {
    await listen<DjInstall>("dj-progress", (e) => {
      const was = this.status?.install.component;
      if (this.status) this.status = { ...this.status, install: e.payload };
      // On to the next download: the one before it is in, so what's left changed.
      if (e.payload.component !== was) this.refresh();
    });
    await listen("dj-installed", () => this.refresh());
    // A reload in the middle of a line mustn't leave the music turned down.
    backend.djDuck(1, 0, 0).catch(() => {});
    await this.refresh();
  }

  async refresh() {
    try {
      this.status = await backend.djStatus();
    } catch (e) {
      console.warn("DJ status:", e);
    }
  }

  async configure(patch: Partial<DjConfig>) {
    if (patch.enabled === false || patch.model !== undefined || patch.voice !== undefined) this.stop();
    try {
      this.status = await backend.djConfigure(patch);
    } catch (e) {
      toasts.error(e);
    }
  }

  setEnabled(on: boolean) {
    return this.configure({ enabled: on });
  }

  async retry() {
    try {
      await backend.djInstall();
    } catch (e) {
      toasts.error(e);
    }
    await this.refresh();
  }

  async cancelDownload() {
    await backend.djCancel().catch(() => {});
    await this.refresh();
  }

  /** Turns the DJ off and deletes everything it downloaded. */
  async remove() {
    this.stop();
    try {
      this.status = await backend.djRemove();
      toasts.show("The DJ's files are deleted");
    } catch (e) {
      toasts.error(e);
      await this.refresh();
    }
  }

  setInstructions(text: string) {
    this.instructions = text.slice(0, INSTRUCTIONS_MAX);
    persist(INSTRUCTIONS_KEY, this.instructions.trim() ? this.instructions : null);
  }

  /** ms into the line the DJ is speaking, per frame, for captions. */
  speechNow(): number {
    return this.#voice.now();
  }

  /** Starts a session. Call from a click, so the DJ's voice is allowed to play. */
  async start() {
    if (this.phase !== "off") return;
    if (!this.ready) {
      toasts.show("The DJ isn't ready yet. Turn it on in Settings, and let it finish downloading.");
      return;
    }
    if (!session.deviceReady || !session.device) {
      toasts.show("The DJ plays on this computer, and its player isn't running. Check the built-in player in Settings.", "error");
      return;
    }
    this.#voice.ensure();
    const run = ++this.#run;
    this.phase = "starting";
    this.said = [];
    this.current = null;
    this.upNext = null;
    this.#segments = [];
    this.#skippedArtists = new Set();
    this.#outOfSongs = false;
    this.#announced = null;
    this.activity = "Looking through your listening…";
    backend.djWarm().catch(() => {});
    // The DJ plays here; music on another device would play on under its voice.
    if (player.isPlaying && !player.isLocal) player.togglePlay();
    try {
      this.#pool = buildPool(await loadListening());
      if (run !== this.#run) return;
      this.#played = new Set(playedLately().keys());
      this.activity = "Picking your first songs…";
      const first = await this.#prepare(run, null, OPENING_TIMEOUT_MS);
      if (run !== this.#run) return;
      if (!first) {
        throw new Error("There isn't enough in your listening for the DJ yet. Play and like some songs, then try again.");
      }
      this.phase = "on";
      this.activity = null;
      this.#lastUri = player.track?.uri ?? null;
      this.#ticker = setInterval(() => this.#tick(run), TICK_MS);
      await this.#playSet(run, first);
    } catch (e) {
      if (run === this.#run) {
        toasts.error(e);
        this.stop();
      }
    }
  }

  /** Ends the session. The song playing carries on. */
  stop() {
    if (this.phase === "off") return;
    this.#run++;
    clearInterval(this.#ticker);
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#voice.stop();
    this.#unduck();
    if (this.#holding) backend.device({ action: "play" }).catch(() => {});
    this.phase = "off";
    this.activity = null;
    this.speaking = false;
    this.caption = null;
    this.current = null;
    this.upNext = null;
    this.#preparing = null;
    this.#rush = null;
    this.#queued = "no";
    this.#cues = [];
    this.#plannedOn = null;
    this.#awaiting = null;
    this.#holding = false;
    this.#announced = null;
    this.#foreignSince = null;
    this.#remoteSince = null;
    backend.djRelease().catch(() => {});
  }

  #after(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, Math.max(0, ms));
    this.#timers.add(t);
  }

  /** Picks a set, asks the model for its talk (or uses a template), and reads it aloud. */
  async #prepare(run: number, previous: Candidate | null, timeoutMs: number): Promise<DjSet | null> {
    const avoid = { played: this.#played, skippedArtists: this.#skippedArtists };
    let segment = nextSegment(this.#segments, this.#pool, avoid);
    if (!segment && this.#played.size) {
      // Everything's been played: start over, leaving out only what's playing now.
      this.#played = new Set(this.current?.songs.map((s) => s.uri) ?? []);
      segment = nextSegment(this.#segments, this.#pool, { ...avoid, played: this.#played });
    }
    if (!segment) return null;
    const choices = choicesFor(segment, this.#pool, { played: this.#played, skippedArtists: this.#skippedArtists });
    const listener = session.user?.display_name?.split(" ")[0] ?? null;
    const prev = previous ? { name: previous.name, artists: previous.artists } : null;
    let pick: Pick | null = null;
    try {
      const messages = segmentMessages({ segment, choices, listener, previous: prev, instructions: this.instructions });
      const answer = await this.#rushable(backend.djGenerate(messages, segmentSchema(choices.length), 300), timeoutMs);
      pick = readAnswer(answer, choices, segment);
      if (!pick) console.warn("DJ: the model's answer wasn't usable", answer);
    } catch (e) {
      console.warn("DJ: no answer from the model, talking from a template:", e);
    }
    if (run !== this.#run) return null;
    const byModel = !!pick;
    pick ??= fallbackPick(segment, choices, listener, prev);
    this.#segments.push(segment.id);
    for (const s of pick.songs) this.#played.add(s.uri);
    const [speech, firstVocals] = await Promise.all([this.#speak(pick.talk), songVocals(pick.songs[0].uri)]);
    if (run !== this.#run) return null;
    return { segment: segment.id, name: pick.name, songs: pick.songs, talk: pick.talk, byModel, speech, firstVocals };
  }

  /** Waits for the model, until the timeout or until the music can't wait any longer. */
  #rushable<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the model took too long")), timeoutMs);
      this.#rush = () => reject(new Error("the music can't wait"));
      promise.then(resolve, reject).finally(() => {
        clearTimeout(t);
        this.#rush = null;
      });
    });
  }

  async #speak(text: string): Promise<Spoken | null> {
    try {
      const s = await backend.djSpeak(text);
      const buffer = await this.#voice.decode(await backend.djSpeech(s.id));
      return { id: s.id, durationMs: s.duration_ms, lines: captionLines(s.sentences), buffer };
    } catch (e) {
      console.warn("DJ: couldn't voice the line:", e);
      return null;
    }
  }

  /** Starts a set with a play request: the opening, or after a song that had to wait. The DJ talks first,
   * and the music comes in when what's left of the line fits the first song's intro. */
  async #playSet(run: number, set: DjSet) {
    this.upNext = set;
    this.#awaiting = set;
    const startMusic = async () => {
      // Already under way (the listener started it), or the session moved on.
      if (run !== this.#run || this.#awaiting !== set) return;
      this.#holding = false;
      const ok = await player.playUris(
        set.songs.map((s) => s.uri),
        0,
        true,
      );
      if (run !== this.#run) return;
      if (!ok) return this.stop();
      this.#after(START_TIMEOUT_MS, () => {
        if (run !== this.#run || this.#awaiting !== set) return;
        toasts.show("The DJ couldn't get its songs playing, so it stopped.", "error");
        this.stop();
      });
    };
    const speech = set.speech;
    this.#announce(run, set, true);
    if (!speech) return startMusic();
    const plan = planTalk({ speechMs: speech.durationMs, next: set.firstVocals, old: null, oldLeftMs: 0, oldDurationMs: 0 });
    this.#after(plan.hold - PLAY_LATENCY_MS, startMusic);
  }

  /** Gives a set's talk, once: the line (if it was voiced) and an entry in what the DJ said. */
  #announce(run: number, set: DjSet, duckNow: boolean) {
    if (run !== this.#run || this.#announced === set) return;
    this.#announced = set;
    this.said = [...this.said, { name: set.name, talk: set.talk, byModel: set.byModel }];
    if (!set.speech) return;
    if (duckNow) this.#duck(0);
    this.#talk(run, set.speech);
  }

  #talk(run: number, speech: Spoken) {
    if (run !== this.#run) return;
    this.speaking = true;
    this.caption = speech.lines;
    this.#voice.play(speech.buffer, volumeGain(player.volume), () => {
      if (run !== this.#run) return;
      this.speaking = false;
      this.caption = null;
      this.#unduck();
    });
  }

  /** Turns the music down so it's low `delayMs` from now. */
  #duck(delayMs: number) {
    this.#ducked = true;
    backend.djDuck(DUCK_LEVEL, Math.round(delayMs), DUCK_DOWN_MS).catch(() => {});
  }

  #unduck() {
    if (!this.#ducked) return;
    this.#ducked = false;
    backend.djDuck(1, 0, DUCK_UP_MS).catch(() => {});
  }

  #isDjSong(uri: string): Candidate | undefined {
    return [this.current, this.upNext, this.#awaiting].flatMap((s) => s?.songs ?? []).find((s) => s.uri === uri);
  }

  #tick(run: number) {
    if (run !== this.#run) return;
    const now = performance.now();
    const t = player.track;
    const uri = t?.uri ?? null;
    const pos = player.positionNow();
    if (this.speaking) this.#voice.setGain(volumeGain(player.volume));

    // Music moved to another device: the voice and the ducking can't follow it there.
    if (!this.#awaiting && player.deviceId && !player.isLocal) {
      this.#remoteSince ??= now;
      if (now - this.#remoteSince > FOREIGN_MS) {
        toasts.show("The DJ stopped: the music moved to another device.");
        return this.stop();
      }
    } else {
      this.#remoteSince = null;
    }

    if (uri !== this.#lastUri) this.#trackChanged(run, uri);
    this.#lastUri = uri;
    this.#lastPos = pos;
    this.#lastDuration = t?.durationMs ?? 0;

    if (this.#foreignSince !== null && now - this.#foreignSince > FOREIGN_MS) {
      toasts.show("The DJ stepped out: you picked something else.");
      return this.stop();
    }

    const cur = this.current;
    if (!cur || !t || !uri || this.#awaiting) return;
    const last = cur.songs[cur.songs.length - 1];
    if (uri !== last.uri) return;
    const left = t.durationMs - pos;

    const next = this.upNext;
    if (!next && this.#outOfSongs) {
      if (left < 1500) {
        toasts.show("That's all your DJ had for now. Listen and like some more, and it'll have more to play.");
        this.stop();
      }
      return;
    }
    if (!next || this.#queued === "failed") {
      if (!next && !this.#preparing) this.#prepareNext(run);
      if (left < RUSH_MS) this.#rush?.();
      // Nothing to follow yet: hold the music rather than let something else start.
      if (left < HOLD_EARLY_MS + TICK_MS && player.isPlaying && !this.#holding) {
        this.#holding = true;
        backend.device({ action: "pause" }).catch(() => {});
        if (next) this.#playSet(run, next);
        else this.activity = "Your DJ is still picking what's next…";
      }
      return;
    }
    if (this.#queued === "no") {
      this.#queue(run, next);
      return;
    }
    if (this.#queued !== "done") return;
    if (this.#plannedOn !== uri) this.#plan(run, next, t.durationMs, pos, uri);
    this.#runCues(run, pos);
  }

  #trackChanged(run: number, uri: string | null) {
    const prev = this.#lastUri ? this.#isDjSong(this.#lastUri) : undefined;
    // A DJ song left early, not by the DJ: the listener skipped it, so its artist sits out a while.
    if (prev && this.#lastDuration > 0 && this.#lastPos < this.#lastDuration * SKIP_SHARE && !this.#holding) {
      for (const a of prev.artists) this.#skippedArtists.add(a);
    }
    if (!uri) return;
    const song = this.#isDjSong(uri);
    if (!song) {
      // Before a set the DJ started comes in, whatever was playing plays on under the voice.
      if (!this.#awaiting) this.#foreignSince ??= performance.now();
      return;
    }
    this.#foreignSince = null;
    rememberPlayed(uri);
    const next = this.upNext;
    if (next && next.songs.some((s) => s.uri === uri)) this.#advance(run, next);
  }

  /** A new set's song came up: it's the current set now, and the next one gets picked. */
  #advance(run: number, set: DjSet) {
    this.#awaiting = null;
    this.#holding = false;
    this.current = set;
    this.upNext = null;
    this.#queued = "no";
    this.#plannedOn = null;
    this.#cues = [];
    // Skipped into the new set before the DJ got to talk: say it now, over the intro, cutting short
    // whatever it was still saying.
    if (this.#announced !== set) {
      this.#voice.stop();
      this.#announce(run, set, true);
    }
    this.#lastVocals = null;
    const last = set.songs[set.songs.length - 1].uri;
    songVocals(last).then((v) => {
      if (run === this.#run && this.current === set) this.#lastVocals = v;
    });
    this.#prepareNext(run);
  }

  #prepareNext(run: number) {
    if (this.#preparing || this.upNext) return;
    const cur = this.current;
    this.activity = "Picking what's next…";
    this.#preparing = this.#prepare(run, cur?.songs[cur.songs.length - 1] ?? null, MODEL_TIMEOUT_MS).then((set) => {
      if (run !== this.#run) return;
      this.#preparing = null;
      this.activity = null;
      if (!set) {
        this.#outOfSongs = true;
        return;
      }
      this.upNext = set;
      // The finishing song is waiting for this set.
      if (this.#holding) this.#playSet(run, set);
    });
  }

  /** Adds the next set to Spotify's queue, so it follows the last song without a gap. */
  async #queue(run: number, set: DjSet) {
    this.#queued = "pending";
    const device = session.device?.device_id;
    try {
      for (const s of set.songs) {
        if (run !== this.#run) return;
        await sp.addToQueue(s.uri, device);
      }
      if (run === this.#run) this.#queued = "done";
    } catch (e) {
      console.warn("DJ: couldn't queue the next set:", e);
      if (run === this.#run) this.#queued = "failed";
    }
  }

  /** Plans the talk into `next` on the finishing song, from both songs' vocals. */
  #plan(run: number, next: DjSet, durationMs: number, pos: number, uri: string) {
    this.#plannedOn = uri;
    const speech = next.speech;
    if (!speech) {
      this.#cues = [{ at: durationMs - 1000, fire: () => this.#announce(run, next, false), fired: false, armed: false }];
      return;
    }
    const plan = planTalk({
      speechMs: speech.durationMs,
      next: next.firstVocals,
      old: this.#lastVocals,
      oldLeftMs: durationMs - pos,
      oldDurationMs: durationMs,
    });
    const talkAt = durationMs - plan.overOld;
    const cue = (at: number, fire: () => void): Cue => ({ at, fire, fired: false, armed: false });
    this.#cues = [
      cue(talkAt - 1000, () => this.#duck(Math.max(0, talkAt - player.positionNow() - DUCK_DOWN_MS))),
      cue(talkAt, () => this.#announce(run, next, false)),
    ];
    if (plan.hold > 0) {
      this.#cues.push(
        cue(durationMs - HOLD_EARLY_MS, () => {
          this.#holding = true;
          backend.device({ action: "pause" }).catch(() => {});
          this.#after(plan.hold, () => {
            if (run !== this.#run || !this.#holding) return;
            this.#holding = false;
            backend.device({ action: "play" }).catch(() => {});
          });
        }),
      );
    }
  }

  /** Fires cues that are due, and arms a timer for ones about to be, between ticks. */
  #runCues(run: number, pos: number) {
    for (const c of this.#cues) {
      if (c.fired) continue;
      const fire = () => {
        if (run !== this.#run || c.fired) return;
        c.fired = true;
        c.fire();
      };
      if (pos >= c.at - 5) fire();
      else if (!c.armed && c.at - pos < TICK_MS * 2 && player.isPlaying) {
        c.armed = true;
        this.#after(c.at - pos, fire);
      }
    }
  }
}

export const dj = new Dj();
export { Dj };
