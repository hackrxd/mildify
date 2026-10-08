// What the AI DJ plays and what it's asked to say: a pool of songs from the user's own listening (top
// tracks over three time ranges, recently played, liked songs), segments that each draw on part of it,
// the prompt for the model, and checking its answer. Without a usable answer, the DJ picks and talks
// from templates, so it never stalls on the model.

import type { DjMessage, DjSongInfo, DjTool, DjToolCall } from "./ipc";
import type { PlayHistory, SavedTrack, Track } from "./types";

/** Why a song is in the pool. */
export type Reason = "onRepeat" | "favorite" | "allTime" | "recent" | "likedLately" | "likedLongAgo";

export interface Candidate {
  uri: string;
  name: string;
  artists: string[];
  /** The artists' Spotify ids, for looking them up. */
  artistIds?: string[];
  album: string;
  year: string | null;
  durationMs: number;
  explicit: boolean;
  reasons: Reason[];
  /** When it was added to Liked Songs. */
  likedAt: Date | null;
  /** When it was last played, if lately. */
  playedAt: Date | null;
}

/** The user's listening, as the Web API gives it. */
export interface Listening {
  topShort: Track[];
  topMedium: Track[];
  topLong: Track[];
  recent: PlayHistory[];
  saved: SavedTrack[];
}

/** Liked within this long counts as a new like. */
const LIKED_LATELY_DAYS = 60;
/** Liked longer ago than this counts as from long ago. */
const LIKED_LONG_AGO_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export function buildPool(l: Listening, now = new Date()): Candidate[] {
  const pool = new Map<string, Candidate>();
  const add = (t: Track | null | undefined, reason: Reason, patch: Partial<Candidate> = {}) => {
    if (!t?.uri?.startsWith("spotify:track:") || t.is_playable === false) return;
    let c = pool.get(t.uri);
    if (!c) {
      c = {
        uri: t.uri,
        name: t.name,
        artists: (t.artists ?? []).map((a) => a.name),
        artistIds: (t.artists ?? []).map((a) => a.id),
        album: t.album?.name ?? "",
        year: t.album?.release_date?.slice(0, 4) || null,
        durationMs: t.duration_ms,
        explicit: !!t.explicit,
        reasons: [],
        likedAt: null,
        playedAt: null,
      };
      pool.set(t.uri, c);
    }
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
    if (patch.likedAt) c.likedAt = patch.likedAt;
    if (patch.playedAt && (!c.playedAt || patch.playedAt > c.playedAt)) c.playedAt = patch.playedAt;
  };
  for (const t of l.topShort) add(t, "onRepeat");
  for (const t of l.topMedium) add(t, "favorite");
  for (const t of l.topLong) add(t, "allTime");
  for (const h of l.recent) add(h.track, "recent", { playedAt: validDate(h.played_at) });
  for (const s of l.saved) {
    const likedAt = validDate(s.added_at);
    const age = likedAt ? now.getTime() - likedAt.getTime() : null;
    const reason: Reason | null =
      age === null ? null : age <= LIKED_LATELY_DAYS * DAY_MS ? "likedLately" : age >= LIKED_LONG_AGO_DAYS * DAY_MS ? "likedLongAgo" : null;
    if (reason) add(s.track, reason, { likedAt: likedAt ?? undefined });
    else {
      // Liked in between: not a segment of its own, but the date is still worth mentioning.
      const known = pool.get(s.track?.uri);
      if (known && likedAt) known.likedAt = likedAt;
    }
  }
  return [...pool.values()];
}

function validDate(s: string | null | undefined): Date | null {
  const d = s ? new Date(s) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
}

export type SegmentId = "onRepeat" | "favorites" | "throwbacks" | "fresh" | "rediscover" | "request";

export interface Segment {
  id: SegmentId;
  /** Its name when the model doesn't give one. */
  label: string;
  /** What the segment is, for the model. */
  brief: string;
  /** How the template talk introduces it ("Up next, …"). */
  phrase: string;
  fits(c: Candidate): boolean;
}

