import { describe, expect, it } from "vitest";
import { SetProgress } from "./djLive";
import type { Candidate } from "./djPicks";

const song = (id: string): Candidate => ({
  uri: `spotify:track:${id}`,
  name: id,
  artists: [`Artist ${id}`],
  album: "",
  year: null,
  durationMs: 1,
  explicit: false,
  reasons: ["favorite"],
  likedAt: null,
  playedAt: null,
});

describe("SetProgress", () => {
  it("starts with nothing skipped, liked or lined up again", () => {
    const p = new SetProgress();
    expect([p.skips, p.ends, p.repick, p.liked, p.heading]).toEqual([0, false, false, [], null]);
  });

  it("puts the latest like first, once, and has the song lined up next picked again", () => {
    const p = new SetProgress();
    p.like(song("a"));
    p.repick = false;
    p.like(song("b"));
    p.like(song("a"));
    expect(p.liked.map((s) => s.name)).toEqual(["a", "b"]);
    expect(p.repick).toBe(true);
  });

  it("takes a skip back, never below none", () => {
    const p = new SetProgress();
    p.skips = 1;
    p.unskip();
    p.unskip();
    expect(p.skips).toBe(0);
  });
});
