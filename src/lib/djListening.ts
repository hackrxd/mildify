// The user's listening, as the DJ reads it from the Web API: a page of top tracks per time range, the newest likes
// and two older pages picked at random each session, and what was played lately. Kept for half an hour, so stopping
// and starting the DJ doesn't read it all again.
import type { Listening } from "./djPicks";
import { isAppError } from "./ipc";
import * as sp from "./spotify";
import type { Paging, PlayHistory, SavedTrack, Track } from "./types";

/** How long the listening read for one session serves the next. */
export const LISTENING_KEPT_MS = 30 * 60 * 1000;
/** Top tracks per request: the Web API's most, three requests in all. */
export const TOP_PAGE = 50;
/** Liked songs per request. */
const LIKED_PAGE = 50;

let kept: { user: string; at: number; listening: Listening } | null = null;
/** A top-tracks request for 50 was refused (a development-mode app may get fewer): two pages of 20 from then on. */
let smallPages = false;

/** Everything the DJ reads about the user's listening; each part is optional, and all failing is an error. The same
 * user's, read less than half an hour ago, is read from what was kept. */
export async function loadListening(opts: { user?: string; now?: number; random?: () => number } = {}): Promise<Listening> {
  const now = opts.now ?? Date.now();
  if (kept && opts.user !== undefined && kept.user === opts.user && now - kept.at < LISTENING_KEPT_MS) return kept.listening;
  const listening = await read(opts.random ?? Math.random);
  if (opts.user !== undefined) kept = { user: opts.user, at: now, listening };
  return listening;
}

/** Forgets the listening kept: the next session reads it again. */
export function forgetListening() {
  kept = null;
}

async function read(random: () => number): Promise<Listening> {
  const parts = await Promise.allSettled([top("short_term"), top("medium_term"), top("long_term"), recent(), liked(random)]);
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

/** A time range's top tracks: one page of 50, or two of 20 where 50 is refused. */
async function top(range: sp.TimeRange): Promise<Track[]> {
  if (!smallPages) {
    try {
      return (await sp.topTracksIn(range, 0, TOP_PAGE)).items;
    } catch (e) {
      if (!isAppError(e) || e.status !== 400) throw e;
      smallPages = true;
    }
  }
  const pages = await Promise.allSettled([sp.topTracksIn(range, 0, 20), sp.topTracksIn(range, 20, 20)]);
  const ok = pages.filter((p) => p.status === "fulfilled").map((p) => (p as PromiseFulfilledResult<Paging<Track>>).value);
  if (!ok.length) throw (pages[0] as PromiseRejectedResult).reason;
  return ok.flatMap((p) => p.items);
}

const recent = async () => (await sp.recentlyPlayed()).items;

/** The newest likes, and a page from each half of the rest, somewhere else each session. */
async function liked(random: () => number): Promise<SavedTrack[]> {
  const first = await sp.savedTracks(0);
  const items = [...first.items];
  const pages = await Promise.allSettled(olderPages(first.total, random).map((o) => sp.savedTracks(o)));
  for (const p of pages) if (p.status === "fulfilled") items.push(...(p.value as Paging<SavedTrack>).items);
  return items;
}

/** Where to read older likes from, past the newest page: a page from the newer half of the rest and one from the
 * older half, each at random, so every session digs up different ones. One page when only one is left. */
export function olderPages(total: number, random: () => number): number[] {
  const count = Math.ceil((total - LIKED_PAGE) / LIKED_PAGE);
  if (count <= 0) return [];
  if (count === 1) return [LIKED_PAGE];
  const newer = Math.floor(count / 2);
  const pick = (from: number, n: number) => (from + Math.min(n - 1, Math.floor(random() * n))) * LIKED_PAGE;
  return [pick(1, newer), pick(1 + newer, count - newer)];
}