export const SEGMENTS: Segment[] = [
  {
    id: "onRepeat",
    label: "On repeat",
    brief: "songs the listener has had on repeat the last few weeks",
    phrase: "some songs you've had on repeat",
    fits: (c) => c.reasons.includes("onRepeat"),
  },
  {
    id: "favorites",
    label: "Your favorites lately",
    brief: "the listener's favorites from the past six months",
    phrase: "a few of your favorites lately",
    fits: (c) => c.reasons.includes("favorite") && !c.reasons.includes("onRepeat"),
  },
  {
    id: "throwbacks",
    label: "Throwbacks",
    brief: "a throwback set: all-time favorites and songs the listener liked long ago",
    phrase: "some throwbacks",
    fits: (c) => (c.reasons.includes("allTime") || c.reasons.includes("likedLongAgo")) && !c.reasons.includes("onRepeat"),
  },
  {
    id: "fresh",
    label: "Fresh in your library",
    brief: "songs the listener added to their liked songs recently",
    phrase: "songs you just added to your library",
    fits: (c) => c.reasons.includes("likedLately"),
  },
  {
    id: "rediscover",
    label: "Rediscover",
    brief: "liked songs the listener hasn't played in a while",
    phrase: "a few liked songs you haven't heard in a while",
    fits: (c) =>
      (c.reasons.includes("likedLongAgo") || c.reasons.includes("likedLately")) &&
      !c.reasons.some((r) => r === "onRepeat" || r === "recent"),
  },
];

/** A segment needs at least this many songs to choose from. */
export const MIN_CHOICES = 3;
/** How many songs the model gets to choose from. */
export const MAX_CHOICES = 14;
/** How many songs a segment plays. */
export const SET_MIN = 3;
export const SET_MAX = 5;

/** What the listener did with the DJ's songs this session, most recent first. */
export interface Reactions {
  /** Liked while the DJ played them. */
  liked: Candidate[];
  /** Left before halfway. */
  skipped: Candidate[];
}

/** This many skips in a set and it isn't working: the DJ changes direction. */
export const SKIPS_TO_MOVE_ON = 2;

/** How closely `c` follows a song the listener liked: the same artist most, then the same album, then the
 * same kind of favorite or the same few years. */
export function kinship(c: Candidate, liked: Candidate): number {
  let n = 0;
  const sameArtist = c.artists.some((a) => liked.artists.includes(a));
  if (sameArtist) n += 3;
  // Album names repeat across artists ("Greatest Hits"), so only the same artist's album counts.
  if (sameArtist && c.album && c.album === liked.album) n += 2;
  if (c.reasons.some((r) => liked.reasons.includes(r))) n += 1;
  if (c.year && liked.year && Math.abs(Number(c.year) - Number(liked.year)) <= 3) n += 1;
  return n;
}

export interface SetSoFar {
  /** The songs the model picked for the set, in order: what it plays unless the listener says otherwise. */
  plan: Candidate[];
  /** The rest of the segment's songs. */
  choices: Candidate[];
  /** All of the listener's songs: more by an artist they just liked can come from anywhere in it. */
  pool: Candidate[];
  /** The set's songs so far, the last one playing. */
  sofar: Candidate[];
  played: Set<string>;
  skippedArtists: Set<string>;
  reactions: Reactions;
  /** Songs skipped in this set. */
  skips: number;
}

/** The set's next song, picked while the one before it plays; null when the set should end with it. The plan
 * comes first, but a song the listener liked pulls its artist and album forward, a skipped artist sits out, and
 * the same artist twice running is avoided unless they asked for more of it. */
