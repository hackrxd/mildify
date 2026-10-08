// The user's listening, as the DJ reads it from the Web API.
import type { Listening } from "./djPicks";
import * as sp from "./spotify";
import type { Paging, PlayHistory, SavedTrack, Track } from "./types";

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
