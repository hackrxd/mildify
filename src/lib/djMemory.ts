// What the DJ keeps in localStorage: its settings, and its memory across sessions.

/** Where the songs the DJ played were kept before it had a memory: read once, into it. */
export const PLAYED_KEY = "nativify:djPlayed";
/** Songs the DJ played this recently aren't picked again in a new session. */
export const PLAYED_MEMORY_MS = 3 * 24 * 60 * 60 * 1000;

export function load<T>(key: string, fallback: T, read: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : read(raw);
  } catch {
    return fallback;
  }
}

export function persist(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applies for this session.
  }
}

/** The songs kept under PLAYED_KEY, by URI, that are recent enough to remember. */
function oldPlayed(now: number): Map<string, number> {
  const raw = load<unknown>(PLAYED_KEY, {}, JSON.parse);
  const out = new Map<string, number>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [uri, at] of Object.entries(raw)) {
      if (typeof at === "number" && now - at < KEEP.played.ms) out.set(uri, at);
    }
  }
  return out;
}

/** The DJ's memory across sessions, one per Spotify account: what it played, which songs were skipped and liked
 * while it played them, how its sets went, and how it opened. Old entries fade and drop out, each list keeps only so
 * many, and the whole stays under MEMORY_MAX_BYTES. It's kept in this computer's web storage. */
export const MEMORY_KEY = "nativify:djMemory";
export const MEMORY_MAX_BYTES = 128 * 1024;
const VERSION = 1;
const DAY = 24 * 60 * 60 * 1000;
/** Entries dated later than this ahead of the clock are dropped: the clock was wrong when they were written. */
const AHEAD_MS = DAY;

/** Where the memory of `user`'s account is kept. */
export function memoryKey(user: string | null): string {
  return user ? `${MEMORY_KEY}:${user}` : MEMORY_KEY;
}

/** How long each kind of memory lasts, and how many entries it keeps, newest first. */
export const KEEP = {
  played: { ms: 30 * DAY, max: 1000 },
  songSkips: { ms: 90 * DAY, max: 300 },
  artistSkips: { ms: 60 * DAY, max: 300 },
  likes: { ms: 365 * DAY, max: 300 },
  sets: { ms: 60 * DAY, max: 200 },
  openings: { ms: 30 * DAY, max: 10 },
};
/** Skips kept for one song, and for one artist. */
const SKIPS_PER_SONG = 3;
const SKIPS_PER_ARTIST = 6;

/** How fast memories fade: their weight halves this often. */
export const SONG_SKIP_HALF_LIFE = 21 * DAY;
export const ARTIST_SKIP_HALF_LIFE = 4 * DAY;
export const LOVE_HALF_LIFE = 90 * DAY;
/** A featured artist's share in the skip of a song they're on; the main artist's is 1. */
export const FEATURED_SKIP = 0.35;
/** A song is left out while its skips count this much: for a half-life after a skip. */
const SONG_LEFT_OUT = 0.5;
/** An artist is left out while their skips count this much: for a day after two skips as the main artist. */
const ARTIST_LEFT_OUT = 2 * Math.pow(0.5, DAY / ARTIST_SKIP_HALF_LIFE);

/** How a set went. */
export interface SetRecord {
  /** Its segment's id, whatever made it: one an extension or a playlist adds is kept as it is. */
  segment: string;
  at: number;
  /** The part of the day it started in. */
  part: string;
  /** Songs started, skipped and liked in it. */
  songs: number;
  skips: number;
  likes: number;
  /** The listener skipped the rest of it. */
  skipped: boolean;
  /** The listener asked for it. */
  request: boolean;
}

/** The first line of a session, without the name the listener was called. */
export interface OpeningRecord {
  at: number;
  talk: string;
  byModel: boolean;
}

/** What a set's record notes as the set goes; "unskip" takes a skip back. */
export type SetNote = "song" | "skip" | "unskip" | "like" | "skipped";