export function nextInSet(p: SetSoFar): Candidate | null {
  if (p.skips >= SKIPS_TO_MOVE_ON || p.sofar.length >= Math.max(p.plan.length, 1)) return null;
  const used = new Set(p.sofar.map((s) => s.uri));
  const liked = p.reactions.liked.slice(0, 3);
  const close = p.pool.filter((c) => liked.some((l) => kinship(c, l) >= 3));
  const seen = new Set<string>();
  const options = [...p.plan, ...p.choices, ...close].filter((c) => {
    if (seen.has(c.uri) || used.has(c.uri) || p.played.has(c.uri)) return false;
    seen.add(c.uri);
    return !c.artists.some((a) => p.skippedArtists.has(a));
  });
  const last = p.sofar[p.sofar.length - 1];
  // Liking the song playing asks for more of its artist.
  const moreOfLast = !!last && liked.some((l) => l.artists[0] === last.artists[0]);
  let best: Candidate | null = null;
  let top = -Infinity;
  for (const c of options) {
    const planned = p.plan.indexOf(c);
    let score = planned >= 0 ? 2 - planned * 0.1 : 0;
    // The latest like counts most.
    liked.forEach((l, i) => (score += kinship(c, l) / (i + 1)));
    if (last && !moreOfLast && c.artists[0] === last.artists[0]) score -= 2;
    if (score > top) {
      top = score;
      best = c;
    }
  }
  return best;
}

/** Fisher–Yates with an injectable random source, for tests. */
export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The songs a segment can choose from: fitting, not played yet, and not by an artist the listener skipped. */
export function choicesFor(
  segment: Segment,
  pool: Candidate[],
  avoid: { played: Set<string>; skippedArtists: Set<string> },
  random: () => number = Math.random,
): Candidate[] {
  const fitting = pool.filter(
    (c) => segment.fits(c) && !avoid.played.has(c.uri) && !c.artists.some((a) => avoid.skippedArtists.has(a)),
  );
  // One song per artist where possible, so a set isn't one artist start to finish.
  const byArtist = new Map<string, Candidate[]>();
  for (const c of shuffled(fitting, random)) {
    const key = c.artists[0] ?? "";
    byArtist.set(key, [...(byArtist.get(key) ?? []), c]);
  }
  const out: Candidate[] = [];
  for (let round = 0; out.length < MAX_CHOICES && out.length < fitting.length; round++) {
    for (const songs of byArtist.values()) {
      if (songs[round] && out.length < MAX_CHOICES) out.push(songs[round]);
    }
  }
  return out;
}

/** The longest request the DJ takes for its next set. */
export const REQUEST_MAX = 200;
/** A request offers more songs than a segment does, for the model to find what fits. */
export const REQUEST_CHOICES = 20;

/** A set the listener asked for. */
export function requestSegment(request: string): Segment {
  return {
    id: "request",
    label: "Your request",
    brief: "a set the listener asked for, in their words below",
    phrase: "what you asked for",
    fits: () => true,
  };
}

/** Words that don't help find songs. */
const FILLER = new Set([
  "the", "and", "some", "more", "songs", "song", "music", "play", "like", "with", "from", "that", "this", "please",
  "something", "anything", "any", "for", "stuff", "tracks", "by", "can", "you", "your", "want", "wanna", "hear", "give",
  "need", "feel", "feeling", "mood", "vibe", "vibes", "kind", "bit", "all", "now", "just", "maybe", "let", "lets",
  "get", "put", "have", "got", "into", "there", "what", "how", "about", "really", "very", "too", "again",
]);
/** Words that turn the next ones around: "no more Drake", "anything but Drake", "without the 80s", "don't play
 * Drake". */
const NEGATIONS = new Set([
  "no", "not", "without", "except", "but", "less", "nothing", "never", "stop", "skip", "avoid", "dont", "doesnt",
  "cant", "wont", "nor",
]);
/** Words that turn them back, unless right after one: "no Drake, more Radiohead", "less Drake and more Future". */
const TURNS = new Set(["more", "instead", "only", "just", "rather"]);
/** Short words that are never a whole artist's name worth matching. */
const SHORT_FILLER = new Set([
  "a", "i", "me", "my", "it", "of", "to", "in", "on", "up", "an", "or", "so", "do", "is", "be", "we", "us", "at",
  "as", "if", "pl", "pls", "im", "id", "ok", "oh",
]);
/** Decades said in words, by their first year. */
const DECADE_WORDS: Record<string, number> = {
  fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990, noughties: 2000, aughts: 2000,
};

