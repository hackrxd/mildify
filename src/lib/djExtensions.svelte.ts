// What extensions see of the AI DJ, and what they add to it (`ns.dj`, docs/mods.md "The DJ"). They get copies of
// its sets, songs and lines: frozen, so nothing an extension does changes what the DJ goes by, and the same copy for
// as long as the DJ keeps the same thing, so a watcher can tell what changed. Its events reach them just after the
// DJ's own step, each listener on its own: one that calls back into the DJ, or throws, can't upset that step or
// another listener. Never the DJ's settings, keys, or what went wrong with its model, whose errors may quote a
// provider's. What they add (`djExtensions`) the DJ reads as it picks each set, and the DJ page lists.

import { untrack } from "svelte";
import type { DjEvent, DjSet, OnAir, SaidLine } from "./dj.svelte";
import type { Candidate, Reason, Segment, SegmentId } from "./djPicks";
import { cleanTalk, cut, EXTENSION_INSTRUCTIONS_MAX, fence, SEGMENT_BRIEF_MAX } from "./djTalk";
import type { AddedItem } from "./menu.svelte";

/** One of the DJ's songs. */
export interface DjSongView {
  uri: string;
  name: string;
  artists: readonly string[];
  album: string;
  /** The year its album came out. */
  year: string | null;
  durationMs: number;
  explicit: boolean;
  /** How it's in the listener's listening: on repeat lately, a favorite, played lately, liked lately or long ago. */
  reasons: readonly Reason[];
  /** When the listener liked it, as an ISO date, if they did. */
  likedAt: string | null;
  /** When they last played it, as an ISO date, if lately. */
  playedAt: string | null;
}

/** One of the DJ's sets. A set picked as it goes is a new copy each time it grows, with the same `id`. */
export interface DjSetView {
  id: number;
  name: string;
  /** The segment it's from: "onRepeat", "favorites", "throwbacks", "fresh", "rediscover", "request", or an
   * extension's ("ext:<extension id>/<its id>"). */
  segment: string;
  /** The extension whose segment it is, by name; null for the DJ's own. */
  from: string | null;
  /** Its songs: for a set picked as it goes, those played, playing, and lined up next. */
  songs: readonly DjSongView[];
  /** What the DJ says to bring it in. */
  talk: string;
  /** Written by the model, or from a template. */
  byModel: boolean;
  /** Picked song by song as it plays (Settings → AI DJ, "Pick songs as it goes"). */
  live: boolean;
  /** What was asked for, when the set is a request: the listener's, or an extension's (`requestBy`). */
  request: string | null;
  /** The extension that asked for it, by name; null when it was the listener. */
  requestBy: string | null;
}

/** A line the DJ said. */
export interface DjLineView {
  /** The set it brought in, and that set's name. */
  setId: number;
  name: string;
  talk: string;
  byModel: boolean;
  /** Read aloud; false when it was only shown. */
  spoken: boolean;
}

/** The DJ's talk, as an item of its own in the player. */
export interface DjOnAirView {
  /** The set it brings in. */
  setId: number;
  name: string;
  durationMs: number;
  /** The song it leads into. */
  next: DjSongView;
}

/** What happens in a session, as extensions hear of it. */
export type DjExtensionEvent =
  | { type: "set-picked" | "set-started" | "set-skipped"; set: DjSetView }
  | { type: "song-started"; song: DjSongView; set: DjSetView | null }
  | { type: "song-skipped" | "song-unskipped" | "song-liked"; song: DjSongView }
  | { type: "line-spoken" | "line-withdrawn"; line: DjLineView }
  | { type: "stopped" };

const songs = new WeakMap<Candidate, DjSongView>();
const sets = new WeakMap<DjSet, DjSetView>();
const lines = new WeakMap<SaidLine, DjLineView>();
const lineLists = new WeakMap<readonly SaidLine[], readonly DjLineView[]>();
const onAirs = new WeakMap<OnAir, DjOnAirView>();

