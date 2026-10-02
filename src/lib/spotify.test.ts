import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./ipc";
import * as sp from "./spotify";
import type { Paging, PlaylistItem } from "./types";

vi.mock("./ipc", () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

function page<T>(items: T[], next: string | null): Paging<T> {
  return { items, next, total: 0, limit: items.length, offset: 0 } as unknown as Paging<T>;
}

/** The query of the most recent call, as sent to the backend. */
function lastQuery(): Record<string, unknown> {
  return (apiMock.mock.lastCall?.[2] as { query?: Record<string, unknown> }).query ?? {};
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue(page([], null));
});

// Spotify answers 400 "Invalid limit" above these for development-mode apps (February 2026).
describe("development-mode limits", () => {
  it("searches at most 10 per type", async () => {
    await sp.search("q");
    expect(apiMock.mock.lastCall?.[1]).toBe("/search");
    expect(lastQuery().limit).toBeLessThanOrEqual(10);
  });

  it("lists artist albums at most 10 per page", async () => {
    await sp.artistAlbums("id", 20);
    expect(apiMock.mock.lastCall?.[1]).toBe("/artists/id/albums");
    expect(lastQuery()).toMatchObject({ offset: 20 });
    expect(lastQuery().limit).toBeLessThanOrEqual(10);
  });

  it("uses the unified library endpoints with full URIs", async () => {
    // The 40-per-call cap is the caller's job (see liked.test.ts).
    const uris = Array.from({ length: 3 }, (_, i) => `spotify:track:${i}`);
    await sp.libraryContains(uris);
    expect(apiMock).toHaveBeenLastCalledWith("GET", "/me/library/contains", {
      query: { uris: uris.join(",") },
    });
    await sp.saveToLibrary(uris);
    expect(apiMock).toHaveBeenLastCalledWith("PUT", "/me/library", { query: { uris: uris.join(",") } });
    await sp.removeFromLibrary(uris);
    expect(apiMock).toHaveBeenLastCalledWith("DELETE", "/me/library", { query: { uris: uris.join(",") } });
  });
});

describe("player wrappers", () => {
  it("targets a device when one is given", async () => {
    await sp.play("dev", { context_uri: "spotify:album:a" });
    expect(apiMock).toHaveBeenLastCalledWith("PUT", "/me/player/play", {
      query: { device_id: "dev" },
      body: { context_uri: "spotify:album:a" },
    });
  });

  it("rounds seek positions and volumes to integers", async () => {
    await sp.seek(1234.6);
    expect(lastQuery().position_ms).toBe(1235);
    await sp.setVolume(49.5);
    expect(lastQuery().volume_percent).toBe(50);
  });

  it("transfers playback in the body", async () => {
    await sp.transfer("dev", false);
    expect(apiMock).toHaveBeenLastCalledWith("PUT", "/me/player", { body: { device_ids: ["dev"], play: false } });
  });

  it("unwraps the devices list", async () => {
    apiMock.mockResolvedValue({ devices: [{ id: "a" }] });
    await expect(sp.devices()).resolves.toEqual([{ id: "a" }]);
  });
});

describe("nextPage", () => {
  it("returns a plain page as is", async () => {
    const p = page([1, 2], null);
    apiMock.mockResolvedValue(p);
    await expect(sp.nextPage("https://api.spotify.com/v1/me/tracks?offset=50")).resolves.toBe(p);
    expect(apiMock).toHaveBeenCalledWith("GET", "https://api.spotify.com/v1/me/tracks?offset=50");
  });

  it("unwraps pages nested under a key, like /me/following", async () => {
    const p = page(["artist"], null);
    apiMock.mockResolvedValue({ artists: p });
    await expect(sp.nextPage("https://api.spotify.com/v1/me/following?after=x")).resolves.toBe(p);
  });
});

describe("allPages", () => {
  it("follows next links until the end", async () => {
    apiMock.mockResolvedValueOnce(page([3, 4], "p3")).mockResolvedValueOnce(page([5], null));
    await expect(sp.allPages(page([1, 2], "p2"))).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(apiMock.mock.calls.map((c) => c[1])).toEqual(["p2", "p3"]);
  });

  it("doesn't fetch anything for a single page", async () => {
    await expect(sp.allPages(page([1], null))).resolves.toEqual([1]);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("stops requesting once it has maxItems", async () => {
    apiMock.mockImplementation(async () => page([0, 0, 0, 0, 0], "more"));
    const items = await sp.allPages(page([0, 0, 0, 0, 0], "more"), 12);
    // Whole pages are kept, so it may overshoot by less than a page.
    expect(items).toHaveLength(15);
    expect(apiMock).toHaveBeenCalledTimes(2);
  });
});

describe("itemTrack", () => {
  const track = { uri: "spotify:track:a" };

  it("reads the 2026 `item` field", () => {
    expect(sp.itemTrack({ item: track } as unknown as PlaylistItem)).toBe(track);
  });

  it("falls back to the old `track` field", () => {
    expect(sp.itemTrack({ track } as unknown as PlaylistItem)).toBe(track);
  });

  it("returns null for removed or unavailable items", () => {
    expect(sp.itemTrack({ item: null, track: null } as unknown as PlaylistItem)).toBeNull();
    expect(sp.itemTrack({} as PlaylistItem)).toBeNull();
  });
});
