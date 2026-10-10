import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTIST_SKIP_HALF_LIFE,
  DjMemory,
  FEATURED_SKIP,
  KEEP,
  load,
  LOVE_HALF_LIFE,
  MEMORY_KEY,
  MEMORY_MAX_BYTES,
  persist,
  PLAYED_KEPT,
  PLAYED_KEY,
  PLAYED_MEMORY_MS,
  playedLately,
  rememberPlayed,
  SONG_SKIP_HALF_LIFE,
} from "./djMemory";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("settings in localStorage", () => {
  it("reads what was kept, or the default", () => {
    expect(load("nativify:x", 3, Number)).toBe(3);
    persist("nativify:x", "7");
    expect(load("nativify:x", 3, Number)).toBe(7);
    persist("nativify:x", null);
    expect(localStorage.getItem("nativify:x")).toBeNull();
  });

  it("falls back when the value can't be read, and carries on when it can't be kept", () => {
    localStorage.setItem("nativify:x", "{not json");
    expect(load("nativify:x", "fallback", JSON.parse)).toBe("fallback");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => persist("nativify:y", "1")).not.toThrow();
  });
});

describe("songs played lately", () => {
  const now = 1_800_000_000_000;

  it("remembers each song with when it played, newest last", () => {
    rememberPlayed("spotify:track:a", now - 2000);
    rememberPlayed("spotify:track:b", now - 1000);
    rememberPlayed("spotify:track:a", now);
    expect([...playedLately(now)]).toEqual([
      ["spotify:track:b", now - 1000],
      ["spotify:track:a", now],
    ]);
  });

  it("forgets songs played longer ago than it keeps them", () => {
    rememberPlayed("spotify:track:old", now - PLAYED_MEMORY_MS - 1);
    rememberPlayed("spotify:track:new", now - 1);
    expect([...playedLately(now).keys()]).toEqual(["spotify:track:new"]);
  });

  it("keeps only so many, the newest", () => {
    for (let i = 0; i < PLAYED_KEPT + 5; i++) rememberPlayed(`spotify:track:${i}`, now - PLAYED_KEPT - 5 + i);
    const kept = [...playedLately(now).keys()];
    expect(kept).toHaveLength(PLAYED_KEPT);
    expect(kept[0]).toBe("spotify:track:5");
  });

  it("ignores what it can't read", () => {
    localStorage.setItem(PLAYED_KEY, "[1,2,3]");
    expect(playedLately(now).size).toBe(0);
    localStorage.setItem(PLAYED_KEY, JSON.stringify({ "spotify:track:a": "yesterday", "spotify:track:b": now }));
    expect([...playedLately(now).keys()]).toEqual(["spotify:track:b"]);
    localStorage.setItem(PLAYED_KEY, "{oops");
    expect(playedLately(now).size).toBe(0);
  });
});

