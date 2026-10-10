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
  asksFor,
  buildPool,
  choicesFor,
  MIN_CHOICES,
  nextInSet,
  nextSegment,
  REQUEST_MAX,
  requestChoices,
  requestScore,
  requestSegment,
  type Candidate,
  type Segment,
  type SegmentId,
} from "./djPicks";
import {
  cleanName,
  daypart,
  fallbackPick,
  INSTRUCTIONS_MAX,
  isTalkStyle,
  listenerName,
  pickAngle,
  sentences,
  type Angle,
  type SegmentAsk,
  type TalkStyle,
  type TemplatePick,
} from "./djTalk";
import { captionLines, DUCK_DOWN_MS, DUCK_LEVEL, DUCK_UP_MS, planTalk, readLines, volumeGain, type Vocals } from "./djTiming";
import { loadListening } from "./djListening";
import { DjMemory, load, persist, PLAYED_MEMORY_MS, type SetNote } from "./djMemory";
import { askModel, GaveUp, songVocals, type ModelRound } from "./djPicker";
import { SessionTaste } from "./djTaste";
import { modelNote, voiceNote } from "./djView";
import { Voice, type Spoken } from "./djVoice";
import {
  backend,
  errorMessage,
  type DjCloud,
  type DjConfig,
  type DjInstall,
  type DjModelChoice,
  type DjSongInfo,
  type DjStatus,
  type RepeatMode,
} from "./ipc";
import type { LyricLine } from "./lyricLines";
import { liked } from "./liked.svelte";
import { player } from "./player.svelte";
import { session } from "./session.svelte";
import * as sp from "./spotify";
import { toasts } from "./toasts.svelte";

export { loadListening } from "./djListening";
export { Voice, type Spoken } from "./djVoice";

const INSTRUCTIONS_KEY = "nativify:djInstructions";
const OVER_START_KEY = "nativify:djOverStart";
const OVER_END_KEY = "nativify:djOverEnd";
const LIVE_KEY = "nativify:djLive";
const NAME_ALL_KEY = "nativify:djNameAll";
const TALK_KEY = "nativify:djTalk";
const NAME_KEY = "nativify:djName";
const USE_NAME_KEY = "nativify:djUseName";
/** How many of its latest openings a local model hears before opening a session. */
const OPENINGS_REMEMBERED = 3;
/** The settings that pick the model, or say how to reach it: changing any may fix what was wrong with it. */
const MODEL_SETTINGS: (keyof DjConfig)[] = ["provider", "model", "server_url", "server_model", "own_tools", "api_models"];
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
  /** What the model looked up about the set's songs, by URI, for the DJ page. A set from a template has what was
   * looked up before the model failed, if anything. */
  lookedUp: ReadonlyMap<string, DjSongInfo>;
}

/** A line the DJ said this session. */
export interface SaidLine {
  /** The set it introduced. */
  name: string;
  setId: number;
  talk: string;
  /** Written by the model, or from a template, and why when it is. */
  byModel: boolean;
  why: string | null;
  /** Read aloud; false when the voice couldn't make it, and it was only shown. */
  spoken: boolean;
}

