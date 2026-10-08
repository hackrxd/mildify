import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { load, persist, PLAYED_KEPT, PLAYED_KEY, PLAYED_MEMORY_MS, playedLately, rememberPlayed } from "./djMemory";

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
