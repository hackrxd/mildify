// The AI DJ: plays sets of songs from the user's own listening and talks between them, in a voice made on
// this computer. The backend (src-tauri/src/dj/) downloads and runs the model and voice; this side picks
// the songs (djPicks.ts), plans the talk around the songs' lyrics (djTiming.ts) and plays it all.
//
// A session plays one set at a time. Each next set is prepared while the current one plays, and queued
// during its last song. Between sets the DJ's talk is an item of its own (`onAir`), as long as the line
// takes. The finishing song plays to its end and the music goes silent right there, in the player's own
// output; Spotify starts the queued song, which is caught at its start, held, and brought in from the top
// near the end of the talk, early enough that the DJ is done before anyone sings, or after it. The talk
// may also start over the end of the finishing song once its singer has stopped. Settings turn either
// overlap off. While the DJ talks over music, the music is turned down.

import { listen } from "@tauri-apps/api/event";
import {
  buildPool,
  choicesFor,
  fallbackPick,
  INSTRUCTIONS_MAX,
  nextInSet,
  nextSegment,
  readAnswer,
  segmentMessages,
  MIN_CHOICES,
  REQUEST_MAX,
  requestChoices,
  requestScore,
  requestSegment,
  type Segment,
  lookUpMessages,
  lookUpsAsked,
  lookUpTool,
  songFacts,
  type SegmentAsk,
  segmentSchema,
  type Candidate,
  type Listening,
  type Pick,
  type Reactions,
  type SegmentId,
} from "./djPicks";
import { captionLines, DUCK_DOWN_MS, DUCK_LEVEL, DUCK_UP_MS, planTalk, vocals, volumeGain, type Vocals } from "./djTiming";
import { backend, errorMessage, type DjCloud, type DjConfig, type DjModelChoice, type DjInstall, type DjStatus, type DjVoiceEvent, type RepeatMode } from "./ipc";
import type { LyricLine } from "./lyricLines";
import { liked } from "./liked.svelte";
import { lyrics } from "./lyrics.svelte";
import { player } from "./player.svelte";
import { session } from "./session.svelte";
import * as sp from "./spotify";
import { toasts } from "./toasts.svelte";
import type { Paging, PlayHistory, SavedTrack, Track } from "./types";
import { idFromUri } from "./util";

const INSTRUCTIONS_KEY = "nativify:djInstructions";
const OVER_START_KEY = "nativify:djOverStart";
const OVER_END_KEY = "nativify:djOverEnd";
const LIVE_KEY = "nativify:djLive";
const NAME_ALL_KEY = "nativify:djNameAll";
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
/** The music goes silent at the end of a song the DJ talks on after: this far ahead it's scheduled, early
 * enough to beat the player's output queue, and over this long it fades. */
export const MUTE_LEAD_MS = 1200;
export const MUTE_RAMP_MS = 120;
/** A held song that comes in this close to its time plays on: the DJ still ends inside the gap before the singer. */
export const EARLY_TOLERANCE_MS = 300;
/** Music playing when the DJ starts fades out over this long, from when the player's output queue has played. */
export const OPENING_FADE_MS = 400;
const OUTPUT_QUEUE_MS = 600;
/** The song drifting this far from when its end's silence was timed (a pause, a small seek) times it again. */
const RETIME_MS = 250;
/** The player lifts a duck on its own after 90 s, in case the window went away; the DJ renews its own sooner. */
const GAIN_REFRESH_MS = 30_000;
/** The song lined up next can change (the listener liked something) until this long before the one playing
 * ends; the player starts loading the next song 30 s before. */
export const REPICK_UNTIL_MS = 35_000;
/** Previous this far into a song goes back to its start, not to the song before (as the player does it). */
const BACK_RESTARTS_MS = 3000;
/** After skipping a set with nothing picked to follow, the music waits this long for the model before the DJ talks
 * from a template. */
export const SKIP_WAIT_MS = 8000;
/** A Next sent in a set picked as it goes is taken to be on its way for this long, while its song comes up. */
const SKIP_LANDS_MS = 3000;
/** How long a request to turn shuffle or repeat off gets before it's sent again. */
const MODES_RETRY_MS = 3000;

export interface Spoken {
  /** The line's id in the backend, which plays it. */
  id: number;
  durationMs: number;
  lines: LyricLine[];
}

/** The DJ stopped waiting for its model: too slow, or the music couldn't wait. Not something to fix. */
class GaveUp extends Error {}

export interface DjSet {
  /** The same while a set picked as it goes grows song by song (each step is a new object). */
  id: number;
  segment: SegmentId;
  name: string;
  /** The songs to play. A set picked as it goes has the ones played and playing, and the one lined up next. */
  songs: Candidate[];
  /** Picks each song after the first while the one before it plays (Settings → AI DJ). */
  live: boolean;
  /** The songs the model picked, in order: what a set picked as it goes follows unless the listener says
   * otherwise. */
  plan: Candidate[];
  /** The rest of the segment's songs, for a set picked as it goes to turn to. */
  choices: Candidate[];
  talk: string;
  /** Written by the model, or from a template. */
  byModel: boolean;
  /** Why it's from a template, when it is. */
  why: string | null;
  /** What the listener asked for, when the set is their request. */
  request: string | null;
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

/** Where a song's singing starts and ends, as heard: with the listener's own timing nudge for it. */
async function songVocals(uri: string): Promise<Vocals | null> {
  try {
    const id = idFromUri(uri);
    const v = vocals(await backend.lyrics(id));
    const shift = lyrics.songOffsets[id] ?? 0;
    return v && { first: v.first + shift, last: v.last + shift };
  } catch {
    return null;
  }
}

/** The line's clock and the backend's drift apart by this much before the backend's wins. */
const VOICE_RESYNC_MS = 80;

/** Plays the DJ's lines on this computer's audio output, as the music plays (src-tauri/src/dj/speaker.rs), at
 * the music's volume. Not through the window's own audio: on Linux that needs GStreamer plugins that may not be
 * there. The line's clock runs here, set right by the backend's reports a few times a second. */
export class Voice {
  #id: number | null = null;
  #onEnd: ((error?: string) => void) | null = null;
  /** ms into the line at `#since`, running from there unless paused. */
  #at = 0;
  #since = 0;
  #running = false;
  #gain = -1;
  #listening = false;

  #listen() {
    if (this.#listening) return;
    this.#listening = true;
    listen<DjVoiceEvent>("dj-voice", (e) => this.#heard(e.payload)).catch(() => (this.#listening = false));
  }

  #heard(ev: DjVoiceEvent) {
    if (ev.id !== this.#id) return;
    if (ev.state === "playing") {
      if (this.#running && Math.abs(this.now() - ev.position_ms) > VOICE_RESYNC_MS) this.#anchor(ev.position_ms);
    } else {
      this.#finish(ev.state === "failed" ? ev.error : undefined);
    }
  }

  #anchor(at: number) {
    this.#at = at;
    this.#since = performance.now();
  }

  #finish(error?: string) {
    const onEnd = this.#onEnd;
    this.#clear();
    onEnd?.(error);
  }

  #clear() {
    this.#id = null;
    this.#onEnd = null;
    this.#running = false;
    this.#at = 0;
  }

