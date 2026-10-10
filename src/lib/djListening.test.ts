import { beforeEach, describe, expect, it, vi } from "vitest";

const sp = vi.hoisted(() => ({ topTracksIn: vi.fn(), savedTracks: vi.fn(), recentlyPlayed: vi.fn() }));
vi.mock("./spotify", () => sp);

let m: typeof import("./djListening");

const track = (id: string) => ({ id, uri: `spotify:track:${id}`, name: id });
const page = (items: unknown[], total = items.length) => ({ items, total, next: null, offset: 0, limit: 50 });

beforeEach(async () => {
  vi.resetModules();
  for (const fn of Object.values(sp)) fn.mockReset();
  sp.topTracksIn.mockImplementation(async (range: string, offset: number, limit: number) =>
    page(Array.from({ length: Math.min(limit, 3) }, (_, i) => track(`${range}-${offset + i}`))),
  );
  sp.savedTracks.mockImplementation(async (offset: number) => page([{ added_at: "2026-01-01", track: track(`liked-${offset}`) }], 1000));
  sp.recentlyPlayed.mockResolvedValue(page([]));
  m = await import("./djListening");
});

const refused = { kind: "api", message: "Invalid limit", status: 400 };

describe("loadListening", () => {
  it("reads a page of 50 top tracks per time range", async () => {
    const l = await m.loadListening({ random: () => 0 });
    expect(sp.topTracksIn.mock.calls).toEqual([
      ["short_term", 0, 50],
      ["medium_term", 0, 50],
      ["long_term", 0, 50],
    ]);
    expect(l.topShort.map((t) => t.id)).toEqual(["short_term-0", "short_term-1", "short_term-2"]);
  });

  it("reads two pages of 20 where 50 is refused, and doesn't ask for 50 again", async () => {
    sp.topTracksIn.mockImplementation(async (range: string, offset: number, limit: number) => {
      if (limit > 20) throw refused;
      return page([track(`${range}-${offset}`)]);
    });
    const l = await m.loadListening({ random: () => 0 });
    expect(l.topLong.map((t) => t.id)).toEqual(["long_term-0", "long_term-20"]);
    sp.topTracksIn.mockClear();
    await m.loadListening({ random: () => 0 });
    expect(sp.topTracksIn.mock.calls.every(([, , limit]) => limit === 20)).toBe(true);
    expect(sp.topTracksIn).toHaveBeenCalledTimes(6);
  });

  it("doesn't read smaller pages for other failures, and goes on without the part that failed", async () => {
    sp.topTracksIn.mockImplementation(async (range: string) => {
      if (range === "short_term") throw { kind: "api", message: "Server error", status: 500 };
      return page([track(range)]);
    });
    const l = await m.loadListening({ random: () => 0 });
    expect(sp.topTracksIn).toHaveBeenCalledTimes(3);
    expect([l.topShort, l.topMedium.length]).toEqual([[], 1]);
  });

  it("is an error only when every part fails", async () => {
    const offline = new Error("offline");
    sp.topTracksIn.mockRejectedValue(offline);
    sp.savedTracks.mockRejectedValue(offline);
    sp.recentlyPlayed.mockRejectedValue(offline);
    await expect(m.loadListening()).rejects.toBe(offline);
  });

  it("reads the newest likes, and a page from each half of the rest", async () => {
    const l = await m.loadListening({ random: () => 0 });
    expect(sp.savedTracks.mock.calls).toEqual([[0], [50], [500]]);
    expect(l.saved.map((s) => s.track.id)).toEqual(["liked-0", "liked-50", "liked-500"]);
  });

  it("keeps the same user's listening for half an hour", async () => {
    await m.loadListening({ user: "sam", now: 0 });
    await m.loadListening({ user: "sam", now: m.LISTENING_KEPT_MS - 1 });
    expect(sp.topTracksIn).toHaveBeenCalledTimes(3);
    await m.loadListening({ user: "sam", now: m.LISTENING_KEPT_MS });
    expect(sp.topTracksIn).toHaveBeenCalledTimes(6);
    await m.loadListening({ user: "alex", now: m.LISTENING_KEPT_MS });
    expect(sp.topTracksIn).toHaveBeenCalledTimes(9);
    m.forgetListening();
    await m.loadListening({ user: "alex", now: m.LISTENING_KEPT_MS });
    expect(sp.topTracksIn).toHaveBeenCalledTimes(12);
    // Without a user, nothing is kept.
    await m.loadListening({ now: 0 });
    await m.loadListening({ now: 0 });
    expect(sp.topTracksIn).toHaveBeenCalledTimes(18);
  });
});

describe("olderPages", () => {
  it("picks a page from the newer half of the older likes and one from the older half, at random", () => {
    expect(m.olderPages(1000, () => 0)).toEqual([50, 500]);
    expect(m.olderPages(1000, () => 0.9999)).toEqual([450, 950]);
    expect(m.olderPages(101, () => 0.5)).toEqual([50, 100]);
  });

  it("reads one more page when only one is left, and none past the newest otherwise", () => {
    expect(m.olderPages(60, () => 0.5)).toEqual([50]);
    expect(m.olderPages(50, () => 0.5)).toEqual([]);
    expect(m.olderPages(0, () => 0.5)).toEqual([]);
  });
});