const isTime = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const isText = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/** The entries of a list kept as `[key, value]` pairs, those `valid` takes; the rest are dropped. */
function entries<V>(raw: unknown, valid: (v: unknown) => v is V): [string, V][] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is [string, V] => Array.isArray(e) && e.length === 2 && isText(e[0]) && valid(e[1]));
}

const isTimes = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every(isTime);
const isWeight = (w: unknown): w is number => typeof w === "number" && w > 0 && w <= 1;
const isWeighted = (v: unknown): v is [number, number][] =>
  Array.isArray(v) && v.length > 0 && v.every((w) => Array.isArray(w) && w.length === 2 && isTime(w[0]) && isWeight(w[1]));
const isLike = (v: unknown): v is { at: number; artists: string[] } =>
  typeof v === "object" && v !== null && isTime((v as { at: unknown }).at) && Array.isArray((v as { artists: unknown }).artists) && (v as { artists: unknown[] }).artists.every(isText);
const isSet = (v: unknown): v is SetRecord => {
  const r = v as Partial<SetRecord> | null;
  return (
    typeof r === "object" && r !== null && isText(r.segment) && isTime(r.at) && typeof r.part === "string" &&
    [r.songs, r.skips, r.likes].every((n) => Number.isInteger(n) && (n as number) >= 0) &&
    typeof r.skipped === "boolean" && typeof r.request === "boolean"
  );
};
const isOpening = (v: unknown): v is OpeningRecord => {
  const r = v as Partial<OpeningRecord> | null;
  return typeof r === "object" && r !== null && isTime(r.at) && isText(r.talk) && typeof r.byModel === "boolean";
};

/** How long `text` is in UTF-8. */
function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Halves every `halfLife`: 1 for now, 0.5 a half-life ago. */
function fade(at: number, now: number, halfLife: number): number {
  return Math.pow(0.5, Math.max(0, now - at) / halfLife);
}

export class DjMemory {
  #played = new Map<string, number>();
  #songSkips = new Map<string, number[]>();
  #artistSkips = new Map<string, [number, number][]>();
  #likes = new Map<string, { at: number; artists: string[] }>();
  #sets = new Map<string, SetRecord>();
  #openings: OpeningRecord[] = [];
  #key: string;