/** What happens in a session, for whatever keeps track of it (memory, a playlist of the session, extensions). */
export type DjEvent =
  | { type: "set-picked"; set: DjSet }
  | { type: "set-started"; set: DjSet }
  | { type: "set-skipped"; set: DjSet }
  | { type: "song-started"; song: Candidate; set: DjSet | null }
  | { type: "song-skipped"; song: Candidate }
  | { type: "song-unskipped"; song: Candidate }
  | { type: "song-liked"; song: Candidate }
  | { type: "line-spoken"; line: SaidLine }
  | { type: "line-withdrawn"; line: SaidLine }
  | { type: "stopped" };

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
  /** The set it introduces, for its menu wherever the item is shown. */
  set: DjSet;
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
  /** Settings → AI DJ: how much the DJ talks; Just play ("silent") only shows its lines, and the music plays on. */
  talk = $state<TalkStyle>(load(TALK_KEY, "normal", (raw) => (isTalkStyle(raw) ? raw : "normal")));
  /** Settings → AI DJ: what the DJ calls the listener; empty for the first name on their Spotify account. */
  callMe = $state(load(NAME_KEY, "", cleanName));
  /** Settings → AI DJ: the DJ may say the listener's name. */
  useName = $state(load(USE_NAME_KEY, true, (raw) => raw !== "false"));
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
  said = $state.raw<SaidLine[]>([]);
  /** The model's last failure that the listener can do something about (a refused key, no credit), for the DJ page:
   * kept until the model answers again or its settings change, through stopping and starting. */
  modelTrouble = $state<string | null>(null);
  /** Why the DJ's voice last failed, for the DJ page: kept until a line plays through or another voice is picked. */
  voiceTrouble = $state<string | null>(null);
  /** What the listener asked the next set to be, until a set for it comes on. */
  requested = $state<string | null>(null);
  speaking = $state(false);
  /** A line shows without the voice (Just play, or the voice failed), for about as long as it would take to say. */
  showing = $state(false);
  /** The line being spoken or shown, as lyric lines timed from its start. */
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
  /** What the listener liked and skipped this session. */
  #taste = new SessionTaste();
  /** What the DJ remembers from one session to the next. */
  #memory = new DjMemory();
  /** When this session started: with a set's id, what its memory is kept under. */
  #sessionStart = 0;
  #preparing: Promise<void> | null = null;
  #rush: (() => void) | null = null;
  #queued: "no" | "pending" | "done" | "failed" = "no";
  /** Cues on the finishing song's clock. */
  #cues: Cue[] = [];
  /** Cues on the clock of the line being spoken. */
  #speechCues: Cue[] = [];
  /** When the line showing without the voice came up, on performance.now()'s clock, and for how long. */
  #shown: { since: number; forMs: number } | null = null;
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
  /** A set started with a play request, whose first song hasn't come up yet. Reactive, as are `#waitingForSet` and
   * `#leftSet`, for `canSkipSet`. */
  #awaiting = $state.raw<DjSet | null>(null);
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
  #waitingForSet = $state(false);
  /** The listener's pause stopped music that was playing under the voice. */
  #pausedMusic = false;
  #outOfSongs = false;
  #setIds = 0;
  /** Sets picked this session, for the model to know how far into the show it is. */
  #setsThisSession = 0;
  /** How the model's lines this session have started, so the next starts another way. */
  #angles: Angle[] = [];
  /** The template the DJ talked from last this session, so the next is another. */
  #lastTemplate: string | null = null;
  /** Bumped when the next set being picked is no longer wanted (the listener asked for something else). */
  #prepareGen = 0;
  /** The set the listener skipped the rest of, for the next prompt; and its songs, which leaving isn't a skip of. */
  #setSkipped: string | null = null;
  #leftSet = $state.raw<DjSet | null>(null);
  /** The listener has been told the model isn't answering, this session. */
  #modelWarned = false;
  /** Bumped by a change to the model's settings: a round asked before it reports no trouble. */
  #modelSettings = 0;
  /** For the set playing, picked as it goes: songs skipped, whether it ends with the song playing, whether the
   * song lined up next should be picked again, and a queue change on its way to the player. */
  #setSkips = 0;
  #setEnds = false;
  #repick = false;
  #lining = false;
  /** Songs liked while the set plays: they steer its next picks. Older likes are the model's to weigh. */
  #setLiked: Candidate[] = [];
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
    this.on((e) => this.#remember(e));
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
    // Another model ends the session. A new voice carries on (a line already made keeps the old one), unless it has
    // to download first.
    const switching = patch.provider !== undefined || patch.model !== undefined;
    if (patch.enabled === false || switching) this.stop();
    let saved = true;
    try {
      this.status = await backend.djConfigure(patch);
    } catch (e) {
      saved = false;
      toasts.error(e);
    }
    if (patch.voice !== undefined && !this.ready) this.stop();
    if (!saved) return;
    // A change that may have fixed the model or the voice: what was wrong is forgotten, and said again if it isn't.
    if (MODEL_SETTINGS.some((k) => patch[k] !== undefined)) this.#forgetModelTrouble();
    if (patch.voice !== undefined) this.#forgetVoiceTrouble();
  }

  /** Saves a cloud provider's API key in the system keychain, or removes it with null. Removing the key the DJ is
   * using stops it. */
  async setKey(provider: DjCloud, key: string | null) {
    const inUse = provider === this.status?.settings.provider;
    if (key === null && inUse) this.stop();
    try {
      this.status = await backend.djSetKey(provider, key);
    } catch (e) {
      toasts.error(e);
      return false;
    }
    if (inUse) this.#forgetModelTrouble();
    return true;
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

  /** Applies from the next set the DJ picks. */
  setTalk(style: TalkStyle) {
    this.talk = style;
    persist(TALK_KEY, style === "normal" ? null : style);
  }

  setCallMe(name: string) {
    this.callMe = cleanName(name);
    persist(NAME_KEY, this.callMe || null);
  }

  setUseName(on: boolean) {
    this.useName = on;
    persist(USE_NAME_KEY, on ? null : "false");
  }

  /** What the DJ calls the listener: the name they gave it, or the first name on their Spotify account when it looks
   * like one; none when they'd rather it didn't. */
  #listener(): string | null {
    if (!this.useName) return null;
    return this.callMe || listenerName(session.user?.display_name);
  }

  /** ms into the line the DJ is speaking or showing, per frame, for captions. */
  speechNow(): number {
    return this.#shown ? performance.now() - this.#shown.since : this.#voice.now();
  }

  /** Play/pause while the DJ's item is up pauses the DJ, and any music under it. */
  togglePause() {
    // Waiting after a skip: Play is for the next set, so it doesn't wait any longer for the model.
    if (!this.onAir && this.#skipping()) return void this.#rush?.();
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
    if (this.upNext) {
      this.#unqueue();
      this.#dropHandOver();
    }
    this.#letGoOfNext();
    this.#prepareNext(run);
    // The music is waiting for it: the set asked for gets the same few seconds a skip gives.
    if (this.#waitingForSet) this.#hurry(run);
  }

  /** Lets go of the next set, and of one still being picked (its answer is ignored when it comes): their songs
   * are up for picking again. The player's queue and any hand-over to it are the caller's to undo. */
  #letGoOfNext() {
    if (this.upNext) this.#unplayed(this.upNext.songs);
    this.upNext = null;
    this.#preparing = null;
    this.#prepareGen++;
  }

  /** Songs picked for a set that won't play: up for picking again. */
  #unplayed(songs: Candidate[]) {
    for (const s of songs) this.#played.delete(s.uri);
  }

  /** Past a few seconds, the waiting music stops waiting for the model. */
  #hurry(run: number) {
    this.#after(SKIP_WAIT_MS, () => {
      if (run === this.#run && this.#waitingForSet) this.#rush?.();
    });
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

  /** Whether `set` can be skipped now: it's the set playing (there's none unless the DJ is on), the DJ isn't talking
   * or bringing a set in, the music plays on this computer, and no skip is under way. The page's Skip buttons and
   * `skipSet()` go by it. */
  canSkipSet(set: DjSet | null): boolean {
    return !!set && set.id === this.current?.id && !this.onAir && !this.#awaiting && player.isLocal && !this.#skipping();
  }

  async #skipSetNow() {
    const cur = this.current;
    if (!cur || !this.canSkipSet(cur)) return;
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
    this.#emit({ type: "set-skipped", set: now });
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
    this.#letGoOfNext();
    this.#waitingForSet = true;
    this.#prepareNext(run, song);
    this.activity = "Your DJ is picking something else…";
    // The music is waiting: past a few seconds, the DJ stops waiting for the model.
    this.#hurry(run);
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
    // Playback is at rest already: there's no session to start from but a stopped one.
    this.#resetShow();
    this.#sessionStart = Date.now();
    this.phase = "starting";
    this.activity = "Looking through your listening…";
    backend.djWarm().catch(() => {});
    // The DJ plays here; music on another device would play on under its voice.
    if (player.isPlaying && !player.isLocal) player.togglePlay();
    try {
      this.#pool = buildPool(await loadListening({ user: session.user?.id }));
      if (run !== this.#run) return;
      this.#played = this.#memory.playedWithin(PLAYED_MEMORY_MS);
      this.activity = "Picking your first songs…";
      const first = await this.#prepare(run, null, OPENING_TIMEOUT_MS, true);
      if (run !== this.#run) return;
      if (!first) {
        throw new Error("There isn't enough in your listening for the DJ yet. Play and like some songs, then try again.");
      }
      this.#emit({ type: "set-picked", set: first });
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
    this.#resetPlayback();
    backend.djRelease().catch(() => {});
    this.#emit({ type: "stopped" });
    if (import.meta.env.DEV) this.#checkInvariants();
  }

  /** What a session remembers about its show: what was said and played, liked and skipped, and what it's warned
   * about. A new session starts it afresh; stopping keeps it, for the DJ page to show. The model's and voice's
   * trouble outlast it: they're kept until they're fixed. */
  #resetShow() {
    this.#invariantsBroken.clear();
    this.#voiceWarned = false;
    this.#modelWarned = false;
    this.#setsThisSession = 0;
    this.#angles = [];
    this.#lastTemplate = null;
    this.said = [];
    this.#segments = [];
    this.#outOfSongs = false;
    this.#taste = new SessionTaste();
  }

  /** Where the playing is: the sets, the talk, the queue, the hand-over and its cues, what the music is held
   * for. Stopping clears all of it. */
  #resetPlayback() {
    this.activity = null;
    this.speaking = false;
    this.showing = false;
    this.#shown = null;
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
    this.#queueFor = null;
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
    this.#lastVocals = null;
    this.#lastPos = 0;
    this.#lastDuration = 0;
  }

  #listeners = new Set<(event: DjEvent) => void>();

  /** Calls `fn` with each thing that happens in a session, as it happens; returns a function that stops it. */
  /** Forgets what the DJ remembers from earlier sessions: what it played, what was skipped and liked while it
   * played, how its sets went and what it said. This session carries on as it is. */
  forget() {
    this.#memory.forget();
  }

  /** What the DJ keeps for later sessions, from what happens in this one. */
  #remember(e: DjEvent) {
    const memory = this.#memory;
    const key = (set: DjSet) => `${this.#sessionStart}:${set.id}`;
    // A song's skip or like counts toward the set playing, when it's that set's.
    const setOf = (song: Candidate) => (this.current?.songs.some((s) => s.uri === song.uri) ? this.current : null);
    const note = (song: Candidate, what: SetNote) => {
      const set = setOf(song);
      if (set) memory.noteSet(key(set), what);
    };
    switch (e.type) {
      case "set-started":
        memory.setStarted(key(e.set), { segment: e.set.segment, part: daypart(new Date()), request: !!e.set.request });
        break;
      case "set-skipped":
        memory.noteSet(key(e.set), "skipped");
        break;
      case "song-started":
        memory.played(e.song.uri);
        if (e.set) memory.noteSet(key(e.set), "song");
        break;
      case "song-skipped":
        memory.skipped(e.song);
        note(e.song, "skip");
        break;
      case "song-unskipped":
        memory.unskipped(e.song);
        note(e.song, "unskip");
        break;
      case "song-liked":
        memory.liked(e.song);
        note(e.song, "like");
        break;
      case "line-spoken":
        // The session's first line opened it.
        memory.said({ ...e.line, opening: this.said.length === 1 });
        break;
      case "line-withdrawn":
        memory.unsaid(e.line.talk);
        break;
    }
  }

  on(fn: (event: DjEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  #emit(event: DjEvent) {
    for (const fn of [...this.#listeners]) {
      try {
        fn(event);
      } catch (e) {
        console.error("DJ: a listener to its events failed", e);
      }
    }
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
    const request = this.requested;
    const chosen = this.#chooseSegment(request);
    if (!chosen) return null;
    let { segment, choices } = chosen;
    // Said until a set that says it is on its way: one given up on leaves it for the one picked instead.
    const skippedSet = this.#setSkipped ?? undefined;
    const listener = this.#listener();
    const prev = previous ? { name: previous.name, artists: previous.artists } : null;
    const live = this.live;
    const reactions = live ? this.#taste.news() : undefined;
    // A model on this computer, or the listener's own, has less room than a cloud one.
    const local = this.status?.settings.provider === "local" || this.status?.settings.provider === "own";
    const ask: SegmentAsk = {
      segment,
      choices,
      listener,
      previous: prev,
      instructions: this.instructions,
      opening,
      setNumber: this.#setsThisSession + 1,
      earlier: this.#earlier(local),
      compact: local,
      nameAll: this.nameAll,
      live,
      reactions,
      request: segment.id === "request" ? (request ?? undefined) : undefined,
      // A request's set grows only by songs it names: a mood isn't for the DJ's list to guess.
      topUp: segment.id === "request" ? choices.filter((c) => requestScore(request ?? "")(c) > 0) : undefined,
      skippedSet,
      talk: this.talk,
    };
    ask.angle = pickAngle(ask, this.#angles) ?? undefined;
    const asked = await this.#askModel(ask, timeoutMs, stale);
    let pick = asked.pick;
    const why = asked.why;
    if (stale()) return null;
    const byModel = !!pick;
    if (!pick && segment.id === "request") {
      const instead = this.#forTemplate(request ?? "", choices);
      if (!instead) return null;
      ({ segment, choices } = instead);
    }
    const liked = reactions?.liked[0] ?? null;
    let template: TemplatePick | null = null;
    if (!pick) {
      template = fallbackPick(segment, choices, {
        listener,
        previous: prev,
        skipped: skippedSet !== undefined,
        request: segment.id === "request",
        liked,
        talk: this.talk,
        last: this.#lastTemplate,
      });
      pick = template;
    }
    // Picking as it goes, only the first song is certain; the rest of the plan stays up for grabs.
    const songs = live ? pick.songs.slice(0, 1) : pick.songs;
    for (const s of songs) this.#played.add(s.uri);
    // Just play has no voice, and so no talk to time around the song's vocals.
    const [speech, firstVocals] =
      ask.talk === "silent" ? [null, null] : await Promise.all([this.#speak(pick.talk), songVocals(pick.songs[0].uri)]);
    if (stale()) {
      // A new session has its own.
      if (run === this.#run) this.#unplayed(songs);
      return null;
    }
    if (skippedSet !== undefined && this.#setSkipped === skippedSet) this.#setSkipped = null;
    // A template mentions only the like it's about, if any: the next prompt tells of the rest.
    if (byModel && reactions) this.#taste.toldOf(reactions);
    if (template) {
      this.#lastTemplate = template.template;
      if (template.kind === "liked" && liked) this.#taste.toldOf({ liked: [liked], skipped: [] });
    }
    if (byModel && ask.angle) this.#angles.push(ask.angle);
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
      lookedUp: asked.found,
    };
  }

  /** The segment to pick from, and its choices: what the listener asked for, when the listening has enough to
   * choose from for it, or the next of the usual segments. None when the listening has nothing left. */
  #chooseSegment(request: string | null): { segment: Segment; choices: Candidate[] } | null {
    if (request) {
      const choices = requestChoices(request, this.#pool, this.#avoid(request), Math.random, this.#memory);
      if (choices.length >= MIN_CHOICES) return { segment: requestSegment(request), choices };
    }
    return this.#ordinarySegment();
  }

  /** The model's pick for `ask`, after any look-ups it wants; none, with why, when it didn't give a usable one in
   * time or was given up on. A failure the listener can fix is said once a session. */
  async #askModel(ask: SegmentAsk, timeoutMs: number, stale: () => boolean): Promise<ModelRound> {
    const settings = this.#modelSettings;
    const round = await askModel(ask, {
      tools: !!this.status?.tools,
      wait: (p) => this.#rushable(p, timeoutMs),
      stale,
    });
    if (round.pick) this.modelTrouble = null;
    // Trouble with settings changed since is no news: the change may have fixed it, and the next round tells.
    else if (round.trouble && settings === this.#modelSettings) this.#modelTroubled(round.trouble);
    return round;
  }

  /** A request's set without the model: a template can't tell which songs fit a mood, so it plays only what the
   * request names, or an ordinary set while the request waits for the model. None when there's nothing to play. */
  #forTemplate(request: string, choices: Candidate[]): { segment: Segment; choices: Candidate[] } | null {
    const score = requestScore(request);
    const named = choices.filter((c) => score(c) > 0);
    if (named.length >= MIN_CHOICES) return { segment: requestSegment(request), choices: named };
    return this.#ordinarySegment();
  }

  /** The next of the usual segments, and its choices; none when the listening has nothing left for one. When
   * everything's been played, it starts over, leaving out only what's playing now and what's skipped; when that
   * leaves too little, only what's playing now. */
  #ordinarySegment(): { segment: Segment; choices: Candidate[] } | null {
    const playing = new Set(this.current?.songs.map((s) => s.uri) ?? []);
    const ways = [this.#avoid(), this.#avoid(null, playing), { played: playing, skippedArtists: new Set<string>() }];
    for (const avoid of ways) {
      const segment = nextSegment(this.#segments, this.#pool, avoid);
      if (!segment) continue;
      if (avoid !== ways[0]) this.#played = new Set(playing);
      return { segment, choices: choicesFor(segment, this.#pool, avoid, Math.random, this.#memory) };
    }
    return null;
  }

  /** What a set leaves out: songs `played` (lately, by default), songs and artists skipped too much lately
   * (`DjMemory.leftOutSongs`, `leftOutArtists`), and artists sitting out after a skip this session
   * (`SessionTaste.sittingOut`); but not an artist the set's `request` asks for by name. */
  #avoid(request: string | null = null, played = this.#played): { played: Set<string>; skippedArtists: Set<string> } {
    const asked = request ? asksFor(request) : () => false;
    const out = [...this.#taste.sittingOut(this.#setsThisSession), ...this.#memory.leftOutArtists()];
    return {
      played: new Set([...played, ...this.#memory.leftOutSongs()]),
      skippedArtists: new Set(out.filter((a) => !asked(a))),
    };
  }

  /** What the DJ said last, for the model not to say again: the set playing may not have had its say yet (it's
   * held for its talk), and what it's about to say comes last. Before it's said anything this session, a model on
   * this computer or the listener's own server hears how the DJ opened lately, so it opens some other way; a cloud
   * model hears nothing from earlier sessions. */
  #earlier(local: boolean): string[] {
    const spoken = this.said.map((s) => s.talk);
    const cur = this.current;
    if (cur && this.announced !== cur && !spoken.includes(cur.talk)) spoken.push(cur.talk);
    if (!spoken.length && local) return this.#memory.lastOpenings(OPENINGS_REMEMBERED).map((s) => s.talk);
    return spoken;
  }

  /** The model failed in a way the listener can fix (a refused key, no credit, a model that doesn't exist): said once
   * a session, and shown on the DJ page, as the DJ plays on from templates. */
  #modelTroubled(why: string) {
    this.modelTrouble = why;
    if (this.#modelWarned) return;
    this.#modelWarned = true;
    toasts.show(modelNote(why, true), "error", 8000);
  }

  /** The model's settings changed: its trouble is forgotten, and told again if it comes back. */
  #forgetModelTrouble() {
    this.modelTrouble = null;
    this.#modelWarned = false;
    this.#modelSettings++;
  }

  /** Waits for the model, until the timeout or until the music can't wait any longer. */
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
      this.#voiceFailed(errorMessage(e));
      return null;
    }
  }

  /** The DJ plays on without its voice, its lines shown instead, and says why, once a session. */
  #voiceFailed(why: string) {
    console.warn("DJ: no voice:", why);
    this.voiceTrouble = why;
    if (this.#voiceWarned) return;
    this.#voiceWarned = true;
    toasts.show(voiceNote(why, true), "error", 8000);
  }

  /** Another voice was picked: the old one's trouble is forgotten, and told again if it comes back. */
  #forgetVoiceTrouble() {
    this.voiceTrouble = null;
    this.#voiceWarned = false;
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
    const line: SaidLine = { name: set.name, setId: set.id, talk: set.talk, byModel: set.byModel, why: set.why, spoken: !!set.speech };
    this.said = [...this.said, line];
    this.#emit({ type: "line-spoken", line });
    // The request is on.
    if (set.request && this.requested === set.request) this.requested = null;
    if (set.speech) this.#talk(run, set, set.speech);
    else this.#show(set.talk);
  }

  /** Shows a line without the voice, as the music plays on: captions timed as if it were read, up as long. */
  #show(talk: string) {
    const { lines, durationMs } = readLines(sentences(talk));
    this.caption = lines;
    this.showing = true;
    this.#shown = { since: performance.now(), forMs: durationMs };
  }

  #unshow() {
    if (!this.showing) return;
    this.showing = false;
    this.caption = null;
    this.#shown = null;
  }

  /** Stops the line the DJ is saying or showing, and takes its captions down. */
  #hush() {
    this.#voice.stop();
    this.speaking = false;
    this.showing = false;
    this.#shown = null;
    this.caption = null;
  }

  #talk(run: number, set: DjSet, speech: Spoken) {
    if (run !== this.#run) return;
    // Music under the voice goes down; music held back, or going silent at a song's end, is left to that.
    if (!this.#heldMusic && !this.#muteAtEnd && this.#level !== DUCK_LEVEL) this.#duck(0);
    this.#unshow();
    this.speaking = true;
    this.paused = false;
    this.talkMs = 0;
    this.caption = speech.lines;
    this.onAir = { name: set.name, durationMs: speech.durationMs, next: set.songs[0], set };
    this.#voice.play(speech.id, volumeGain(player.volume), (error) => {
      if (error) this.#voiceFailed(error);
      // A line that played through: the voice works.
      else this.voiceTrouble = null;
      this.#talkEnded(run);
      // What it couldn't say shows instead, as a line with no voice does.
      if (error && run === this.#run) this.#show(set.talk);
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
    this.#tickOnce(run);
    if (import.meta.env.DEV && run === this.#run) this.#checkInvariants();
  }

  /** Rules the session's state keeps between ticks, checked in development builds: a broken one is a bug. */
  #checkInvariants() {
    const broken: string[] = [];
    const rule = (ok: boolean, name: string) => void (ok || broken.push(name));
    rule(!this.#preparing || !this.upNext, "a set being picked while one is ready");
    rule(!this.#awaiting || this.#awaiting === this.upNext, "awaiting a set that isn't next");
    rule(!this.#waitingForSet || !this.upNext, "waiting for a set that's ready");
    rule(!this.#plannedOn || !!this.upNext, "a hand-over planned with no next set");
    rule(!this.#cues.length || !!this.#plannedOn, "hand-over cues with no plan");
    rule(!this.#holdFor || !!this.#plannedOn, "a hold left over from a dropped plan");
    rule(!this.#queueFor || this.#queueFor === this.upNext || this.#queueFor === this.current, "queueing a set let go of");
    rule(!this.showing || (!this.speaking && !!this.caption && !!this.#shown), "a line shown without captions, or spoken");
    if (this.phase === "off") {
      rule(
        !this.current && !this.upNext && !this.announced && !this.onAir && !this.speaking && !this.showing &&
          !this.#preparing && !this.#rush && this.#queued === "no" && !this.#cues.length && !this.#speechCues.length &&
          !this.#bringIn && !this.#plannedOn && !this.#awaiting && !this.#heldMusic && !this.#waitingForSet &&
          !this.#holdFor && !this.#muteAtEnd && !this.#queueFor && !this.#leftSet && !this.#setSkipped &&
          !this.#lining && !this.#setEnds && !this.#heading && !this.requested,
        "stopped with playback state left",
      );
    }
    for (const name of broken) {
      if (this.#invariantsBroken.has(name)) continue;
      this.#invariantsBroken.add(name);
      console.error(`DJ invariant: ${name}`);
    }
  }
  /** Rules already reported this session, each said once. */
  #invariantsBroken = new Set<string>();

  #tickOnce(run: number) {
    if (run !== this.#run) return;
    const now = performance.now();
    const t = player.track;
    const uri = t?.uri ?? null;
    const pos = player.positionNow();
    if (this.#watchDevice(now)) return;
    this.#watchVoice(run);
    if (this.#shown && now - this.#shown.since >= this.#shown.forMs) this.#unshow();
    if (this.#watchMusic(now, uri)) return;
    this.#watchTrack(run, t, uri, pos, now);
    if (this.#watchForeign(now)) return;
    this.#towardNextSet(run, t, uri, pos);
  }

  /** Music moved to another device: the voice and the ducking can't follow it there. True when the DJ stopped. */
  #watchDevice(now: number): boolean {
    if (!this.#awaiting && player.deviceId && !player.isLocal) {
      this.#remoteSince ??= now;
      if (now - this.#remoteSince > FOREIGN_MS) {
        toasts.show("The DJ stopped: the music moved to another device.");
        this.stop();
        return true;
      }
    } else {
      this.#remoteSince = null;
    }
    return false;
  }

  /** The line being spoken: its gain follows the volume, its clock shows, and its cues fire. */
  #watchVoice(run: number) {
    if (!this.speaking) return;
    this.#voice.setGain(volumeGain(player.volume));
    if (!this.paused) {
      const said = this.#voice.now();
      this.talkMs = Math.round(said);
      this.#runCues(run, this.#speechCues, said, () => this.#voice.now(), true);
    }
  }

  /** The music under the DJ: kept paused while the listener has the DJ paused, its turned-down gain renewed, and
   * the DJ's item ended once its song plays. True when the DJ stopped, its song never having come in. */
  #watchMusic(now: number, uri: string | null): boolean {
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
        this.stop();
        return true;
      }
    } else {
      this.#stalledSince = null;
    }
    this.#endOnAir();
    return false;
  }

  /** Where the song is: shuffle and repeat kept off, a plan made again when the listener went back, a new song
   * noticed, and the silence at its end timed anew after a pause or a small step. */
  #watchTrack(run: number, t: typeof player.track, uri: string | null, pos: number, now: number) {
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
  }

  /** The listener played something else for a while. True when the DJ stepped out. */
  #watchForeign(now: number): boolean {
    if (this.#foreignSince !== null && now - this.#foreignSince > FOREIGN_MS) {
      toasts.show("The DJ stepped out: you picked something else.");
      this.stop();
      return true;
    }
    return false;
  }

  /** Over the set's last song: the next set picked, queued and its hand-over planned and run, or the music held
   * while it isn't ready. */
  #towardNextSet(run: number, t: typeof player.track, uri: string | null, pos: number) {
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
    if (!next || this.#queued === "failed") return this.#holdForNextSet(run, next, left);
    if (this.#queued === "no") {
      this.#queue(run, next);
      return;
    }
    if (this.#queued !== "done") return;
    if (this.#plannedOn !== uri) this.#plan(run, next, t.durationMs, pos, uri);
    // Paused, the song's cues wait: a seek while paused only moves where they'll fire from.
    if (player.isPlaying) this.#runCues(run, this.#cues, pos, () => player.positionNow(), true);
  }

  /** The set's last song with no next set queued (none picked, or the queue refused it): the model is hurried,
   * and near the end the music is held for the next set rather than let something else start. */
  #holdForNextSet(run: number, next: DjSet | null, left: number) {
    if (!next && !this.#preparing) this.#prepareNext(run);
    // A skipped set's song stands still, paused: the skip gives the model its few seconds.
    if (left < RUSH_MS && !this.#skipping()) this.#rush?.();
    if (left < HOLD_EARLY_MS + TICK_MS && player.isPlaying && !this.#heldMusic) {
      this.#heldMusic = true;
      backend.device({ action: "pause" }).catch(() => {});
      if (next) {
        // What made it into the queue would play again after the set's play request.
        this.#unqueue();
        this.#playSet(run, next);
      } else {
        this.#waitingForSet = true;
        this.activity = "Your DJ is still picking what's next…";
      }
    }
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

  #nextInSet(cur: DjSet, sofar: Candidate[], played: Set<string>): Candidate | null {
    return nextInSet(
      {
        plan: cur.plan,
        choices: cur.choices,
        pool: this.#pool,
        sofar,
        played: new Set([...played, ...this.#memory.leftOutSongs()]),
        skippedArtists: this.#avoid(cur.request).skippedArtists,
        reactions: { liked: this.#setLiked, skipped: this.#taste.skippedSongs },
        skips: this.#setSkips,
        request: cur.request,
      },
      this.#memory,
    );
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
    for (const s of cur.songs) if (liked.has(s.uri) === undefined) liked.ensure([s.uri]);
    for (const s of this.#taste.noticeLikes(cur.songs, (uri) => liked.has(uri))) {
      this.#setLiked = [s, ...this.#setLiked.filter((l) => l.uri !== s.uri)];
      this.#repick = true;
      this.#emit({ type: "song-liked", song: s });
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
    if (song && !this.#heldMusic && dur > 0 && player.positionNow() < dur * SKIP_SHARE) this.#countSkip(song);
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
      this.#countSkip(prev);
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
    const next = this.upNext;
    if (next && next.songs.some((s) => s.uri === uri)) this.#advance(run, next);
    this.#emit({ type: "song-started", song, set: this.current?.songs.some((s) => s.uri === uri) ? this.current : null });
  }

  /** The listener skipped `song`: once per song left, however many ways its leaving is seen (a Next past a set's
   * end, then the track change it makes). A skip in the set playing counts toward changing direction. */
  #countSkip(song: Candidate) {
    if (!this.#taste.skipped(song, this.#setsThisSession)) return;
    if (this.current?.songs.some((s) => s.uri === song.uri)) this.#setSkips++;
    this.#emit({ type: "song-skipped", song });
  }

  /** Takes back a skip of `song`. */
  #forgive(song: Candidate) {
    if (!this.#taste.forgive(song)) return;
    if (this.current?.songs.some((s) => s.uri === song.uri)) this.#setSkips = Math.max(0, this.#setSkips - 1);
    this.#emit({ type: "song-unskipped", song });
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
    this.#emit({ type: "set-started", set });
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
    this.#hush();
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
    if ((this.speaking || this.showing) && this.upNext && this.announced === this.upNext && !this.#heldMusic) {
      this.#hush();
      this.onAir = null;
      this.paused = false;
      const line = this.said.at(-1);
      this.said = this.said.slice(0, -1);
      if (line) this.#emit({ type: "line-withdrawn", line });
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
        this.#unplayed(set?.songs ?? []);
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
      this.#emit({ type: "set-picked", set });
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
    } finally {
      // Done with it: nothing is on its way into the queue any more.
      if (this.#queueFor === set) this.#queueFor = null;
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
        // Dropped since it was armed (a plan let go of, or made anew): not due any more.
        if (run !== this.#run || c.fired || !(this.#cues.includes(c) || this.#speechCues.includes(c))) return;
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