/** `key`'s copy, frozen, made once: the DJ replaces what it changes, so a copy is good for as long as what it's of. */
function copy<K extends object, V>(cache: WeakMap<K, V>, key: K, make: (key: K) => V): V {
  let v = cache.get(key);
  if (!v) {
    v = Object.freeze(make(key));
    cache.set(key, v);
  }
  return v;
}

export function songView(c: Candidate): DjSongView {
  return copy(songs, c, (c) => ({
    uri: c.uri,
    name: c.name,
    artists: Object.freeze([...c.artists]),
    album: c.album,
    year: c.year,
    durationMs: c.durationMs,
    explicit: c.explicit,
    reasons: Object.freeze([...c.reasons]),
    likedAt: c.likedAt?.toISOString() ?? null,
    playedAt: c.playedAt?.toISOString() ?? null,
  }));
}

export function setView(s: DjSet): DjSetView {
  return copy(sets, s, (s) => ({
    id: s.id,
    name: s.name,
    segment: s.segment,
    from: s.from,
    songs: Object.freeze(s.songs.map(songView)),
    talk: s.talk,
    byModel: s.byModel,
    live: s.live,
    request: s.request,
    requestBy: s.requestBy?.name ?? null,
  }));
}

export function lineView(l: SaidLine): DjLineView {
  return copy(lines, l, (l) => ({ setId: l.setId, name: l.name, talk: l.talk, byModel: l.byModel, spoken: l.spoken }));
}

function onAirView(o: OnAir): DjOnAirView {
  return copy(onAirs, o, (o) => ({ setId: o.set.id, name: o.name, durationMs: o.durationMs, next: songView(o.next) }));
}

export function eventView(e: DjEvent): DjExtensionEvent {
  switch (e.type) {
    case "set-picked":
    case "set-started":
    case "set-skipped":
      return Object.freeze({ type: e.type, set: setView(e.set) });
    case "song-started":
      return Object.freeze({ type: e.type, song: songView(e.song), set: e.set && setView(e.set) });
    case "song-skipped":
    case "song-unskipped":
    case "song-liked":
      return Object.freeze({ type: e.type, song: songView(e.song) });
    case "line-spoken":
    case "line-withdrawn":
      return Object.freeze({ type: e.type, line: lineView(e.line) });
    case "stopped":
      return Object.freeze({ type: e.type });
  }
}

/** The extension asking, by its id and its name. */
export interface Owner {
  id: string;
  name: string;
}

/** What all extensions' instructions can add up to in one prompt, so a model on this computer has room left. */
export const EXTENSION_INSTRUCTIONS_BUDGET = 600;

/** One extension's instructions for the DJ. */
export interface ExtensionInstructions {
  owner: Owner;
  text: string;
}

/** A segment an extension adds: a kind of set the DJ plays from the listener's own songs. */
export interface DjSegmentSpec {
  /** Unique within the extension: adding one with the same id replaces it. 1 to 40 of A-Z, a-z, 0-9, ".", "_" and
   * "-". */
  id: string;
  /** Its name, when the model doesn't give one. */
  label: string;
  /** What it is, for the model ("songs under three minutes"). */
  brief: string;
  /** How a template line brings it in ("some short songs"); the label by default. */
  phrase?: string;
  /** Whether one of the listener's songs belongs in it. */
  fits: (song: DjSongView) => boolean;
}

/** How long an extension's segment's name and phrase can be. */
export const SEGMENT_LABEL_MAX = 40;
export const SEGMENT_PHRASE_MAX = 80;
/** How many segments one extension can add. */
export const EXTENSION_SEGMENTS_MAX = 3;
/** An extension's segment's own id: a short word, kept in the DJ's memory with each set from it. */
const SEGMENT_ID = /^[A-Za-z0-9._-]{1,40}$/;

/** A segment's name or phrase as the DJ can say it, and quote in a prompt: on one line, with no quote marks to end the
 * quote early, and cut to `max`. */