  /** Reads what was kept for `user`'s account, leaving out what can't be read or is too old. The first account's
   * also takes in the songs the DJ remembered playing before it had this memory. */
  constructor({ user = null, now = Date.now() }: { user?: string | null; now?: number } = {}) {
    this.#key = memoryKey(user);
    const doc = load<Record<string, unknown> | null>(this.#key, null, (raw) => {
      const d = JSON.parse(raw);
      return typeof d === "object" && d !== null && d.v === VERSION ? d : null;
    });
    if (doc) {
      this.#played = new Map(entries(doc.played, isTime));
      this.#songSkips = new Map(entries(doc.songSkips, isTimes));
      this.#artistSkips = new Map(entries(doc.artistSkips, isWeighted));
      this.#likes = new Map(entries(doc.likes, isLike));
      this.#sets = new Map(entries(doc.sets, isSet));
      this.#openings = Array.isArray(doc.openings) ? doc.openings.filter(isOpening) : [];
    }
    const before = user ? oldPlayed(now) : new Map<string, number>();
    for (const [uri, at] of before) if (at > (this.#played.get(uri) ?? 0)) this.#played.set(uri, at);
    this.#played = new Map([...this.#played].sort((a, b) => a[1] - b[1]));
    // Read once, whatever it held.
    if (user && load(PLAYED_KEY, null, (raw) => raw) !== null) persist(PLAYED_KEY, null);
    this.#prune(now, true);
    if (doc || before.size) this.#save(now);
  }

  /** The DJ played `uri`. */
  played(uri: string, now = Date.now()) {
    this.#played.delete(uri);
    this.#played.set(uri, now);
    this.#save(now);
  }

  /** The songs the DJ played less than `withinMs` ago. */
  playedWithin(withinMs: number, now = Date.now()): Set<string> {
    return new Set([...this.#played].filter(([, at]) => now - at < withinMs).map(([uri]) => uri));
  }

  /** How long ago the DJ last played `uri`, if it remembers. */
  playedAgo(uri: string, now = Date.now()): number | null {
    const at = this.#played.get(uri);
    return at === undefined ? null : Math.max(0, now - at);
  }

  /** The listener skipped `song`: the song, its main artist, and lightly any artist featured on it. */
  skipped(song: { uri: string; artists: string[] }, now = Date.now()) {
    const times = [...(this.#songSkips.get(song.uri) ?? []), now].slice(-SKIPS_PER_SONG);
    this.#songSkips.delete(song.uri);
    this.#songSkips.set(song.uri, times);
    song.artists.forEach((name, i) => {
      const skips: [number, number][] = [...(this.#artistSkips.get(name) ?? []), [now, i === 0 ? 1 : FEATURED_SKIP]];
      this.#artistSkips.delete(name);
      this.#artistSkips.set(name, skips.slice(-SKIPS_PER_ARTIST));
    });
    this.#save(now);
  }

  /** Takes back the last skip of `song`, and its artists' share in it. */
  unskipped(song: { uri: string; artists: string[] }, now = Date.now()) {
    const times = this.#songSkips.get(song.uri);
    const at = times?.at(-1);
    if (!times || at === undefined) return;
    if (times.length > 1) this.#songSkips.set(song.uri, times.slice(0, -1));
    else this.#songSkips.delete(song.uri);
    for (const name of song.artists) {
      const left = (this.#artistSkips.get(name) ?? []).filter(([t]) => t !== at);
      if (left.length) this.#artistSkips.set(name, left);
      else this.#artistSkips.delete(name);
    }
    this.#save(now);
  }

  /** The listener liked `song` while the DJ played it. */
  liked(song: { uri: string; artists: string[] }, now = Date.now()) {
    this.#likes.delete(song.uri);
    this.#likes.set(song.uri, { at: now, artists: [...song.artists] });
    this.#save(now);
  }

  /** How much skipping `uri` still counts: 1 for each skip just now, fading over weeks. */
  songSkip(uri: string, now = Date.now()): number {
    return (this.#songSkips.get(uri) ?? []).reduce((n, at) => n + fade(at, now, SONG_SKIP_HALF_LIFE), 0);
  }

  /** How much skipping `name`'s songs still counts: fading over days, a featured artist's skips less. */
  artistSkip(name: string, now = Date.now()): number {
    return (this.#artistSkips.get(name) ?? []).reduce((n, [at, w]) => n + w * fade(at, now, ARTIST_SKIP_HALF_LIFE), 0);
  }

  /** Songs skipped too lately to offer again: once in the last three weeks, twice in the last six. */
  leftOutSongs(now = Date.now()): Set<string> {
    return new Set([...this.#songSkips.keys()].filter((uri) => this.songSkip(uri, now) >= SONG_LEFT_OUT));
  }

  /** Artists skipped too much lately to offer again: twice as the main artist in the last day, three times in the
   * last three days. */
  leftOutArtists(now = Date.now()): Set<string> {
    return new Set([...this.#artistSkips.keys()].filter((name) => this.artistSkip(name, now) >= ARTIST_LEFT_OUT));
  }

  /** How much the listener has liked `name`'s songs while the DJ played them, fading over months. */
  artistLove(name: string, now = Date.now()): number {
    let n = 0;
    for (const like of this.#likes.values()) if (like.artists.includes(name)) n += fade(like.at, now, LOVE_HALF_LIFE);
    return n;
  }

  /** A set started; `key` names it for the notes that follow (a session's start and the set's id). */
  setStarted(key: string, set: { segment: string; part: string; request: boolean }, now = Date.now()) {
    this.#sets.delete(key);
    this.#sets.set(key, { ...set, at: now, songs: 0, skips: 0, likes: 0, skipped: false });
    this.#save(now);
  }

  /** Something happened in the set `key` names. */
  noteSet(key: string, what: SetNote, now = Date.now()) {
    const r = this.#sets.get(key);
    if (!r) return;
    if (what === "song") r.songs++;
    else if (what === "skip") r.skips++;
    else if (what === "unskip") r.skips = Math.max(0, r.skips - 1);
    else if (what === "like") r.likes++;
    else r.skipped = true;
    this.#save(now);
  }

  /** How the sets of the last while went, oldest first. */
  sets(now = Date.now()): SetRecord[] {
    return [...this.#sets.values()].filter((r) => now - r.at < KEEP.sets.ms).map((r) => ({ ...r }));
  }

  /** The session opened with `line`, said without the listener's name. */
  opened(line: { talk: string; byModel: boolean }, now = Date.now()) {
    this.#openings = [...this.#openings, { at: now, talk: line.talk, byModel: line.byModel }];
    this.#save(now);
  }

  /** How the last `n` sessions opened, oldest first. */
  lastOpenings(n: number, now = Date.now()): OpeningRecord[] {
    return this.#openings.filter((o) => now - o.at < KEEP.openings.ms).slice(-n);
  }

  /** Forgets all of it. */
  forget() {
    this.#played.clear();
    this.#songSkips.clear();
    this.#artistSkips.clear();
    this.#likes.clear();
    this.#sets.clear();
    this.#openings = [];
    persist(this.#key, null);
  }

  /** Drops what's older than it's kept, and the oldest past each list's limit; as it's read, also what's dated too
   * far `ahead` of the clock. */
  #prune(now: number, ahead = false) {
    const fresh = (at: number, keep: { ms: number }) => now - at < keep.ms && !(ahead && at - now > AHEAD_MS);
    const keepMap = <V>(map: Map<string, V>, keep: { ms: number; max: number }, at: (v: V) => number) =>
      new Map([...map].filter(([, v]) => fresh(at(v), keep)).slice(-keep.max));
    this.#played = keepMap(this.#played, KEEP.played, (at) => at);
    this.#songSkips = keepMap(this.#songSkips, KEEP.songSkips, (t) => t[t.length - 1]);
    this.#artistSkips = keepMap(this.#artistSkips, KEEP.artistSkips, (s) => s[s.length - 1][0]);
    this.#likes = keepMap(this.#likes, KEEP.likes, (l) => l.at);
    this.#sets = keepMap(this.#sets, KEEP.sets, (r) => r.at);
    this.#openings = this.#openings.filter((o) => fresh(o.at, KEEP.openings)).slice(-KEEP.openings.max);
  }

  #doc(): string {
    return JSON.stringify({
      v: VERSION,
      played: [...this.#played],
      songSkips: [...this.#songSkips],
      artistSkips: [...this.#artistSkips],
      likes: [...this.#likes],
      sets: [...this.#sets],
      openings: this.#openings,
    });
  }

  /** Writes it all back, the oldest of the longest list going first while it's too big. */
  #save(now: number) {
    this.#prune(now);
    let doc = this.#doc();
    while (bytes(doc) > MEMORY_MAX_BYTES) {
      const lists = [this.#played, this.#songSkips, this.#artistSkips, this.#likes, this.#sets] as Map<string, unknown>[];
      const longest = lists.reduce((a, b) => (b.size > a.size ? b : a));
      if (longest.size >= this.#openings.length && longest.size > 0) {
        for (const key of [...longest.keys()].slice(0, Math.ceil(longest.size / 10))) longest.delete(key);
      } else if (this.#openings.length) {
        this.#openings = this.#openings.slice(Math.ceil(this.#openings.length / 10));
      } else break;
      doc = this.#doc();
    }
    persist(this.#key, doc);
  }
}
