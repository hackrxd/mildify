import { describe, expect, it } from "vitest";
import type { Candidate } from "./djPicks";
import { SessionTaste } from "./djTaste";

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

  it("benches a skipped song's artists until every skip of theirs is taken back", () => {
    const taste = new SessionTaste();
    const one = song("one", ["Ann", "Bo"]);
    const two = song("two", ["Ann"]);
    taste.skipped(one);
    taste.skipped(two);
    expect([...taste.skippedArtists].sort()).toEqual(["Ann", "Bo"]);
    expect(taste.forgive(one)).toBe(true);
    expect([...taste.skippedArtists]).toEqual(["Ann"]);
    expect(taste.forgive(one)).toBe(false);
    taste.forgive(two);
    expect(taste.skippedArtists.size).toBe(0);
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