  /** Plays the line `dj_speak` made as `id`, in place of any line playing; `onEnd` gets why when it couldn't. */
  play(id: number, gain: number, onEnd: (error?: string) => void) {
    this.#listen();
    this.#id = id;
    this.#onEnd = onEnd;
    this.#gain = gain;
    this.#running = true;
    this.#anchor(0);
    backend.djVoice({ action: "play", id, gain }).catch((e) => {
      if (this.#id === id) this.#finish(errorMessage(e));
    });
  }

  /** Holds the line where it is: `now()` stands still until `resume()`. */
  pause() {
    if (this.#id === null || !this.#running) return;
    this.#anchor(this.now());
    this.#running = false;
    backend.djVoice({ action: "pause" }).catch(() => {});
  }

  resume() {
    if (this.#id === null || this.#running) return;
    this.#anchor(this.#at);
    this.#running = true;
    backend.djVoice({ action: "resume" }).catch(() => {});
  }

  setGain(gain: number) {
    if (this.#id === null || Math.abs(gain - this.#gain) < 0.001) return;
    this.#gain = gain;
    backend.djVoice({ action: "gain", gain }).catch(() => {});
  }

  /** ms into the line playing now. */
  now(): number {
    if (this.#id === null) return 0;
    return this.#running ? this.#at + performance.now() - this.#since : this.#at;
  }

  /** Stops the line; its `onEnd` isn't called. */
  stop() {
    if (this.#id === null) return;
    this.#clear();
    backend.djVoice({ action: "stop" }).catch(() => {});
  }
}

/** Something to do when a clock (the finishing song's, or the line's) reaches a point. */
interface Cue {
  at: number;
  fire: () => void;
  fired: boolean;
  armed: boolean;
}

/** The DJ's talk as an item of its own in the player. */
export interface OnAir {
  /** The segment it introduces. */
  name: string;
  durationMs: number;
  /** The song it leads into. */
  next: Candidate;
}

class Dj {
  /** The backend's view: settings, downloads, disk use. */
  status = $state<DjStatus | null>(null);
  /** The listener's own instructions for the DJ. */
  instructions = $state(load(INSTRUCTIONS_KEY, "", (raw) => raw.slice(0, INSTRUCTIONS_MAX)));
  /** Settings → AI DJ: the next song may come in under the end of the talk. */
  overStart = $state(load(OVER_START_KEY, true, (raw) => raw !== "false"));
  /** Settings → AI DJ: the talk may start over the end of the finishing song. */
  overEnd = $state(load(OVER_END_KEY, true, (raw) => raw !== "false"));
  /** Settings → AI DJ: pick each song while the one before it plays, so likes and skips change what's next. */
  live = $state(load(LIVE_KEY, false, (raw) => raw === "true"));
  /** Settings → AI DJ: the DJ may name every song in the set, not just the first. */
  nameAll = $state(load(NAME_ALL_KEY, false, (raw) => raw === "true"));
  phase = $state<"off" | "starting" | "on">("off");
  /** What the DJ is busy with, for the DJ page. */
  activity = $state<string | null>(null);
  /** The set playing now. */
  current = $state.raw<DjSet | null>(null);
  /** The set after it, once it's picked. */
  upNext = $state.raw<DjSet | null>(null);
  /** The set whose talk the DJ has given, or is giving. */
  announced = $state.raw<DjSet | null>(null);
  /** What the DJ has said this session, oldest first. */
  said = $state.raw<{ name: string; talk: string; byModel: boolean; why: string | null }[]>([]);
  /** The model's last failure this session that the listener can do something about (a refused key, no credit). */
  modelTrouble = $state<string | null>(null);
  /** What the listener asked the next set to be, until a set for it comes on. */
  requested = $state<string | null>(null);
  speaking = $state(false);
  /** The line being spoken, as lyric lines timed from its start. */
  caption = $state.raw<LyricLine[] | null>(null);
  /** The DJ's item, from its first word until it's done and the song it leads into has come in. */
  onAir = $state.raw<OnAir | null>(null);
  /** How far into its talk the DJ is, a few times a second, for the player bar. */
  talkMs = $state(0);
  /** The listener paused the DJ's item. */
  paused = $state(false);

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
  /** Cues on the finishing song's clock. */
  #cues: Cue[] = [];
  /** Cues on the clock of the line being spoken. */
  #speechCues: Cue[] = [];
  /** Brings the announced set's music in now. Its cue calls it, and so does skipping the talk. */
  #bringIn: (() => void) | null = null;
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
  /** The DJ paused the music to talk on its own. */
  #heldMusic = false;
  /** The DJ asked for music that isn't reported playing yet. */
  #musicAsked = false;
  /** The queued set's first song is to be held at its start when it comes in, until this far into the line. */
  #holdFor: { set: DjSet; musicAt: number } | null = null;
  /** The music goes silent when this song reaches this position. */
  #muteAtEnd: { uri: string; at: number } | null = null;
  /** When that silence is heard, on performance.now()'s clock. */
  #silentAt = 0;
  /** The music's gain the DJ last asked the player for. */
  #level = 1;
  #gainSentAt = -Infinity;
  #repausedAt = -Infinity;
  #stalledSince: number | null = null;
  /** The set's last song is paused at its end because the next set isn't ready yet. */
  #waitingForSet = false;
  /** The listener's pause stopped music that was playing under the voice. */
  #pausedMusic = false;
  #outOfSongs = false;
  #setIds = 0;
  /** Sets picked this session, for the model to know how far into the show it is. */
  #setsThisSession = 0;
  /** Bumped when the next set being picked is no longer wanted (the listener asked for something else). */
  #prepareGen = 0;
  /** The set the listener skipped the rest of, for the next prompt; and its songs, which leaving isn't a skip of. */
  #setSkipped: string | null = null;
  #leftSet: DjSet | null = null;
  /** The listener has been told the model isn't answering, this session. */
  #modelWarned = false;
  /** What the listener did with the DJ's songs this session, most recent first. */
  #liked: Candidate[] = [];
  #skippedSongs: Candidate[] = [];
  /** Whether each of the set's songs was in the listener's library when last looked, to notice a new like. */
  #likeSeen = new Map<string, boolean>();
  /** For the set playing, picked as it goes: songs skipped, whether it ends with the song playing, whether the
   * song lined up next should be picked again, and a queue change on its way to the player. */
  #setSkips = 0;
  #setEnds = false;
  #repick = false;
  #lining = false;
  /** Songs liked while the set plays: they steer its next picks. Older likes are the model's to weigh. */
  #setLiked: Candidate[] = [];
  /** Likes and skips the model has been told about already, so each prompt says only what's new. */
  #told = new Set<string>();
  /** The last queue change sent to the player, settled once the player has it. */
  #linedUpDone: Promise<boolean> = Promise.resolve(true);
  /** Where a Next or Previous sent in a set picked as it goes is headed, while the player gets there. */
  #heading: { uri: string; at: number } | null = null;
  /** Those Nexts and Previouses, one after another: each goes from where the one before left the player. */
  #steps: Promise<unknown> = Promise.resolve();
  /** The next set's first song on its way into the player's queue, and the set being queued. */
  #queuing: Promise<void> = Promise.resolve();
  #queueFor: DjSet | null = null;
  /** Previous went back to this song: leaving the one before isn't a skip. */
  #goingBack: string | null = null;
  /** The listener has been told the voice isn't working, this session. */
  #voiceWarned = false;
  /** Shuffle and repeat as they were before the DJ turned them off, to put back when it stops. */
  #modes: { shuffle: boolean; repeat: RepeatMode } | null = null;
  #modesSentAt = -Infinity;
  /** Bumped each time a set picked as it goes changes the player's queue, for views that show the queue. */
  linedUp = $state(0);

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
    // A reload in the middle of a line mustn't leave the music turned down, or the line playing on.
    backend.djDuck(1, 0, 0).catch(() => {});
    backend.djVoice({ action: "stop" }).catch(() => {});
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
    const switching = patch.provider !== undefined || patch.model !== undefined || patch.voice !== undefined;
    if (patch.enabled === false || switching) this.stop();
    try {
      this.status = await backend.djConfigure(patch);
    } catch (e) {
      toasts.error(e);
    }
  }

  /** Saves a cloud provider's API key in the system keychain, or removes it with null. Removing the key the DJ is
   * using stops it. */
  async setKey(provider: DjCloud, key: string | null) {
    if (key === null && provider === this.status?.settings.provider) this.stop();
    try {
      this.status = await backend.djSetKey(provider, key);
      return true;
    } catch (e) {
      toasts.error(e);
      return false;
    }
  }

  /** The models a cloud provider offers with the saved key. */
  models(provider: DjCloud): Promise<DjModelChoice[]> {
    return backend.djModels(provider);
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

  setOverStart(on: boolean) {
    this.overStart = on;
    persist(OVER_START_KEY, on ? null : "false");
  }

  setOverEnd(on: boolean) {
    this.overEnd = on;
    persist(OVER_END_KEY, on ? null : "false");
  }

  /** Applies from the next set the DJ picks. */
  setLive(on: boolean) {
    this.live = on;
    persist(LIVE_KEY, on ? "true" : null);
  }

  setNameAll(on: boolean) {
    this.nameAll = on;
    persist(NAME_ALL_KEY, on ? "true" : null);
  }

  /** ms into the line the DJ is speaking, per frame, for captions. */
  speechNow(): number {
    return this.#voice.now();
  }

  /** Play/pause while the DJ's item is up pauses the DJ, and any music under it. */
  togglePause() {
    if (!this.onAir) {
      // Playing on toward a song's end that goes silent: the silence is timed anew from where it resumes.
      if (!player.isPlaying) this.#refreshGain();
      return player.togglePlay();
    }
    if (!this.paused) {
      this.paused = true;
      this.#voice.pause();
      // Music on its way is paused too, or it would start under a paused DJ.
      if (player.isPlaying || this.#musicAsked) {
        this.#pausedMusic = true;
        backend.device({ action: "pause" }).catch(() => {});
      }
    } else {
      this.paused = false;
      this.#voice.resume();
      if (this.#pausedMusic) {
        this.#pausedMusic = false;
        // A song the DJ is holding stays held until its time in the line.
        if (!this.#heldMusic) backend.device({ action: "play" }).catch(() => {});
      }
      this.#refreshGain();
    }
  }

  /** Next while the DJ's item is up skips the rest of its talk: the song it leads into comes in now. */
  skipTalk() {
    // Waiting after a skip: Next doesn't wait any longer for the model.
    if (!this.onAir && this.#skipping()) return void this.#rush?.();
    if (!this.onAir) {
      // Its next song is lined up only as each one plays, so one Next has to land before the next is sent.
      if (this.#live()) return void this.#step(() => this.#skipLive());
      return this.#nothingAfter() ? this.#skipToNextSet() : player.next();
    }
    const run = this.#run;
    this.#voice.stop();
    this.#voice.resume();
    this.paused = false;
    if (this.#pausedMusic) {
      this.#pausedMusic = false;
      backend.device({ action: "play" }).catch(() => {});
    }
    this.#bring();
    this.#talkEnded(run);
  }

  /** Previous, as the player bar's button and keys do it. A set picked as it goes has its songs after the first
   * in the player's queue, and the player keeps only a context's songs behind it: its own previous would drop the
   * song playing and go back past the set. So the song before is lined up again and played, and the set's first
   * song goes back to its start. */
  previous(): Promise<unknown> {
    // Nor back into a set that was skipped.
    if (this.onAir || this.#skipping()) return Promise.resolve();
    if (!this.#live()) return player.prev();
    return this.#step(() => this.#stepBack());
  }

  /** Asks for the next set: what the listener wants to hear ("something upbeat", "more Radiohead", "90s"). It takes
   * the place of a next set that isn't on its way yet; once one is (its talk has started), it's the set after. */
  request(text: string) {
    const ask = text.trim().slice(0, REQUEST_MAX);
    if (this.phase === "off" || !ask) return;
    this.requested = ask;
    const next = this.upNext;
    if (next && (this.announced === next || this.#awaiting === next)) return;
    if (next || this.#preparing) this.#replaceNext();
  }

  /** Takes a request back; a set already picked for it stays. */
  cancelRequest() {
    this.requested = null;
  }

  /** Lets go of the next set, and of one being picked, for one picked anew. */
  #replaceNext() {
    const run = this.#run;
    const next = this.upNext;
    if (next) {
      this.#unqueue();
      this.#dropHandOver();
      for (const s of next.songs) this.#played.delete(s.uri);
      this.upNext = null;
    }
    this.#preparing = null;
    this.#prepareGen++;
    this.#prepareNext(run);
  }

  /** Lets go of what was planned over the end of the song playing to bring the next set in; the set playing's own
   * talk and music stay as they are. */
  #dropHandOver() {
    if (!this.#plannedOn) return;
    this.#cues = [];
    this.#bringIn = null;
    this.#holdFor = null;
    this.#muteAtEnd = null;
    this.#silentAt = 0;
    this.#plannedOn = null;
    if (!this.speaking && !this.#heldMusic) this.#unduck();
  }

  /** Skips the rest of the set playing, when the listener isn't feeling it: the next set comes in now, or as soon as
   * it's picked, and the model hears the set was skipped. Waits its turn after any Next or Previous. */
  skipSet(): Promise<unknown> {
    return this.#step(() => this.#skipSetNow());
  }

  async #skipSetNow() {
    const cur = this.current;
    if (this.phase !== "on" || !cur || this.onAir || this.#awaiting || !player.isLocal) return;
    const run = this.#run;
    // A song on its way into the player's queue lands before the queue is cleared.
    await Promise.all([this.#linedUpDone, this.#queuing]);
    const now = this.current;
    if (run !== this.#run || now?.id !== cur.id || this.onAir || this.#awaiting) return;
    // A Next on its way into the next set, or the player already past this one: there's nothing left to skip.
    const heading = this.#headed();
    const on = heading ?? player.track?.uri;
    const song = now.songs.find((s) => s.uri === on);
    if ((heading && this.upNext?.songs.some((s) => s.uri === heading)) || !song) return;
    // Skipped already, and waiting for what's next.
    if (this.#skipping()) return;
    this.#setSkipped = cur.name;
    this.#leftSet = now;
    // What's lined up after the song playing (the set's next song, the next set's, or what was left there) goes:
    // the next set starts with a play request of its own.
    backend.device({ action: "clear_queue" }).catch(() => {});
    this.#queueFor = null;
    this.#queued = "no";
    // A set picked as it goes lines nothing more up.
    this.#setEnds = true;
    this.#replan();
    this.#heldMusic = true;
    backend.device({ action: "pause" }).catch(() => {});
    // The next set was picked to follow this one: it's picked again, from the song skipped, knowing the set was.
    const next = this.upNext;
    if (next && (this.announced === next || this.#awaiting === next)) return void this.#playSet(run, next);
    if (next) {
      for (const s of next.songs) this.#played.delete(s.uri);
      this.upNext = null;
    }
    this.#preparing = null;
    this.#prepareGen++;
    this.#waitingForSet = true;
    this.#prepareNext(run, song);
    this.activity = "Your DJ is picking something else…";
    // The music is waiting: past a few seconds, the DJ stops waiting for the model.
    this.#after(SKIP_WAIT_MS, () => {
      if (run === this.#run && this.#waitingForSet) this.#rush?.();
    });
  }

  /** The set playing was skipped, and the music waits for the next one to be picked. */
  #skipping(): boolean {
    return this.#waitingForSet && !!this.#leftSet && this.#leftSet.id === this.current?.id;
  }

  #step(fn: () => Promise<unknown>): Promise<unknown> {
    const p = this.#steps.then(fn);
    this.#steps = p.catch(() => {});
    return p;
  }

  /** Where the last Next or Previous sent is headed, if the player may not be there yet. */
  #headed(): string | null {
    const h = this.#heading;
    return h && performance.now() - h.at < SKIP_LANDS_MS ? h.uri : null;
  }

  #headTo(uri: string) {
    this.#heading = { uri, at: performance.now() };
  }

  async #stepBack() {
    if (this.onAir || this.#skipping()) return;
    if (!this.#live()) return player.prev();
    const run = this.#run;
    // Changes on their way to the player's queue land first, or they'd land after the song gone back to.
    await Promise.all([this.#linedUpDone, this.#queuing]);
    if (run !== this.#run || this.onAir || !this.#live()) return;
    const cur = this.current!;
    const heading = this.#headed();
    // Into the next set, with the player not there yet: nothing of this set is to go back to from there.
    if (heading && this.upNext?.songs.some((s) => s.uri === heading)) return;
    const at = cur.songs.findIndex((s) => s.uri === (heading ?? player.track?.uri));
    if (at < 0) return player.prev();
    // Past its first few seconds, a song goes back to its start, as the player does it. So does the set's first.
    if (at === 0 || (!heading && player.positionNow() >= BACK_RESTARTS_MS)) return player.seek(0);
    const back = cur.songs[at - 1];
    this.#lining = true;
    this.#goingBack = back.uri;
    try {
      await backend.device({ action: "clear_queue" });
      await backend.device({ action: "queue", uri: back.uri });
      await backend.device({ action: "next" });
    } catch (e) {
      console.warn("DJ: couldn't go back a song:", e);
      this.#goingBack = null;
      if (run === this.#run) this.#lining = false;
      return;
    }
    if (run !== this.#run) return;
    this.#headTo(back.uri);
    this.#lining = false;
    this.linedUp++;
    const now = this.current?.id === cur.id ? this.current : cur;
    // The songs from the one left on are up for picking again; the song gone back to ends the set for now.
    for (const s of now.songs.slice(at)) this.#played.delete(s.uri);
    this.current = { ...now, songs: now.songs.slice(0, at) };
    this.#repick = false;
    // The next set's first song was in the queue just cleared: it's queued again, after the song gone back to.
    if (this.#queued !== "no") this.#queued = "no";
    this.#plannedOn = null;
    this.#cues = [];
    this.#bringIn = null;
    if (this.#setEnds) this.#readyNext(run, this.current, back);
  }

  /** The set playing is picked as it goes, here. */
  #live(): boolean {
    return this.phase === "on" && !!this.current?.live && !this.#awaiting && player.isLocal;
  }

  /** Next in a set picked as it goes: makes sure a song is lined up after the one Next is headed from, then
   * sends the player there. */
  async #skipLive() {
    const run = this.#run;
    if (!this.#live() || this.onAir || this.#skipping()) return this.skipTalk();
    const cur = this.current!;
    const heading = this.#headed();
    // Already on its way into the next set, whose song has nothing lined up after it yet: one Next is enough.
    if (heading && this.upNext?.songs.some((s) => s.uri === heading)) return;
    const at = cur.songs.findIndex((s) => s.uri === (heading ?? player.track?.uri));
    if (at < 0) return player.next();
    // A change on its way to the player's queue lands before the Next does.
    await this.#linedUpDone;
    if (run !== this.#run) return;
    let set = this.current!;
    if (at === set.songs.length - 1) {
      if (this.#setEnds) {
        // The next set follows from the player's queue once it's there; until then the music waits for it.
        if (this.#queued !== "done" || !this.upNext || heading) return this.#skipToNextSet();
        this.#headTo(this.upNext.songs[0].uri);
        return player.next();
      }
      const pick = this.#nextInSet(set, set.songs, this.#played);
      if (!pick || !(await this.#lineUp(run, set, set.songs, pick))) {
        if (run !== this.#run) return;
        if (!this.#setEnds) {
          this.#setEnds = true;
          this.#readyNext(run, set, set.songs[at]);
        }
        return this.#skipToNextSet();
      }
      if (run !== this.#run) return;
      set = this.current!;
    }
    this.#headTo(set.songs[at + 1].uri);
    await player.next();
  }

  /** Starts a session. */
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
    const run = ++this.#run;
    this.#voiceWarned = false;
    this.#modelWarned = false;
    this.modelTrouble = null;
    this.#setsThisSession = 0;
    this.requested = null;
    this.#setSkipped = null;
    this.#leftSet = null;
    this.phase = "starting";
    this.said = [];
    this.current = null;
    this.upNext = null;
    this.announced = null;
    this.#segments = [];
    this.#skippedArtists = new Set();
    this.#outOfSongs = false;
    this.#liked = [];
    this.#skippedSongs = [];
    this.#told = new Set();
    this.#likeSeen.clear();
    this.activity = "Looking through your listening…";
    backend.djWarm().catch(() => {});
    // The DJ plays here; music on another device would play on under its voice.
    if (player.isPlaying && !player.isLocal) player.togglePlay();
    try {
      this.#pool = buildPool(await loadListening());
      if (run !== this.#run) return;
      this.#played = new Set(playedLately().keys());
      this.activity = "Picking your first songs…";
      const first = await this.#prepare(run, null, OPENING_TIMEOUT_MS, true);
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
    this.#voice.resume();
    this.#unduck();
    // Music the DJ held for its talk plays on; music the listener paused stays paused.
    if (this.#heldMusic && !this.paused) backend.device({ action: "play" }).catch(() => {});
    // What a set picked as it goes lined up, and hasn't reached, would otherwise play in the middle of whatever
    // the listener plays next.
    const cur = this.current;
    if (cur?.live && player.isLocal && (player.track?.uri !== cur.songs[cur.songs.length - 1].uri || this.#queued !== "no")) {
      backend.device({ action: "clear_queue" }).catch(() => {});
    }
    const modes = this.#modes;
    this.#modes = null;
    if (modes && player.isLocal) {
      if (modes.shuffle) backend.device({ action: "shuffle", on: true }).catch(() => {});
      if (modes.repeat !== "off") backend.device({ action: "repeat", mode: modes.repeat }).catch(() => {});
    }
    this.phase = "off";
    this.activity = null;
    this.speaking = false;
    this.caption = null;
    this.onAir = null;
    this.paused = false;
    this.talkMs = 0;
    this.current = null;
    this.upNext = null;
    this.announced = null;
    this.requested = null;
    this.#setSkipped = null;
    this.#leftSet = null;
    this.#preparing = null;
    this.#rush = null;
    this.#queued = "no";
    this.#cues = [];
    this.#speechCues = [];
    this.#bringIn = null;
    this.#plannedOn = null;
    this.#awaiting = null;
    this.#heldMusic = false;
    this.#waitingForSet = false;
    this.#pausedMusic = false;
    this.#musicAsked = false;
    this.#holdFor = null;
    this.#muteAtEnd = null;
    this.#silentAt = 0;
    this.#stalledSince = null;
    this.#setSkips = 0;
    this.#setEnds = false;
    this.#repick = false;
    this.#lining = false;
    this.#setLiked = [];
    this.#heading = null;
    this.#goingBack = null;
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

  #cue(at: number, fire: () => void): Cue {
    return { at, fire, fired: false, armed: false };
  }

  #planFor(speech: Spoken, next: Vocals | null, old: Vocals | null, oldLeftMs: number, oldDurationMs: number) {
    return planTalk({
      speechMs: speech.durationMs,
      next,
      old,
      oldLeftMs,
      oldDurationMs,
      overStart: this.overStart,
      overEnd: this.overEnd,
    });
  }

  /** Picks a set, asks the model for its talk (or uses a template), and reads it aloud. */
  async #prepare(
    run: number,
    previous: Candidate | null,
    timeoutMs: number,
    opening = false,
    gen?: number,
  ): Promise<DjSet | null> {
    /** Given up on: a new session, or another set wanted instead. */
    const stale = () => run !== this.#run || (gen !== undefined && gen !== this.#prepareGen);
    const avoid = { played: this.#played, skippedArtists: this.#skippedArtists };
    const request = this.requested;
    let segment: Segment | null = null;
    let choices: Candidate[] = [];
    if (request) {
      // What the listener asked for, when the listening has enough to choose from for it.
      choices = requestChoices(request, this.#pool, avoid);
      if (choices.length >= MIN_CHOICES) segment = requestSegment(request);
    }
    if (!segment) {
      const ordinary = this.#ordinarySegment();
      if (!ordinary) return null;
      ({ segment, choices } = ordinary);
    }
    // Said until a set that says it is on its way: one given up on leaves it for the one picked instead.
    const skippedSet = this.#setSkipped ?? undefined;
    const listener = session.user?.display_name?.split(" ")[0] ?? null;
    const prev = previous ? { name: previous.name, artists: previous.artists } : null;
    let pick: Pick | null = null;
    const live = this.live;
    const reactions = live ? this.#news() : undefined;
    const ask: SegmentAsk = {
      segment,
      choices,
      listener,
      previous: prev,
      instructions: this.instructions,
      opening,
      setNumber: this.#setsThisSession + 1,
      earlier: this.#earlier(),
      nameAll: this.nameAll,
      live,
      reactions,
      request: segment.id === "request" ? (request ?? undefined) : undefined,
      skippedSet,
    };
    // Given up on (too slow, or the music can't wait): what's still on its way isn't asked for.
    let gaveUp = false;
    let why: string | null = "the model didn't answer in time";
    try {
      const answer = await this.#rushable(
        (async () => {
          // A model that can call tools may look some of the songs up first.
          const lookedUp = this.status?.tools ? await this.#lookUp(ask) : undefined;
          if (gaveUp || stale()) throw new GaveUp("given up");
          return backend.djGenerate(segmentMessages({ ...ask, lookedUp }), segmentSchema(choices.length), 300);
        })(),
        timeoutMs,
      );
      pick = readAnswer(answer, choices, segment);
      if (!pick) {
        console.warn("DJ: the model's answer wasn't usable", answer);
        why = "the model's answer wasn't usable";
      }
    } catch (e) {
      gaveUp = true;
      console.warn("DJ: no answer from the model, talking from a template:", e);
      if (!(e instanceof GaveUp)) {
        why = errorMessage(e);
        this.#modelTroubled(why);
      }
    }
    if (stale()) return null;
    const byModel = !!pick;
    if (byModel) why = null;
    if (!pick && segment.id === "request") {
      // A template can't tell which songs fit a mood: it plays only what the request names, or an ordinary set
      // while the request waits for the model.
      const score = requestScore(request ?? "");
      const named = choices.filter((c) => score(c) > 0);
      if (named.length >= MIN_CHOICES) choices = named;
      else {
        const ordinary = this.#ordinarySegment();
        if (!ordinary) return null;
        ({ segment, choices } = ordinary);
      }
    }
    pick ??= fallbackPick(segment, choices, listener, prev);
    // Picking as it goes, only the first song is certain; the rest of the plan stays up for grabs.
    const songs = live ? pick.songs.slice(0, 1) : pick.songs;
    for (const s of songs) this.#played.add(s.uri);
    const [speech, firstVocals] = await Promise.all([this.#speak(pick.talk), songVocals(pick.songs[0].uri)]);
    if (stale()) {
      // A new session has its own.
      if (run === this.#run) for (const s of songs) this.#played.delete(s.uri);
      return null;
    }
    if (skippedSet !== undefined && this.#setSkipped === skippedSet) this.#setSkipped = null;
    // A template doesn't mention them: the next prompt still does.
    if (byModel && reactions) this.#toldOf(reactions);
    this.#segments.push(segment.id);
    const rest = choices.filter((c) => !pick.songs.includes(c));
    this.#setsThisSession++;
    return {
      id: ++this.#setIds,
      segment: segment.id,
      name: pick.name,
      songs,
      live,
      plan: pick.songs,
      choices: rest,
      talk: pick.talk,
      byModel,
      why,
      request: segment.id === "request" ? request : null,
      speech,
      firstVocals,
    };
  }

  /** The next of the usual segments, and its choices; none when the listening has nothing left for one. */
  #ordinarySegment(): { segment: Segment; choices: Candidate[] } | null {
    const avoid = { played: this.#played, skippedArtists: this.#skippedArtists };
    let segment = nextSegment(this.#segments, this.#pool, avoid);
    if (!segment && this.#played.size) {
      // Everything's been played: start over, leaving out only what's playing now.
      this.#played = new Set(this.current?.songs.map((s) => s.uri) ?? []);
      segment = nextSegment(this.#segments, this.#pool, { ...avoid, played: this.#played });
    }
    if (!segment) return null;
    return { segment, choices: choicesFor(segment, this.#pool, { played: this.#played, skippedArtists: this.#skippedArtists }) };
  }

  /** What the DJ said last, for the model not to say again: the set playing may not have had its say yet (it's
   * held for its talk), and what it's about to say comes last. */
  #earlier(): string[] {
    const spoken = this.said.map((s) => s.talk);
    const cur = this.current;
    if (cur && this.announced !== cur && !spoken.includes(cur.talk)) spoken.push(cur.talk);
    return spoken.slice(-2);
  }

  /** The model failed in a way the listener can fix (a refused key, no credit, a model that doesn't exist): said once
   * a session, and shown on the DJ page, as the DJ plays on from templates. */
  #modelTroubled(why: string) {
    this.modelTrouble = why;
    if (this.#modelWarned) return;
    this.#modelWarned = true;
    toasts.show(`Your DJ is talking from templates: ${why}`, "error", 8000);
  }

  /** Waits for the model, until the timeout or until the music can't wait any longer. */
  /** Lets the model ask about some of the songs before it picks; what was found, as lines for the prompt. Nothing
   * found, or no look-up, goes on without. */
  async #lookUp(ask: SegmentAsk): Promise<string[] | undefined> {
    try {
      const answer = await backend.djLookUp(lookUpMessages(ask), [lookUpTool(ask.choices.length)], 300);
      const asked = lookUpsAsked(answer.calls, ask.choices);
      if (!asked.length) return undefined;
      const found = await backend.djSongInfo(
        asked.map((c) => ({ uri: c.uri, name: c.name, artist: c.artists[0] ?? "", artist_id: c.artistIds?.[0] ?? null })),
      );
      const byUri = new Map(found.map((info) => [info.uri, info]));
      const lines = asked.flatMap((c) => {
        const info = byUri.get(c.uri);
        return info ? [songFacts(ask.choices.indexOf(c) + 1, c, info)] : [];
      });
      return lines.length ? lines : undefined;
    } catch (e) {
      console.warn("DJ: couldn't look songs up, picking without:", e);
      return undefined;
    }
  }

  #rushable<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new GaveUp("the model took too long")), timeoutMs);
      // A newer wait may have taken the rush over: that one stays.
      const rush = () => reject(new GaveUp("the music can't wait"));
      this.#rush = rush;
      promise.then(resolve, reject).finally(() => {
        clearTimeout(t);
        if (this.#rush === rush) this.#rush = null;
      });
    });
  }

  async #speak(text: string): Promise<Spoken | null> {
    try {
      const s = await backend.djSpeak(text);
      return { id: s.id, durationMs: s.duration_ms, lines: captionLines(s.sentences) };
    } catch (e) {
      this.#voiceTrouble(errorMessage(e));
      return null;
    }
  }

  /** The DJ plays on without its voice, and says why, once a session. */
  #voiceTrouble(why: string) {
    console.warn("DJ: no voice:", why);
    if (this.#voiceWarned) return;
    this.#voiceWarned = true;
    toasts.show(`Your DJ lost its voice, so it plays on without talking. ${why}`, "error", 8000);
  }

  /** Starts a set with a play request: the opening, or after a song that had to wait. The DJ's item comes
   * first, and the set's first song comes in near its end, or after it. */
  async #playSet(run: number, set: DjSet) {
    this.upNext = set;
    this.#awaiting = set;
    const startMusic = async () => {
      // Already under way (the listener started it), or the session moved on.
      if (run !== this.#run || this.#awaiting !== set) return;
      // The play request replaces whatever the DJ was holding.
      this.#heldMusic = false;
      this.#musicAsked = true;
      this.#gainTo(this.speaking ? DUCK_LEVEL : 1, 0, 0);
      const ok = await player.playUris(
        set.songs.map((s) => s.uri),
        0,
        true,
      );
      if (run !== this.#run) return;
      if (!ok) return this.stop();
      if (this.paused) {
        this.#pausedMusic = true;
        backend.device({ action: "pause" }).catch(() => {});
      }
      this.#after(START_TIMEOUT_MS, () => {
        if (run !== this.#run || this.#awaiting !== set) return;
        toasts.show("The DJ couldn't get its songs playing, so it stopped.", "error");
        this.stop();
      });
    };
    this.#bringIn = () => void startMusic();
    if (!set.speech) {
      this.#announce(run, set);
      return this.#bring();
    }
    // Whatever is playing here fades out and stops: the DJ's item comes first, not over the middle of a song.
    if (player.isPlaying && player.isLocal && !this.#heldMusic) {
      this.#heldMusic = true;
      this.#gainTo(0, OUTPUT_QUEUE_MS, OPENING_FADE_MS);
      this.#after(OUTPUT_QUEUE_MS + OPENING_FADE_MS, () => {
        if (run === this.#run && this.#heldMusic && this.#awaiting === set) {
          backend.device({ action: "pause" }).catch(() => {});
        }
      });
    }
    const plan = this.#planFor(set.speech, set.firstVocals, null, 0, 0);
    // A play request takes a moment to be heard: when the song comes in under the voice, ask early.
    const lead = plan.overIntro > 0 ? PLAY_LATENCY_MS : 0;
    this.#speechCues = [this.#cue(Math.max(0, plan.musicAt - lead), () => this.#bring())];
    this.#announce(run, set);
  }

  #bring() {
    const bringIn = this.#bringIn;
    this.#bringIn = null;
    bringIn?.();
  }

  /** Gives a set's talk, once: the line (if it was voiced) and an entry in what the DJ said. */
  #announce(run: number, set: DjSet) {
    if (run !== this.#run || this.announced === set) return;
    this.announced = set;
    this.said = [...this.said, { name: set.name, talk: set.talk, byModel: set.byModel, why: set.why }];
    // The request is on.
    if (set.request && this.requested === set.request) this.requested = null;
    if (set.speech) this.#talk(run, set, set.speech);
  }

  #talk(run: number, set: DjSet, speech: Spoken) {
    if (run !== this.#run) return;
    // Music under the voice goes down; music held back, or going silent at a song's end, is left to that.
    if (!this.#heldMusic && !this.#muteAtEnd && this.#level !== DUCK_LEVEL) this.#duck(0);
    this.speaking = true;
    this.paused = false;
    this.talkMs = 0;
    this.caption = speech.lines;
    this.onAir = { name: set.name, durationMs: speech.durationMs, next: set.songs[0] };
    this.#voice.play(speech.id, volumeGain(player.volume), (error) => {
      if (error) this.#voiceTrouble(error);
      this.#talkEnded(run);
    });
  }

  /** The line is over, or skipped: whatever waited on it happens now, and the music comes back up. */
  #talkEnded(run: number) {
    if (run !== this.#run) return;
    this.speaking = false;
    this.caption = null;
    this.talkMs = this.onAir?.durationMs ?? 0;
    const due = this.#speechCues;
    this.#speechCues = [];
    for (const c of due) {
      if (!c.fired) {
        c.fired = true;
        c.fire();
      }
    }
    this.#unduck();
    this.#endOnAir();
  }

  /** The DJ's item ends once it's done talking and the song it leads into has come in. */
  #endOnAir() {
    if (!this.onAir || this.speaking || this.#heldMusic) return;
    if (this.upNext && this.announced === this.upNext) return;
    this.onAir = null;
    this.paused = false;
    this.#pausedMusic = false;
  }

  /** Asks the player to bring the music's gain to `level`, `delayMs` from now as heard, over `rampMs`. */
  #gainTo(level: number, delayMs: number, rampMs: number) {
    this.#level = level;
    if (level > 0) this.#muteAtEnd = null;
    this.#gainSentAt = performance.now();
    backend.djDuck(level, Math.round(Math.max(0, delayMs)), Math.round(rampMs)).catch(() => {});
  }

  /** Turns the music down so it's low `delayMs` from now. */
  #duck(delayMs: number) {
    this.#gainTo(DUCK_LEVEL, delayMs, DUCK_DOWN_MS);
  }

  #unduck() {
    if (this.#level < 1) this.#gainTo(1, 0, DUCK_UP_MS);
  }

  /** Silences the music as `uri` reaches `at` (its end), so whatever Spotify starts next isn't heard. */
  #muteAt(uri: string, at: number) {
    const left = at - player.positionNow();
    this.#gainTo(0, left - MUTE_RAMP_MS, MUTE_RAMP_MS);
    this.#muteAtEnd = { uri, at };
    this.#silentAt = performance.now() + left;
  }

  /** Says the gain again: after a pause, the silence at a song's end has to be timed anew, and the player
   * would lift a duck on its own after a while. */
  #refreshGain() {
    const mute = this.#muteAtEnd;
    if (mute && player.track?.uri === mute.uri && player.positionNow() < mute.at) {
      this.#gainTo(this.speaking ? DUCK_LEVEL : 1, 0, 0);
      this.#muteAt(mute.uri, mute.at);
    } else if (this.#level < 1) {
      this.#gainTo(this.#level, 0, 0);
    }
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

    if (this.speaking) {
      this.#voice.setGain(volumeGain(player.volume));
      if (!this.paused) {
        const said = this.#voice.now();
        this.talkMs = Math.round(said);
        this.#runCues(run, this.#speechCues, said, () => this.#voice.now(), true);
      }
    }
    if (player.isPlaying) this.#musicAsked = false;
    // The DJ's music that came in after the listener paused it is paused too; music they picked themselves isn't.
    if (this.paused && this.#pausedMusic && player.isPlaying && uri && this.#isDjSong(uri) && now - this.#repausedAt > 1000) {
      this.#repausedAt = now;
      backend.device({ action: "pause" }).catch(() => {});
    }
    if (this.#level < 1 && now - this.#gainSentAt > GAIN_REFRESH_MS) this.#refreshGain();
    // The DJ is done but its song never came in: don't leave its item up for good.
    if (this.onAir && !this.speaking && !this.paused && !player.isPlaying) {
      this.#stalledSince ??= now;
      if (now - this.#stalledSince > START_TIMEOUT_MS) {
        toasts.show("The DJ couldn't get its songs playing, so it stopped.", "error");
        return this.stop();
      }
    } else {
      this.#stalledSince = null;
    }
    this.#endOnAir();

    if (uri && this.#isDjSong(uri) && player.isLocal) this.#plainModes(now);
    // Sent back in the song a transition was planned on: plan it again from there.
    if (uri && uri === this.#lastUri && uri === this.#plannedOn && pos < this.#lastPos - 1500) this.#replan();
    if (uri !== this.#lastUri) this.#trackChanged(run, uri);
    // The silence at the song's end is timed by the clock: after a pause, or a step too small to plan again, time
    // it anew from where the song is.
    const mute = this.#muteAtEnd;
    if (mute?.uri === uri && player.isPlaying && Math.abs(mute.at - pos - (this.#silentAt - now)) > RETIME_MS) {
      this.#refreshGain();
    }
    this.#lastUri = uri;
    this.#lastPos = pos;
    this.#lastDuration = t?.durationMs ?? 0;

    if (this.#foreignSince !== null && now - this.#foreignSince > FOREIGN_MS) {
      toasts.show("The DJ stepped out: you picked something else.");
      return this.stop();
    }

    if (!this.current || !t || !uri || this.#awaiting) return;
    const left = t.durationMs - pos;
    if (this.current.live && player.isLocal) this.#goLive(run, this.current, uri, left);
    const cur = this.current;
    const last = cur.songs[cur.songs.length - 1];
    if (uri !== last.uri) return;

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
      // A skipped set's song stands still, paused: the skip gives the model its few seconds.
      if (left < RUSH_MS && !this.#skipping()) this.#rush?.();
      // Nothing to follow yet: hold the music rather than let something else start.
      if (left < HOLD_EARLY_MS + TICK_MS && player.isPlaying && !this.#heldMusic) {
        this.#heldMusic = true;
        backend.device({ action: "pause" }).catch(() => {});
        if (next) {
          // What made it into the queue would play again after the set's play request.
          this.#unqueue();
          this.#playSet(run, next);
        }
        else {
          this.#waitingForSet = true;
          this.activity = "Your DJ is still picking what's next…";
        }
      }
      return;
    }
    if (this.#queued === "no") {
      this.#queue(run, next);
      return;
    }
    if (this.#queued !== "done") return;
    if (this.#plannedOn !== uri) this.#plan(run, next, t.durationMs, pos, uri);
    // Paused, the song's cues wait: a seek while paused only moves where they'll fire from.
    if (player.isPlaying) this.#runCues(run, this.#cues, pos, () => player.positionNow(), true);
  }

  /** A set picked as it goes: once a song is under way, the next one is picked and lined up in the player's
   * queue, and picked again when the listener likes something, until it's too late to change. When the set
   * should end with the song playing, the next set gets picked. */
  #goLive(run: number, cur: DjSet, uri: string, left: number) {
    this.#noticeLikes(cur);
    if (this.#setEnds || this.#lining) return;
    const at = cur.songs.findIndex((s) => s.uri === uri);
    if (at < 0) return;
    if (at === cur.songs.length - 1) {
      const pick = this.#nextInSet(cur, cur.songs, this.#played);
      if (pick) return this.#lineUp(run, cur, cur.songs, pick);
      this.#setEnds = true;
      this.#readyNext(run, cur, cur.songs[at]);
    } else if (at === cur.songs.length - 2 && this.#repick && left > REPICK_UNTIL_MS) {
      this.#repick = false;
      const queued = cur.songs[at + 1];
      // The song lined up is fair game again.
      const played = new Set(this.#played);
      played.delete(queued.uri);
      const sofar = cur.songs.slice(0, -1);
      const pick = this.#nextInSet(cur, sofar, played);
      if (pick && pick.uri !== queued.uri) this.#lineUp(run, cur, sofar, pick);
    }
  }

  /** Likes and skips no answer from the model has gone by yet. */
  #news(): Reactions {
    const fresh = (kind: string, songs: Candidate[]) => songs.filter((s) => !this.#told.has(kind + s.uri));
    return { liked: fresh("liked:", this.#liked), skipped: fresh("skipped:", this.#skippedSongs) };
  }

  /** The model answered with these in mind: later prompts leave them out. */
  #toldOf(news: Reactions) {
    for (const s of news.liked) this.#told.add("liked:" + s.uri);
    for (const s of news.skipped) this.#told.add("skipped:" + s.uri);
  }

  #nextInSet(cur: DjSet, sofar: Candidate[], played: Set<string>): Candidate | null {
    return nextInSet({
      plan: cur.plan,
      choices: cur.choices,
      pool: this.#pool,
      sofar,
      played,
      skippedArtists: this.#skippedArtists,
      reactions: { liked: this.#setLiked, skipped: this.#skippedSongs },
      skips: this.#setSkips,
    });
  }

  /** Puts `pick` after `sofar`, in the set and in the player's queue, in place of whatever was lined up. */
  #lineUp(run: number, cur: DjSet, sofar: Candidate[], pick: Candidate): Promise<boolean> {
    const replaced = cur.songs.length > sofar.length ? cur.songs[cur.songs.length - 1] : null;
    if (replaced) this.#played.delete(replaced.uri);
    this.#played.add(pick.uri);
    this.#repick = false;
    this.#lining = true;
    this.current = { ...cur, songs: [...sofar, pick] };
    const done = (async () => {
      await backend.device({ action: "clear_queue" });
      // Stopped meanwhile: nothing more goes in the queue.
      if (run !== this.#run) return false;
      await backend.device({ action: "queue", uri: pick.uri });
      if (run === this.#run) this.linedUp++;
      return true;
    })()
      .catch((e) => {
        console.warn("DJ: couldn't line up the next song:", e);
        // Nothing follows in the player: the set ends with the song playing.
        if (run !== this.#run || this.current?.id !== cur.id) return false;
        this.current = { ...this.current, songs: sofar };
        this.#setEnds = true;
        this.#readyNext(run, cur, sofar[sofar.length - 1]);
        return false;
      })
      .finally(() => {
        if (run === this.#run) this.#lining = false;
      });
    this.#linedUpDone = done;
    return done;
  }

  /** A song of the set the listener just liked, here or anywhere in the app: what's next leans toward it. */
  #noticeLikes(cur: DjSet) {
    for (const s of cur.songs) {
      const now = liked.has(s.uri);
      if (now === undefined) {
        liked.ensure([s.uri]);
        continue;
      }
      const was = this.#likeSeen.get(s.uri);
      this.#likeSeen.set(s.uri, now);
      if (was === false && now) {
        this.#liked = [s, ...this.#liked.filter((l) => l.uri !== s.uri)].slice(0, 10);
        this.#setLiked = [s, ...this.#setLiked.filter((l) => l.uri !== s.uri)];
        this.#repick = true;
      }
    }
  }

  /** The song playing ends its set, and nothing is lined up after it yet. */
  #nothingAfter(): boolean {
    const cur = this.current;
    const uri = player.track?.uri;
    if (this.phase !== "on" || !cur || !uri || this.#awaiting || this.onAir || !player.isLocal) return false;
    return uri === cur.songs[cur.songs.length - 1].uri && this.#queued !== "done";
  }

  /** Skipped past the end of a set with nothing after it: the player would stop. A song left before half way
   * counts as skipped, the music waits, and the next set comes in as soon as it's ready. */
  #skipToNextSet() {
    const run = this.#run;
    const song = this.current?.songs.find((s) => s.uri === player.track?.uri);
    const dur = player.track?.durationMs ?? 0;
    // As in #trackChanged: not a song the DJ is holding at its end, nor one nearly over.
    if (song && !this.#heldMusic && dur > 0 && player.positionNow() < dur * SKIP_SHARE) {
      for (const a of song.artists) this.#skippedArtists.add(a);
      this.#skippedSongs = [song, ...this.#skippedSongs.filter((s) => s.uri !== song.uri)].slice(0, 10);
    }
    this.#heldMusic = true;
    backend.device({ action: "pause" }).catch(() => {});
    if (this.upNext) {
      // Its songs come in with a play request: any of them already in the queue would play twice.
      this.#unqueue();
      return this.#playSet(run, this.upNext);
    }
    this.#waitingForSet = true;
    this.activity = "Your DJ is still picking what's next…";
    if (!this.#preparing) this.#prepareNext(run);
    this.#rush?.();
  }

  /** Keeps shuffle and repeat off while a DJ song plays: shuffle would play a set out of order, and repeat
   * would hold it on one song or go round the set again, so the next set would never come. */
  #plainModes(now: number) {
    const shuffle = player.shuffle;
    const repeat = player.repeat;
    if ((!shuffle && repeat === "off") || now - this.#modesSentAt < MODES_RETRY_MS) return;
    this.#modesSentAt = now;
    this.#modes ??= { shuffle, repeat };
    if (shuffle) backend.device({ action: "shuffle", on: false }).catch(() => {});
    if (repeat !== "off") backend.device({ action: "repeat", mode: "off" }).catch(() => {});
  }

  #trackChanged(run: number, uri: string | null) {
    const prev = this.#lastUri ? this.#isDjSong(this.#lastUri) : undefined;
    // Songs the player passes through on its way back leave it be.
    const wentBack = uri !== null && uri === this.#goingBack;
    if (wentBack) this.#goingBack = null;
    if (uri === this.#heading?.uri) this.#heading = null;
    // A DJ song left early, not by the DJ: the listener skipped it, so its artist sits out a while.
    // Leaving a set the listener skipped isn't a skip of the song: the set was.
    const leaving = !!prev && !!this.#leftSet?.songs.some((s) => s.uri === prev.uri);
    if (prev && !wentBack && !leaving && this.#lastDuration > 0 && this.#lastPos < this.#lastDuration * SKIP_SHARE && !this.#heldMusic) {
      for (const a of prev.artists) this.#skippedArtists.add(a);
      this.#skippedSongs = [prev, ...this.#skippedSongs.filter((s) => s.uri !== prev.uri)].slice(0, 10);
      if (this.current?.songs.some((s) => s.uri === prev.uri)) this.#setSkips++;
    }
    if (!uri) return;
    const song = this.#isDjSong(uri);
    // Gone back to: whatever Next left it, the listener wants it after all.
    if (wentBack && song) this.#forgive(song);
    if (!song) {
      // The listener's own pick is heard, under the voice, not held silent for the DJ's talk.
      if (this.#level === 0) {
        this.#heldMusic = false;
        this.#gainTo(this.speaking ? DUCK_LEVEL : 1, 0, DUCK_UP_MS);
      }
      // Before a set the DJ started comes in, whatever was playing plays on under the voice. Otherwise the
      // listener moved on, and nothing the DJ planned is to be done to their song.
      if (!this.#awaiting) {
        this.#foreignSince ??= performance.now();
        this.#bringIn = null;
      }
      return;
    }
    this.#foreignSince = null;
    rememberPlayed(uri);
    const next = this.upNext;
    if (next && next.songs.some((s) => s.uri === uri)) this.#advance(run, next);
  }

  /** Takes back a skip of `song`. */
  #forgive(song: Candidate) {
    if (!this.#skippedSongs.some((s) => s.uri === song.uri)) return;
    this.#skippedSongs = this.#skippedSongs.filter((s) => s.uri !== song.uri);
    for (const a of song.artists) if (!this.#skippedSongs.some((s) => s.artists.includes(a))) this.#skippedArtists.delete(a);
    if (this.current?.songs.some((s) => s.uri === song.uri)) this.#setSkips = Math.max(0, this.#setSkips - 1);
  }

  /** A new set's song came up: it's the current set now, and the next one gets picked. */
  #advance(run: number, set: DjSet) {
    const held = this.#holdFor?.set === set ? this.#holdFor : null;
    this.#holdFor = null;
    this.#awaiting = null;
    this.#heldMusic = false;
    this.#waitingForSet = false;
    this.#musicAsked = false;
    this.#bringIn = null;
    this.#muteAtEnd = null;
    this.current = set;
    this.upNext = null;
    this.#queued = "no";
    this.#plannedOn = null;
    this.#cues = [];
    if (this.announced !== set) this.#talkFirst(run, set);
    else if (held && this.speaking && this.#voice.now() < held.musicAt - EARLY_TOLERANCE_MS) {
      // Here before its time, with more of the line left than its intro has room for: back to its start.
      this.#speechCues = [];
      this.#holdSong(run, held.musicAt);
    } else {
      if (this.#level === 0) this.#gainTo(this.speaking ? DUCK_LEVEL : 1, 0, 0);
      this.#endOnAir();
    }
    this.#setSkips = 0;
    this.#setEnds = false;
    this.#repick = false;
    this.#setLiked = [];
    this.#heading = null;
    this.#leftSet = null;
    this.#lastVocals = null;
    // A set picked as it goes knows its last song, and readies the next set, only once that song is under way.
    if (set.live) return;
    this.#readyNext(run, set, set.songs[set.songs.length - 1]);
  }

  /** The set ends with `last`: its vocals time the talk over its end, and the next set gets picked. */
  #readyNext(run: number, set: DjSet, last: Candidate) {
    songVocals(last.uri).then((v) => {
      if (run === this.#run && this.current?.id === set.id) this.#lastVocals = v;
    });
    this.#prepareNext(run);
  }

  /** The set's song came up before the DJ introduced it: the listener skipped ahead, or the DJ waited for
   * the finishing song to end. The DJ's item still comes first: the song is held at its start until the rest
   * of the line fits over its intro. */
  #talkFirst(run: number, set: DjSet) {
    // Cut short whatever the DJ was still saying.
    this.#voice.stop();
    this.speaking = false;
    this.caption = null;
    this.#speechCues = [];
    if (set.speech) {
      const plan = this.#planFor(set.speech, set.firstVocals, null, 0, 0);
      if (plan.musicAt > 0) this.#holdSong(run, plan.musicAt);
    }
    // Spotify moves on once the finishing song is decoded, before its last moments have left the player's
    // output: the DJ starts once they're heard.
    const wait = Math.min(OUTPUT_QUEUE_MS, this.#silentAt - performance.now());
    if (wait > 0) this.#after(wait, () => this.current?.id === set.id && this.#announce(run, set));
    else this.#announce(run, set);
  }

  /** Holds the song that just came in at its start, and brings it in from the top `musicAt` into the line. */
  #holdSong(run: number, musicAt: number) {
    this.#heldMusic = true;
    this.#musicAsked = false;
    backend.device({ action: "pause" }).catch(() => {});
    this.#bringIn = () => {
      if (run !== this.#run) return;
      this.#heldMusic = false;
      this.#musicAsked = true;
      this.#gainTo(this.speaking ? DUCK_LEVEL : 1, 0, 0);
      backend.device({ action: "seek", position_ms: 0 }).catch(() => {});
      backend.device({ action: "play" }).catch(() => {});
      this.#endOnAir();
    };
    this.#speechCues.push(this.#cue(musicAt, () => this.#bring()));
  }

  /** The listener went back in the song the DJ was about to talk after: forget the plan (and any talk already
   * under way over its end), and plan again from where the song is now. */
  #replan() {
    if (this.speaking && this.upNext && this.announced === this.upNext && !this.#heldMusic) {
      this.#voice.stop();
      this.speaking = false;
      this.caption = null;
      this.onAir = null;
      this.paused = false;
      this.said = this.said.slice(0, -1);
      this.announced = null;
    }
    this.#speechCues = [];
    this.#cues = [];
    this.#bringIn = null;
    this.#holdFor = null;
    this.#muteAtEnd = null;
    this.#silentAt = 0;
    this.#plannedOn = null;
    this.#unduck();
  }

  /** Picks the next set, to follow `previous` (the set playing's last song, unless said). */
  #prepareNext(run: number, previous?: Candidate) {
    if (this.#preparing || this.upNext) return;
    const cur = this.current;
    const gen = ++this.#prepareGen;
    this.activity = "Picking what's next…";
    const after = previous ?? cur?.songs[cur.songs.length - 1] ?? null;
    this.#preparing = this.#prepare(run, after, MODEL_TIMEOUT_MS, false, gen).then((set) => {
      if (run !== this.#run) return;
      if (gen !== this.#prepareGen) {
        // The listener asked for something else meanwhile: this set's songs go back in the pool.
        for (const s of set?.songs ?? []) this.#played.delete(s.uri);
        return;
      }
      this.#preparing = null;
      this.activity = null;
      if (!set) {
        this.#outOfSongs = true;
        // The music is waiting for a set that won't come.
        if (this.#waitingForSet) {
          this.#waitingForSet = false;
          toasts.show("That's all your DJ had for now. Listen and like some more, and it'll have more to play.");
          this.stop();
        }
        return;
      }
      this.upNext = set;
      // The finishing song is waiting for this set.
      if (this.#waitingForSet) {
        this.#waitingForSet = false;
        this.#playSet(run, set);
      }
    });
  }

  /** Adds the next set to Spotify's queue, so it can follow the last song without a gap. */
  #queue(run: number, set: DjSet) {
    this.#queued = "pending";
    this.#queueFor = set;
    // After whatever's on its way to the queue already, a clear included.
    this.#queuing = this.#queuing.then(() => this.#queueSongs(run, set));
  }

  /** Takes the next set back out of the player's queue: what's on its way stops, and what made it in comes out
   * before anything else is queued. */
  #unqueue() {
    this.#queueFor = null;
    if (this.#queued !== "no" && player.isLocal) {
      this.#queuing = this.#queuing.then(() => backend.device({ action: "clear_queue" }).then(() => {}, () => {}));
    }
    this.#queued = "no";
  }

  async #queueSongs(run: number, set: DjSet) {
    // Let go of while it waited its turn.
    if (run !== this.#run || this.#queueFor !== set) return;
    const device = session.device?.device_id;
    try {
      for (const s of set.songs) {
        // Let go of meanwhile, or started with a play request instead: the rest of it isn't wanted.
        if (run !== this.#run || this.#queueFor !== set) return;
        await sp.addToQueue(s.uri, device);
      }
      // The listener may have skipped into this set meanwhile: then the next one is queued in its turn.
      if (run === this.#run && this.upNext === set) this.#queued = "done";
    } catch (e) {
      console.warn("DJ: couldn't queue the next set:", e);
      if (run === this.#run && this.upNext === set) this.#queued = "failed";
    }
  }

  /** Plans the DJ's item between the finishing song and the queued set, from both songs' vocals. */
  #plan(run: number, next: DjSet, durationMs: number, pos: number, uri: string) {
    this.#plannedOn = uri;
    // The queued set is Spotify's next song: skipping to it brings it in, whatever the finishing one is doing.
    this.#bringIn = () => {
      if (run !== this.#run) return;
      for (const c of this.#cues) c.fired = true;
      this.#musicAsked = true;
      backend.device({ action: "next" }).catch(() => {});
      backend.device({ action: "play" }).catch(() => {});
    };
    const speech = next.speech;
    if (!speech) {
      this.#cues = [this.#cue(durationMs - 1000, () => this.#announce(run, next))];
      return;
    }
    const plan = this.#planFor(speech, next.firstVocals, this.#lastVocals, durationMs - pos, durationMs);
    const cues: Cue[] = [];
    if (plan.overOld > 0) {
      // The DJ starts over the end of the finishing song, once its singer is done.
      const talkAt = durationMs - plan.overOld;
      cues.push(this.#cue(talkAt - 1000, () => this.#duck(talkAt - player.positionNow() - DUCK_DOWN_MS)));
      cues.push(this.#cue(talkAt, () => this.#announce(run, next)));
    }
    if (plan.hold > 0) {
      // The DJ talks on its own between the songs. The finishing song plays to its end and the music goes
      // silent there; the queued song Spotify starts next is held at its start until its time (#advance), or
      // the DJ's talk starts with it (#talkFirst) when it didn't start over the finishing song.
      this.#holdFor = { set: next, musicAt: plan.musicAt };
      cues.push(this.#cue(durationMs - MUTE_LEAD_MS, () => this.#muteAt(uri, durationMs)));
    }
    // With no hold, the queued song follows the finishing one on its own, under the end of the line.
    this.#cues = cues;
  }

  /** Fires the cues that are due on a clock, and arms a timer for ones about to be, between ticks. */
  #runCues(run: number, cues: Cue[], now: number, clock: () => number, running: boolean) {
    for (const c of cues) {
      if (c.fired) continue;
      const fire = () => {
        if (run !== this.#run || c.fired) return;
        // Armed ahead, then the clock stopped (a pause): not due after all.
        if (clock() < c.at - 5) {
          c.armed = false;
          return;
        }
        c.fired = true;
        c.fire();
      };
      if (now >= c.at - 5) fire();
      else if (!c.armed && running && c.at - now < TICK_MS * 2) {
        c.armed = true;
        this.#after(c.at - now, fire);
      }
    }
  }
}

export const dj = new Dj();
export { Dj };