describe("DjMemory", () => {
  const now = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  const song = (uri: string, ...artists: string[]) => ({ uri, artists });

  it("remembers what the DJ played, across instances", () => {
    const m = new DjMemory(now);
    m.played("spotify:track:a", now - 4 * DAY);
    m.played("spotify:track:b", now - DAY);
    const again = new DjMemory(now);
    expect([...again.playedWithin(3 * DAY, now)]).toEqual(["spotify:track:b"]);
    expect(again.playedAgo("spotify:track:a", now)).toBe(4 * DAY);
    expect(again.playedAgo("spotify:track:c", now)).toBeNull();
  });

  it("weighs a skip of a song, its main artist and lightly a featured one, fading with time", () => {
    const m = new DjMemory(now);
    m.skipped(song("spotify:track:a", "Main", "Featured"), now);
    expect([m.songSkip("spotify:track:a", now), m.artistSkip("Main", now), m.artistSkip("Featured", now)]).toEqual([1, 1, FEATURED_SKIP]);
    expect(m.songSkip("spotify:track:a", now + SONG_SKIP_HALF_LIFE)).toBeCloseTo(0.5);
    expect(m.artistSkip("Main", now + ARTIST_SKIP_HALF_LIFE)).toBeCloseTo(0.5);
    m.skipped(song("spotify:track:a", "Main"), now);
    expect(m.songSkip("spotify:track:a", now)).toBe(2);
    expect(m.artistSkip("Nobody", now)).toBe(0);
  });

  it("keeps a song's last three skips, and an artist's last six", () => {
    const m = new DjMemory(now);
    for (let i = 0; i < 4; i++) m.skipped(song("spotify:track:a", "Main"), now);
    for (let i = 0; i < 4; i++) m.skipped(song(`spotify:track:b${i}`, "Main"), now);
    expect(m.songSkip("spotify:track:a", now)).toBe(3);
    expect(m.artistSkip("Main", now)).toBe(6);
  });

  it("takes back the last skip of a song, and its artists' share", () => {
    const m = new DjMemory(now);
    m.skipped(song("spotify:track:a", "Main", "Featured"), now - 1000);
    m.skipped(song("spotify:track:a", "Main", "Featured"), now);
    m.unskipped(song("spotify:track:a", "Main", "Featured"));
    expect(m.songSkip("spotify:track:a", now)).toBeCloseTo(1, 5);
    expect(m.artistSkip("Featured", now)).toBeCloseTo(FEATURED_SKIP, 5);
    m.unskipped(song("spotify:track:a", "Main", "Featured"));
    expect([m.songSkip("spotify:track:a", now), m.artistSkip("Main", now)]).toEqual([0, 0]);
    expect(() => m.unskipped(song("spotify:track:z", "Main"))).not.toThrow();
  });

  it("counts likes toward the artists, fading over months", () => {
    const m = new DjMemory(now);
    m.liked(song("spotify:track:a", "Main", "Featured"), now);
    m.liked(song("spotify:track:b", "Main"), now - LOVE_HALF_LIFE);
    expect(m.artistLove("Main", now)).toBeCloseTo(1.5);
    expect(m.artistLove("Featured", now)).toBe(1);
    expect(m.artistLove("Nobody", now)).toBe(0);
  });

  it("notes how each set went, whatever its segment", () => {
    const m = new DjMemory(now);
    m.setStarted("s1:1", { segment: "onRepeat", part: "evening", request: false }, now);
    m.setStarted("s1:2", { segment: "ext:my-extension/rainy", part: "evening", request: true }, now);
    for (const note of ["song", "song", "skip", "like", "skipped"] as const) m.noteSet("s1:1", note);
    m.noteSet("s0:9", "song");
    expect(new DjMemory(now).sets(now)).toEqual([
      { segment: "onRepeat", part: "evening", request: false, at: now, songs: 2, skips: 1, likes: 1, skipped: true },
      { segment: "ext:my-extension/rainy", part: "evening", request: true, at: now, songs: 0, skips: 0, likes: 0, skipped: false },
    ]);
    // What it hands out is a copy.
    m.sets(now)[0].songs = 99;
    expect(m.sets(now)[0].songs).toBe(2);
  });

  it("remembers what the DJ said lately, and forgets a line it withdrew", () => {
    const m = new DjMemory(now);
    m.said({ talk: "Hello there.", byModel: true }, now - 15 * DAY);
    m.said({ talk: "First.", byModel: true }, now - 2000);
    m.said({ talk: "Second.", byModel: false }, now - 1000);
    m.said({ talk: "Withdrawn.", byModel: true }, now);
    m.unsaid("Withdrawn.");
    expect(new DjMemory(now).lastSaid(5, now).map((s) => s.talk)).toEqual(["First.", "Second."]);
    expect(m.lastSaid(1, now).map((s) => [s.talk, s.byModel])).toEqual([["Second.", false]]);
    // Gone stale while the app stayed open.
    expect(m.lastSaid(5, now + 15 * DAY)).toEqual([]);
  });

  it("keeps each list to its limit, the newest, and drops what's too old", () => {
    const m = new DjMemory(now);
    for (let i = 0; i < KEEP.played.max + 10; i++) m.played(`spotify:track:${i}`, now - (KEEP.played.max + 10 - i));
    const kept = m.playedWithin(KEEP.played.ms, now);
    expect(kept.size).toBe(KEEP.played.max);
    expect(kept.has("spotify:track:9")).toBe(false);
    expect(kept.has("spotify:track:10")).toBe(true);
    m.played("spotify:track:old", now - KEEP.played.ms - 1);
    expect(new DjMemory(now).playedAgo("spotify:track:old", now)).toBeNull();
  });

  it("stays under its size, dropping the oldest of the longest list", () => {
    const m = new DjMemory(now);
    const long = "x".repeat(200);
    for (let i = 0; i < 1500; i++) {
      m.played(`spotify:track:${long}${i}`, now - 1500 + i);
      if (i % 5 === 0) m.liked(song(`spotify:track:${long}l${i}`, `${long} artist ${i}`), now - 1500 + i);
    }
    const kept = localStorage.getItem(MEMORY_KEY)!;
    expect(kept.length).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
    // The newest is still there.
    expect(m.playedAgo(`spotify:track:${long}1499`, now)).toBe(1);
  });

  it("drops what it can't read, keeping the rest", () => {
    localStorage.setItem(MEMORY_KEY, "{oops");
    expect(new DjMemory(now).playedWithin(DAY, now).size).toBe(0);
    localStorage.setItem(
      MEMORY_KEY,
      JSON.stringify({
        v: 1,
        played: [["spotify:track:a", now - 1], ["spotify:track:b", "yesterday"], ["spotify:track:c", String(now)], "nonsense", [42, now]],
        songSkips: [["spotify:track:a", [now - 1, "x"]], ["spotify:track:b", [now - 1]]],
        artistSkips: [["__proto__", [[now - 1, 1]]], ["Bad", [[now - 1, -1]]]],
        likes: [["spotify:track:a", { at: now - 1, artists: ["Main"] }], ["spotify:track:b", { at: now - 1 }]],
        sets: [["s:1", { segment: "fresh", at: now - 1, part: "night", songs: 1, skips: 0, likes: 0, skipped: false, request: false }], ["s:2", { segment: "" }]],
        said: [{ at: now - 1, talk: "Hi.", byModel: true }, { at: now - 1, talk: 7 }],
      }),
    );
    const m = new DjMemory(now);
    expect([...m.playedWithin(DAY, now)]).toEqual(["spotify:track:a"]);
    expect(m.playedAgo("spotify:track:c", now)).toBeNull();
    expect([m.songSkip("spotify:track:a", now), m.songSkip("spotify:track:b", now) > 0]).toEqual([0, true]);
    expect(m.artistSkip("__proto__", now)).toBeCloseTo(1, 5);
    expect(m.artistSkip("Bad", now)).toBe(0);
    expect(m.artistLove("Main", now)).toBeCloseTo(1, 5);
    expect(m.sets(now).map((r) => r.segment)).toEqual(["fresh"]);
    expect(m.lastSaid(5, now).map((s) => s.talk)).toEqual(["Hi."]);
    // Another version's memory isn't read as this one.
    localStorage.setItem(MEMORY_KEY, JSON.stringify({ v: 2, played: [["spotify:track:a", now - 1]] }));
    expect(new DjMemory(now).playedWithin(DAY, now).size).toBe(0);
  });

  it("takes in the songs remembered before it had this memory, once", () => {
    localStorage.setItem(PLAYED_KEY, JSON.stringify({ "spotify:track:a": now - 2000, "spotify:track:b": now - 1000 }));
    const m = new DjMemory(now);
    expect([...m.playedWithin(DAY, now)]).toEqual(["spotify:track:a", "spotify:track:b"]);
    expect(localStorage.getItem(PLAYED_KEY)).toBeNull();
    expect([...new DjMemory(now).playedWithin(DAY, now)]).toEqual(["spotify:track:a", "spotify:track:b"]);
  });

  it("forgets everything", () => {
    const m = new DjMemory(now);
    m.played("spotify:track:a", now);
    m.skipped(song("spotify:track:a", "Main"), now);
    m.liked(song("spotify:track:b", "Main"), now);
    m.setStarted("s:1", { segment: "fresh", part: "night", request: false }, now);
    m.said({ talk: "Hi.", byModel: true }, now);
    m.forget();
    expect(localStorage.getItem(MEMORY_KEY)).toBeNull();
    expect([m.playedWithin(DAY, now).size, m.songSkip("spotify:track:a", now), m.artistLove("Main", now), m.sets(now).length, m.lastSaid(5, now).length]).toEqual([0, 0, 0, 0, 0]);
  });

  it("keeps working when nothing can be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    const m = new DjMemory(now);
    m.played("spotify:track:a", now);
    expect(m.playedAgo("spotify:track:a", now)).toBe(0);
  });
});