function sayable(text: unknown, max: number): string {
  return cut(cleanTalk(String(text ?? "").replace(/["“”]/g, "")), max).trim();
}

/** Whether `x` is a promise, or something like one. */
function isThenable(x: unknown): boolean {
  return (typeof x === "object" || typeof x === "function") && x !== null && typeof (x as { then?: unknown }).then === "function";
}

/** A segment an extension added, as the DJ plays it. */
export interface ExtensionSegment {
  owner: Owner;
  segment: Segment;
}

/** What extensions add to the DJ. */
class DjExtensions {
  /** Each extension's instructions, in the order they were first given. */
  instructions = $state.raw<ExtensionInstructions[]>([]);

  // What changes these lists reads them too, untracked: an extension may call it from inside `ns.watch`, which would
  // otherwise run again on its own change, again and again.

  /** Sets `owner`'s instructions, in place of any it gave before; empty ones, or ones of nothing but quote marks, clear
   * them. The entry, if any: the same one when they say what they said. */
  setInstructions(owner: Owner, text: string): ExtensionInstructions | null {
    return untrack(() => {
      const clean = cut(text.trim(), EXTENSION_INSTRUCTIONS_MAX).trim();
      const had = this.instructions.find((x) => x.owner.id === owner.id);
      if (had && had.text === clean) return had;
      const entry = fence(clean, EXTENSION_INSTRUCTIONS_MAX).length ? { owner, text: clean } : null;
      if (!had) this.instructions = entry ? [...this.instructions, entry] : this.instructions;
      else this.instructions = this.instructions.flatMap((x) => (x !== had ? [x] : entry ? [entry] : []));
      return entry;
    });
  }

  /** Takes `entry` away, if it's still its extension's. */
  removeInstructions(entry: ExtensionInstructions) {
    untrack(() => (this.instructions = this.instructions.filter((x) => x !== entry)));
  }

  /** The segments extensions added, in the order they were first added. */
  segments = $state.raw<ExtensionSegment[]>([]);

  /** Adds `owner`'s segment `spec`, in place of the one with the same id. Throws for one without a short word for an id
   * or without `fits`, or one past `EXTENSION_SEGMENTS_MAX`. Its name and phrase are cleaned for the DJ to say, and its
   * brief falls back to its name; a `fits` that throws, or answers with a promise, doesn't fit, and is reported once. */
  addSegment(owner: Owner, spec: DjSegmentSpec): ExtensionSegment {
    return untrack(() => {
      const own = String(spec?.id ?? "");
      if (!SEGMENT_ID.test(own)) throw new Error("A DJ segment's id is 1 to 40 of A-Z, a-z, 0-9, '.', '_' and '-'");
      const fits = spec.fits;
      if (typeof fits !== "function") throw new Error("A DJ segment needs a fits(song) function");
      const id: SegmentId = `ext:${owner.id}/${own}`;
      const others = this.segments.filter((x) => x.owner.id === owner.id && x.segment.id !== id);
      if (others.length >= EXTENSION_SEGMENTS_MAX) throw new Error(`An extension can add up to ${EXTENSION_SEGMENTS_MAX} DJ segments`);
      const label = sayable(spec.label, SEGMENT_LABEL_MAX) || own;
      const told = cut(String(spec.brief ?? "").trim(), SEGMENT_BRIEF_MAX).trim();
      const brief = fence(told, SEGMENT_BRIEF_MAX).length ? told : label;
      const phrase = sayable(spec.phrase, SEGMENT_PHRASE_MAX) || label;
      let failed = false;
      const segment: Segment = {
        id,
        label,
        brief,
        phrase,
        from: owner.name,
        fits: (c) => {
          try {
            const answer: unknown = fits(songView(c));
            if (isThenable(answer)) {
              // Whatever it comes to is too late, and a failure needs no telling again.
              Promise.resolve(answer).catch(() => {});
              throw new Error("fits(song) has to answer at once, not with a promise");
            }
            return !!answer;
          } catch (e) {
            if (!failed) console.error(`[${owner.name}] the DJ segment "${label}" couldn't tell whether a song fits`, e);
            failed = true;
            return false;
          }
        },
      };
      const entry = { owner, segment };
      const had = this.segments.some((x) => x.segment.id === id);
      this.segments = had ? this.segments.map((x) => (x.segment.id === id ? entry : x)) : [...this.segments, entry];
      return entry;
    });
  }

  /** Takes `entry` away, if it's still there. */
  removeSegment(entry: ExtensionSegment) {
    untrack(() => (this.segments = this.segments.filter((x) => x !== entry)));
  }

  /** The segments extensions added, for the DJ to take turns with its own in one pick: each asks its extension once a
   * song, so one that changes its mind can't count songs it then doesn't give. */
  promptSegments(): Segment[] {
    return this.segments.map(({ segment }) => {
      const answers = new Map<string, boolean>();
      return {
        ...segment,
        fits: (c) => {
          let fits = answers.get(c.uri);
          if (fits === undefined) answers.set(c.uri, (fits = segment.fits(c)));
          return fits;
        },
      };
    });
  }

  /** Whether a song fits the extension segment `id`, for a set picked from it as it goes; null for one that isn't an
   * extension's, or is gone. */
  fitsFor(id: string): ((c: Candidate) => boolean) | null {
    return this.segments.find((x) => x.segment.id === id)?.segment.fits ?? null;
  }

  /** The instructions the model is told: in order, as many as fit in `EXTENSION_INSTRUCTIONS_BUDGET`. One that
   * doesn't fit waits for room. */
  promptInstructions(): ExtensionInstructions[] {
    let room = EXTENSION_INSTRUCTIONS_BUDGET;
    return this.instructions.filter((x) => {
      if (x.text.length > room) return false;
      room -= x.text.length;
      return true;
    });
  }
}

export const djExtensions = new DjExtensions();

/** The DJ, as far as extensions see it. */
export interface DjSource {
  readonly phase: "off" | "starting" | "on";
  readonly ready: boolean;
  readonly current: DjSet | null;
  readonly upNext: DjSet | null;
  readonly onAir: OnAir | null;
  readonly said: SaidLine[];
  readonly speaking: boolean;
  readonly showing: boolean;
  readonly requested: string | null;
  readonly requestedBy: { id: string; name: string } | null;
  on(fn: (event: DjEvent) => void): () => void;
  request(text: string, from?: { id: string; name: string }): boolean;
  cancelRequest(from?: { id: string; name: string }): void;
}

/** `ns.dj`. Its state is reactive, as `ns.player`'s is: read it in `ns.watch`. */
export interface DjExtensionApi {
  /** "off", "starting" (getting its first set ready) or "on". */
  readonly phase: "off" | "starting" | "on";
  /** Turned on, with everything it needs downloaded and set up. */
  readonly ready: boolean;
  /** The set playing now, and the one after it once it's picked. */
  readonly current: DjSetView | null;
  readonly upNext: DjSetView | null;
  /** The DJ's talk while it's on. */
  readonly onAir: DjOnAirView | null;
  /** What it said this session, oldest first. */
  readonly said: readonly DjLineView[];
  /** Its voice is reading a line out; or a line shows without it (Just play, or the voice failed). */
  readonly speaking: boolean;
  readonly showing: boolean;
  /** What the next set is asked to be, until a set for it comes on; and the extension that asked, by name, or null
   * when it was the listener. */
  readonly requested: string | null;
  readonly requestedBy: string | null;
  /** Asks for the next set, as the listener can on the DJ page: in place of a next set it hasn't started to bring in,
   * or as the set after it. Only while the DJ is on and nothing else is asked for; the listener's own request takes
   * the place of one. Whether it was taken. A request it hasn't played is taken back when the extension is turned
   * off. */
  request(text: string): boolean;
  /** Takes back the extension's request; a set already picked for it stays. */
  cancelRequest(): void;
  /** Calls `fn` with each thing that happens in a session, just after it happens. Returns a function that stops it. */
  on(fn: (event: DjExtensionEvent) => void): () => void;
  /** Adds an entry to every set's menu on the DJ page. Returns a remove function. */
  addSetAction(item: AddedItem<DjSetView>): () => void;
  /** Tells the DJ how to talk or what to play, as the listener's own instructions do, after them: one set of
   * instructions per extension, in place of any it gave before, up to `EXTENSION_INSTRUCTIONS_MAX` characters. An
   * empty string takes them back. Returns a remove function. */
  setInstructions(text: string): () => void;
  /** Adds a kind of set the DJ plays from the listener's own songs, taking turns with its own; up to
   * `EXTENSION_SEGMENTS_MAX`, and one with the same id replaces it. Returns a remove function. */
  addSegment(spec: DjSegmentSpec): () => void;
}

/** How the API an extension is handed keeps track of what it adds: `track` takes how to undo something, to run when
 * the extension is turned off, and returns its remover; `live` is false once it's turned off, when nothing more is
 * added. */
export interface Tracker {
  track: (undo: () => void) => () => void;
  live: () => boolean;
}

/** `ns.dj` for the extension `owner`. `addSetAction` adds to the DJ page's set menus (djMenu.ts). */
export function djApi(
  dj: DjSource,
  owner: Owner,
  { track, live }: Tracker,
  addSetAction: (item: AddedItem<DjSet>) => () => void,
): DjExtensionApi {
  const none = () => {};
  /** The extension's instructions, and what takes them back; the remover of those it gave before has nothing to do
   * once they're replaced. */
  let instructions: ExtensionInstructions | null = null;
  let untrackInstructions = none;
  /** The same for each of its segments, by id. */
  const untrackSegment = new Map<string, () => void>();
  return Object.freeze({
    get phase() {
      return dj.phase;
    },
    get ready() {
      return dj.ready;
    },
    get current() {
      return dj.current && setView(dj.current);
    },
    get upNext() {
      return dj.upNext && setView(dj.upNext);
    },
    get onAir() {
      return dj.onAir && onAirView(dj.onAir);
    },
    get said() {
      return copy(lineLists, dj.said, (said) => said.map(lineView));
    },
    get speaking() {
      return dj.speaking;
    },
    get showing() {
      return dj.showing;
    },
    get requested() {
      return dj.requested;
    },
    get requestedBy() {
      return dj.requestedBy?.name ?? null;
    },
    request(text: string) {
      if (!live() || !dj.request(String(text), owner)) return false;
      track(() => dj.cancelRequest(owner));
      return true;
    },
    cancelRequest() {
      dj.cancelRequest(owner);
    },
    on(fn: (event: DjExtensionEvent) => void) {
      if (!live()) return none;
      let listening = true;
      const off = dj.on((e) => {
        const event = eventView(e);
        queueMicrotask(() => {
          if (!listening) return;
          try {
            fn(event);
          } catch (err) {
            console.error(`[${owner.name}] a DJ event listener failed`, err);
          }
        });
      });
      return track(() => {
        listening = false;
        off();
      });
    },
    addSetAction(item: AddedItem<DjSetView>) {
      if (!live()) return none;
      const { label, when, action } = item;
      return track(
        addSetAction({
          label: typeof label === "function" ? (set) => label(setView(set)) : label,
          when: when && ((set) => when(setView(set))),
          action: (set) => action(setView(set)),
        }),
      );
    },
    setInstructions(text: string) {
      if (!live()) return none;
      const entry = djExtensions.setInstructions(owner, String(text ?? ""));
      // The same as before: kept, with its remover.
      if (entry && entry === instructions) return untrackInstructions;
      const before = untrackInstructions;
      instructions = entry;
      untrackInstructions = entry ? track(() => djExtensions.removeInstructions(entry)) : none;
      before();
      return untrackInstructions;
    },
    addSegment(spec: DjSegmentSpec) {
      if (!live()) return none;
      const entry = djExtensions.addSegment(owner, spec);
      const before = untrackSegment.get(entry.segment.id);
      const remove = track(() => djExtensions.removeSegment(entry));
      untrackSegment.set(entry.segment.id, remove);
      before?.();
      return remove;
    },
  });
}
