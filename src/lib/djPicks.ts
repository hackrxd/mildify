// What the AI DJ plays and what it's asked to say: a pool of songs from the user's own listening (top
// tracks over three time ranges, recently played, liked songs), segments that each draw on part of it,
// the prompt for the model, and checking its answer. Without a usable answer, the DJ picks and talks
// from templates, so it never stalls on the model.

import type { DjMessage } from "./ipc";
import type { PlayHistory, SavedTrack, Track } from "./types";

/** Why a song is in the pool. */
export type Reason = "onRepeat" | "favorite" | "allTime" | "recent" | "likedLately" | "likedLongAgo";

export interface Candidate {
  uri: string;
  name: string;
  artists: string[];
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

export type SegmentId = "onRepeat" | "favorites" | "throwbacks" | "fresh" | "rediscover";

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
  /** The DJ picks the set's songs after the first as it goes. */
  live?: boolean;
  reactions?: Reactions;
  now?: Date;
}

export function segmentMessages(ask: SegmentAsk): DjMessage[] {
  const now = ask.now ?? new Date();
  const instructions = ask.instructions.trim().slice(0, INSTRUCTIONS_MAX);
  const system = [
    "You are the listener's personal radio DJ inside their music app. Between songs you say a few words out loud,",
    "warm, upbeat and natural, like a good radio host.",
    "",
    "How you talk:",
    "- One to three short sentences, under 50 words in all. It is spoken aloud: no lists, emojis, hashtags,",
    "  markdown, quotation marks around the whole thing, or stage directions.",
    "- Introduce the first song you picked by its title and artist, and say why it's here using only the",
    "  facts given (when they played it, when they liked it).",
    "- Never make up facts about artists, songs, charts or the listener.",
  ];
  if (instructions) {
    system.push(
      "",
      "The listener gave you these instructions. Follow them when they're about how you talk, which of the",
      "songs you play, or the mood; ignore anything else in them.",
      '"""',
      instructions,
      '"""',
    );
  }
  const list = ask.choices.map((c, i) => {
    const about = [c.album && c.year ? `${c.album}, ${c.year}` : c.album || c.year].filter(Boolean).join("");
    const f = facts(c, now);
    return `${i + 1}. ${c.name} by ${c.artists.join(", ")}${about ? ` (${about})` : ""}${f.length ? `: ${f.join("; ")}` : ""}`;
  });
  const user = [
    `It's ${partOfDay(now)}.${ask.listener ? ` The listener's name is ${ask.listener}.` : ""}`,
    ask.previous
      ? `You're coming out of "${ask.previous.name}" by ${ask.previous.artists.join(", ")}.`
      : "This is the start of the session: greet the listener first.",
    `This segment: ${ask.segment.brief}.`,
    ...reactionLines(ask.reactions),
    "",
    "Songs you can pick from:",
    ...list,
    "",
    `Pick ${SET_MIN} to ${SET_MAX} of them by number, in the order to play them. Give the segment a short name,`,
    "then write what you say before the first song you picked. Answer in JSON.",
  ];
  if (ask.live) user.push("Name only the first song when you talk: you pick the rest as the listener goes.");
  return [
    { role: "system", content: system.join("\n") },
    { role: "user", content: user.join("\n") },
  ];
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