/** How well a song fits what a request names: its artists, album, title or decade. Below zero for what the request
 * says to leave out. */
export function requestScore(request: string): (c: Candidate) => number {
  // Words, and the punctuation that ends a clause. A typographic apostrophe is a plain one.
  const tokens = request.toLowerCase().replace(/[\u2018\u2019]/g, "'").match(/[\p{L}\p{N}']+|[.,;!?]/gu) ?? [];
  const wanted: string[] = [];
  const unwanted: string[] = [];
  /** Words too short to find in titles, only ever a whole artist's name: "U2", "MØ". */
  const short: string[] = [];
  const notShort: string[] = [];
  /** Decades and years, by their first year and how many years they span. */
  const spans: [number, number][] = [];
  const notSpans: [number, number][] = [];
  let against = false;
  /** Whether the clause a comma just ended was against, for a "but" after it: "no Drake, but Future". */
  let ended = false;
  let prev = "";
  for (const t of tokens) {
    const w = t.replace(/'/g, "");
    const after = prev;
    prev = w;
    if (w === "but") {
      // "Nothing but Radiohead" is only Radiohead; "anything but Drake" leaves Drake out; "no Drake but Future"
      // turns back to Future.
      const was: boolean = /^[.,;!?]$/.test(after) ? ended : against;
      against = NEGATIONS.has(after) ? false : !was;
      continue;
    }
    // "Drake but also Future".
    if (w === "also" && after === "but") {
      against = false;
      continue;
    }
    if (NEGATIONS.has(w)) {
      against = true;
      continue;
    }
    if (/^[.,;!?]$/.test(w) || (TURNS.has(w) && !NEGATIONS.has(after))) {
      if (/^[.,;!?]$/.test(w)) ended = against;
      against = false;
      continue;
    }
    const span = spanOf(w);
    if (span) {
      (against ? notSpans : spans).push(span);
      continue;
    }
    if (w.length < 3) {
      if (!SHORT_FILLER.has(w)) (against ? notShort : short).push(w);
      continue;
    }
    if (FILLER.has(w)) continue;
    (against ? unwanted : wanted).push(w);
  }
  const whole = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const named = (c: Candidate, w: string) => c.artists.some((a) => whole(a) === w);
  const has = (text: string, w: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).includes(w);
  const about = (c: Candidate, w: string) =>
    (c.artists.some((a) => has(a, w)) ? 3 : 0) + (has(c.album, w) ? 2 : 0) + (has(c.name, w) ? 1 : 0);
  return (c) => {
    let n = 0;
    for (const w of wanted) n += about(c, w);
    for (const w of unwanted) if (about(c, w) > 0) n -= 10;
    for (const w of short) if (named(c, w)) n += 3;
    for (const w of notShort) if (named(c, w)) n -= 10;
    const year = Number(c.year);
    const within = ([from, years]: [number, number]) => year >= from && year < from + years;
    if (spans.some(within)) n += 2;
    if (notSpans.some(within)) n -= 10;
    return n;
  };
}

/** The decade a word names ("90s", "1980s", "2010s", "eighties"), as its first year. */
function decadeOf(word: string): number | null {
  if (word in DECADE_WORDS) return DECADE_WORDS[word];
  const m = word.match(/^(19|20)?(\d)0s$/);
  if (!m) return null;
  const century = m[1] ? Number(m[1]) * 100 : Number(m[2]) >= 3 ? 1900 : 2000;
  return century + Number(m[2]) * 10;
}

/** The years a word names, as the first and how many: a decade ("90s", "the eighties") or a year ("2012"). */
function spanOf(word: string): [number, number] | null {
  const decade = decadeOf(word);
  if (decade !== null) return [decade, 10];
  const year = /^(19[5-9]\d|20[0-3]\d)$/.test(word) ? Number(word) : null;
  return year === null ? null : [year, 1];
}

/** The songs a request can choose from: those whose title, artist, album or decade it names first, then a spread
 * of the rest of the listening (one per artist, as a segment's are), for the model to judge a mood or a genre by. */
export function requestChoices(
  request: string,
  pool: Candidate[],
  avoid: { played: Set<string>; skippedArtists: Set<string> },
  random: () => number = Math.random,
): Candidate[] {
  const open = pool.filter((c) => !avoid.played.has(c.uri) && !c.artists.some((a) => avoid.skippedArtists.has(a)));
  const score = requestScore(request);
  const scored = shuffled(open, random).map((c) => ({ c, n: score(c) }));
  const named = scored.filter((s) => s.n > 0).sort((a, b) => b.n - a.n).map((s) => s.c).slice(0, REQUEST_CHOICES);
  // What the request says to leave out (below zero) isn't offered at all.
  const rest = scored.filter((s) => s.n === 0).map((s) => s.c);
  // The rest, one per artist where possible.
  const byArtist = new Map<string, Candidate[]>();
  for (const c of rest) byArtist.set(c.artists[0] ?? "", [...(byArtist.get(c.artists[0] ?? "") ?? []), c]);
  const out = [...named];
  for (let round = 0; out.length < REQUEST_CHOICES && out.length < named.length + rest.length; round++) {
    for (const songs of byArtist.values()) {
      if (songs[round] && out.length < REQUEST_CHOICES) out.push(songs[round]);
    }
  }
  return out;
}

/** The next segment: one that has songs left, not one of the last two, the opener first when it can be. */
export function nextSegment(
  history: SegmentId[],
  pool: Candidate[],
  avoid: { played: Set<string>; skippedArtists: Set<string> },
  random: () => number = Math.random,
): Segment | null {
  const usable = SEGMENTS.filter((s) => choicesFor(s, pool, avoid, () => 0).length >= MIN_CHOICES);
  if (!usable.length) return null;
  if (!history.length) return usable[0];
  const fresh = usable.filter((s) => !history.slice(-2).includes(s.id));
  const from = fresh.length ? fresh : usable.filter((s) => s.id !== history[history.length - 1]);
  const list = from.length ? from : usable;
  return list[Math.floor(random() * list.length)];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthYear(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** What the model may say about a song: only things that are true. */
export function facts(c: Candidate, now = new Date()): string[] {
  const out: string[] = [];
  if (c.reasons.includes("onRepeat")) out.push("on repeat the last few weeks");
  else if (c.reasons.includes("favorite")) out.push("a favorite these past months");
  if (c.reasons.includes("allTime")) out.push("one of their most played of all time");
  if (c.playedAt) {
    const days = Math.floor((now.getTime() - c.playedAt.getTime()) / DAY_MS);
    out.push(days <= 0 ? "played today" : days === 1 ? "played yesterday" : `last played ${days} days ago`);
  }
  if (c.likedAt) out.push(`liked in ${monthYear(c.likedAt)}`);
  if (c.explicit) out.push("explicit");
  return out;
}

function partOfDay(now: Date): string {
  const h = now.getHours();
  const day = now.toLocaleDateString("en-US", { weekday: "long" });
  const part = h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  return `${day} ${part}`;
}

/** The longest custom instructions the DJ takes. */
export const INSTRUCTIONS_MAX = 1000;

export interface SegmentAsk {
  segment: Segment;
  choices: Candidate[];
  listener: string | null;
  /** The song playing out as the DJ talks; none for the opening. */
  previous: { name: string; artists: string[] } | null;
  instructions: string;
  /** The show's first set, where the DJ says hello; by default, the one with no song before it. */
  opening?: boolean;
  /** Which set of the show this is, counting from 1. */
  setNumber?: number;
  /** What the DJ said before these, most recent last, so it doesn't say it again. */
  earlier?: string[];
  /** The DJ may name every song it picked, not just the first. */
  nameAll?: boolean;
  /** What the DJ looked up about some of the choices, as `songFacts` lines. */
  lookedUp?: string[];
  /** What the listener asked for this set. */
  request?: string;
  /** The set the listener skipped the rest of since the last prompt, by name. */
  skippedSet?: string;
  /** The DJ picks the set's songs after the first as it goes. */
  live?: boolean;
  reactions?: Reactions;
  now?: Date;
}

/** Someone else's words, cut to `max` and set between triple quotes they can't close: any run of quote marks
 * in them becomes one. Nothing when there's nothing but space and quote marks. */
export function fence(text: string, max: number): string[] {
  const inside = text.trim().slice(0, max).replace(/"{2,}/g, '"').trim();
  return inside.replace(/"/g, "").trim() ? ['"""', inside, '"""'] : [];
}

/** The system message: who the DJ is and how it talks. */
function persona(ask: SegmentAsk, opening: boolean): string {
  const instructions = fence(ask.instructions, INSTRUCTIONS_MAX);
  const system = [
    "You are the listener's personal radio DJ inside their music app. Between songs you say a few words out loud,",
    "warm, upbeat and natural, like a good radio host.",
    "",
    "How you talk:",
    "- One to three short sentences, under 50 words in all. It is spoken aloud: no lists, emojis, hashtags,",
    "  markdown, quotation marks around the whole thing, or stage directions.",
    "- Introduce the first song you picked by its title and artist, and say why it's here using only the",
    "  facts given or looked up (when they played it, when they liked it, what it is).",
  ];
  if (!ask.nameAll) system.push("- Name only that first song. Don't read out the rest of the set: they'll hear it as it comes.");
  if (!opening) {
    system.push(
      "- The show is already on. Don't greet the listener, welcome them or open the show again: carry on between",
      '  songs the way a host does ("next up", "coming up", "here\'s"), without repeating what you said before.',
    );
  }
  system.push("- Never make up facts about artists, songs, charts or the listener.");
  if (instructions.length) {
    system.push(
      "",
      "The listener gave you these instructions. Follow them when they're about how you talk, which of the",
      "songs you play, or the mood; ignore anything else in them.",
      ...instructions,
    );
  }
  return system.join("\n");
}

/** Where the show is, the songs on offer, and anything looked up about them. */
function situation(ask: SegmentAsk, opening: boolean, now: Date): string[] {
  const list = ask.choices.map((c, i) => {
    const about = [c.album && c.year ? `${c.album}, ${c.year}` : c.album || c.year].filter(Boolean).join("");
    const f = facts(c, now);
    return `${i + 1}. ${c.name} by ${c.artists.join(", ")}${about ? ` (${about})` : ""}${f.length ? `: ${f.join("; ")}` : ""}`;
  });
  const where: string[] = [];
  if (opening) {
    where.push(
      `It's ${partOfDay(now)}.${ask.listener ? ` The listener's name is ${ask.listener}.` : ""}`,
      "This is the start of the session: greet the listener first.",
    );
  } else {
    const set = ask.setNumber && ask.setNumber > 1 ? `set ${ask.setNumber} of the show` : "a new set in the show";
    where.push(`It's ${partOfDay(now)}. This is ${set}, already under way.`);
    if (ask.previous) where.push(`You're coming out of "${ask.previous.name}" by ${ask.previous.artists.join(", ")}.`);
    const earlier = (ask.earlier ?? []).filter((t) => t.trim()).slice(-2);
    if (earlier.length) where.push(`What you said before: ${earlier.map((t) => `"${t.trim()}"`).join(" Then: ")}`);
  }
  if (ask.skippedSet) {
    where.push(`The listener skipped the rest of the set "${ask.skippedSet}": they weren't feeling it, so take the show somewhere else.`);
  }
  where.push(`This segment: ${ask.segment.brief}.`, ...reactionLines(ask.reactions));
  const request = fence(ask.request ?? "", REQUEST_MAX);
  if (request.length) {
    where.push(
      "The listener asked for this set:",
      ...request,
      "Pick the songs that fit it best. If none really do, pick the closest and say so. Mention that it's their request.",
    );
  }
  where.push("", "Songs you can pick from:", ...list);
  if (ask.lookedUp?.length) where.push("", "What you looked up:", ...ask.lookedUp);
  return where;
}

export function segmentMessages(ask: SegmentAsk): DjMessage[] {
  const now = ask.now ?? new Date();
  const opening = ask.opening ?? !ask.previous;
  const user = [
    ...situation(ask, opening, now),
    "",
    `Pick ${SET_MIN} to ${SET_MAX} of them by number, in the order to play them. Give the segment a short name,`,
    "then write what you say before the first song you picked. Answer in JSON.",
  ];
  if (ask.live) user.push("Name only the first song when you talk: you pick the rest as the listener goes.");
  return [
    { role: "system", content: persona(ask, opening) },
    { role: "user", content: user.join("\n") },
  ];
}

/** The most songs one look-up covers. */
export const LOOK_UP_MAX = 5;
const LOOK_UP_TOOL = "look_up_songs";

/** The tool the model can call before it picks. */
export function lookUpTool(choices: number): DjTool {
  return {
    name: LOOK_UP_TOOL,
    description:
      "Look up songs from the list before picking: their genres, release date and label, how popular they are, and " +
      "the artist's background. Give the numbers of the songs you want to know more about.",
    parameters: {
      type: "object",
      properties: {
        songs: {
          type: "array",
          items: { type: "integer", minimum: 1, maximum: Math.max(1, choices) },
          maxItems: LOOK_UP_MAX,
          description: `Up to ${LOOK_UP_MAX} song numbers from the list.`,
        },
      },
      required: ["songs"],
      additionalProperties: false,
    },
  };
}

/** The first question to a model that can look things up: which songs, if any, it wants to know more about. */
export function lookUpMessages(ask: SegmentAsk): DjMessage[] {
  const now = ask.now ?? new Date();
  const opening = ask.opening ?? !ask.previous;
  const user = [
    ...situation({ ...ask, lookedUp: undefined }, opening, now),
    "",
    `Before you pick, you can look up to ${LOOK_UP_MAX} of these songs with ${LOOK_UP_TOOL}: what they are`,
    "(genre, release, label, how popular) and who made them. Look up the ones you'd like to know more about to",
    "pick well or say something worth hearing. If you know enough already, say so and don't call it.",
  ];
  return [
    { role: "system", content: persona(ask, opening) },
    { role: "user", content: user.join("\n") },
  ];
}

/** The songs the model asked to look up, in its order, without repeats. */
export function lookUpsAsked(calls: DjToolCall[] | undefined, choices: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const call of calls ?? []) {
    if (call.name !== LOOK_UP_TOOL) continue;
    const songs = (call.arguments as { songs?: unknown } | null)?.songs;
    for (const n of Array.isArray(songs) ? songs : []) {
      const c = Number.isInteger(n) ? choices[(n as number) - 1] : undefined;
      if (c && !out.includes(c) && out.length < LOOK_UP_MAX) out.push(c);
    }
  }
  return out;
}

/** One looked-up song, by its number in the list, as a line the model can read. */
export function songFacts(n: number, c: Candidate, info: DjSongInfo): string {
  const out: string[] = [];
  if (info.genres.length) out.push(`genres ${info.genres.join(", ")}`);
  if (info.tags.length) out.push(`tagged ${info.tags.join(", ")}`);
  const on = info.label ? ` on ${info.label}` : "";
  if (info.released) out.push(`released ${info.released}${on}`);
  else if (on) out.push(`released${on}`);
  if (info.album && info.album_type) out.push(`from the ${info.album_type} "${info.album}"`);
  if (info.popularity != null) {
    const how = info.popularity >= 70 ? "a big hit" : info.popularity >= 45 ? "well known" : info.popularity >= 20 ? "a lesser-known track" : "a deep cut";
    out.push(`${how} (popularity ${info.popularity} of 100)`);
  }
  if (info.languages.length) out.push(`sung in ${info.languages.join(", ")}`);
  if (info.artist_active) out.push(`artist active ${info.artist_active}`);
  if (info.related_artists.length) out.push(`for fans of ${info.related_artists.join(", ")}`);
  if (info.artist_bio) out.push(`about the artist: ${info.artist_bio}`);
  return `${n}. ${c.name} by ${c.artists.join(", ")}: ${out.length ? out.join("; ") : "nothing more found"}`;
}

/** What the listener just did, for the DJ to go by and mention. */
function reactionLines(r: Reactions | undefined): string[] {
  const list = (songs: Candidate[]) => songs.slice(0, 3).map((c) => `"${c.name}" by ${c.artists.join(", ")}`).join("; ");
  const out: string[] = [];
  if (r?.liked.length) out.push(`While you played, the listener liked ${list(r.liked)}.`);
  if (r?.skipped.length) out.push(`They skipped ${list(r.skipped)}.`);
  return out;
}

/** The answer's shape. llama.cpp writes properties in alphabetical order: the name, then the songs,
 * then the talk, which can then introduce the first song it picked. */
export function segmentSchema(choices: number): object {
  return {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 40 },
      songs: {
        type: "array",
        items: { type: "integer", minimum: 1, maximum: Math.max(1, choices) },
        minItems: Math.min(SET_MIN, choices),
        maxItems: SET_MAX,
      },
      talk: { type: "string", maxLength: 400 },
    },
    required: ["name", "songs", "talk"],
    additionalProperties: false,
  };
}

export interface Pick {
  name: string;
  songs: Candidate[];
  talk: string;
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/** A line as it should be spoken: no markup, emoji or wrapping quotes, on one line. */
export function cleanTalk(text: string): string {
  let t = text.replace(EMOJI, "").replace(/[*_#`~<>[\]{}|\\]/g, "").replace(/\s+/g, " ").trim();
  // A whole answer in quotes.
  if (/^["“].*["”]$/.test(t) && !/["“”]/.test(t.slice(1, -1))) t = t.slice(1, -1).trim();
  return t;
}

/** The model's answer, checked against the choices it had. Null when it isn't usable. */
export function readAnswer(raw: unknown, choices: Candidate[], segment: Segment): Pick | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as { name?: unknown; songs?: unknown; talk?: unknown };
  if (!Array.isArray(a.songs)) return null;
  const songs: Candidate[] = [];
  for (const n of a.songs) {
    const c = Number.isInteger(n) ? choices[(n as number) - 1] : undefined;
    if (c && !songs.includes(c) && songs.length < SET_MAX) songs.push(c);
  }
  if (songs.length < Math.min(2, choices.length)) return null;
  const talk = typeof a.talk === "string" ? cleanTalk(a.talk) : "";
  if (talk.length < 8) return null;
  const name = typeof a.name === "string" ? cleanTalk(a.name).slice(0, 40) : "";
  return { name: name || segment.label, songs, talk };
}

function byline(c: { name: string; artists: string[] }): string {
  return `${c.name} by ${c.artists.slice(0, 2).join(" and ") || "an artist you love"}`;
}

/** A segment without the model: the first choices in order, and a line from a template. */
export function fallbackPick(
  segment: Segment,
  choices: Candidate[],
  listener: string | null,
  previous: { name: string; artists: string[] } | null,
): Pick {
  const songs = choices.slice(0, 4);
  const first = songs[0];
  const intro = previous
    ? `That was ${byline(previous)}. Up next, ${segment.phrase}`
    : `Hey${listener ? ` ${listener}` : ""}, it's your DJ. Let's start with ${segment.phrase}`;
  const talk = first ? `${intro}, starting with ${byline(first)}.` : `${intro}.`;
  return { name: segment.label, songs, talk };
}
