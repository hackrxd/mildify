import { describe, expect, it } from "vitest";
import type { Candidate } from "./djPicks";
import { SessionTaste, SIT_OUT_SETS } from "./djTaste";

const song = (id: string, artists = [`Artist ${id}`]): Candidate => ({
  uri: `spotify:track:${id}`,
  name: id,
  artists,
  album: "",
  year: null,
  durationMs: 1,
  explicit: false,
  reasons: ["favorite"],
  likedAt: null,
  playedAt: null,
});

describe("SessionTaste", () => {
  it("counts a skip once, however many ways the leaving is seen", () => {
    const taste = new SessionTaste();
    const a = song("a");
    const b = song("b");
    expect(taste.skipped(a)).toBe(true);
    expect(taste.skipped(a)).toBe(false);
    expect(taste.skipped(b)).toBe(true);
    // Skipped again later, after something else: a new skip.
    expect(taste.skipped(a)).toBe(true);
    expect(taste.skippedSongs.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("sits a skipped song's main artist out for the next two sets, not a featured one", () => {
    const taste = new SessionTaste();
    taste.skipped(song("one", ["Ann", "Bo"]), 3);
    expect([...taste.sittingOut(3)]).toEqual(["Ann"]);
    expect([...taste.sittingOut(4)]).toEqual(["Ann"]);
    expect(taste.sittingOut(5).size).toBe(0);
  });

  it("sits an artist out for the rest of the session once they're skipped twice", () => {
    const taste = new SessionTaste();
    taste.skipped(song("one", ["Ann"]), 1);
    taste.skipped(song("two", ["Ann"]), 1);
    expect([...taste.sittingOut(SIT_OUT_SETS + 50)]).toEqual(["Ann"]);
  });

  it("counts a skip among no more sets than are picked, once some are let go of unheard", () => {
    const taste = new SessionTaste();
    taste.skipped(song("one", ["Ann"]), 3);
    taste.recount(1);
    expect([...taste.sittingOut(2)]).toEqual(["Ann"]);
    expect(taste.sittingOut(3).size).toBe(0);
    // A skip after the sets let go of is left as it was.
    taste.skipped(song("two", ["Bo"]), 1);
    taste.recount(2);
    expect([...taste.sittingOut(2)].sort()).toEqual(["Ann", "Bo"]);
  });

  it("takes back a skip, and its artist's latest", () => {
    const taste = new SessionTaste();
    const one = song("one", ["Ann"]);
    const two = song("two", ["Ann"]);
    taste.skipped(one, 1);
    taste.skipped(two, 2);
    expect(taste.forgive(two)).toBe(true);
    // One skip left: out until two sets after it.
    expect([...taste.sittingOut(2)]).toEqual(["Ann"]);
    expect(taste.sittingOut(3).size).toBe(0);
    expect(taste.forgive(two)).toBe(false);
    taste.forgive(one);
    expect(taste.sittingOut(1).size).toBe(0);
  });

  it("keeps the ten most recent skips and likes", () => {
    const taste = new SessionTaste();
    for (let i = 0; i < 12; i++) taste.skipped(song(`s${i}`));
    expect(taste.skippedSongs).toHaveLength(10);
    expect(taste.skippedSongs[0].name).toBe("s11");
  });

  it("notices a song liked since it was last looked at, not one liked all along", () => {
    const taste = new SessionTaste();
    const a = song("a");
    const b = song("b");
    const c = song("c");
    const library = new Map<string, boolean | undefined>([
      [a.uri, false],
      [b.uri, true],
      [c.uri, undefined],
    ]);
    const has = (uri: string) => library.get(uri);
    expect(taste.noticeLikes([a, b, c], has)).toEqual([]);
    library.set(a.uri, true);
    library.set(c.uri, true);
    // c wasn't known before: liked when first seen isn't new.
    expect(taste.noticeLikes([a, b, c], has)).toEqual([a]);
    expect(taste.noticeLikes([a, b, c], has)).toEqual([]);
    expect(taste.liked).toEqual([a]);
  });

  it("tells the model about each like and skip once", () => {
    const taste = new SessionTaste();
    const a = song("a");
    taste.skipped(a);
    const news = taste.news();
    expect(news).toEqual({ liked: [], skipped: [a] });
    taste.toldOf(news);
    expect(taste.news()).toEqual({ liked: [], skipped: [] });
  });
});
