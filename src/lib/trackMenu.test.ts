import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "./types";

const saved = vi.hoisted(() => new Map<string, boolean>());
const liked = vi.hoisted(() => ({ has: (uri: string) => saved.get(uri), toggle: vi.fn() }));
const player = vi.hoisted(() => ({ addToQueue: vi.fn() }));
const router = vi.hoisted(() => ({ go: vi.fn() }));
const mods = vi.hoisted(() => ({ trackMenu: vi.fn((_t: unknown) => [] as { label: string; action: () => void }[]) }));
vi.mock("./liked.svelte", () => ({ liked }));
vi.mock("./player.svelte", () => ({ player }));
vi.mock("./router.svelte", () => ({ router }));
vi.mock("./mods.svelte", () => ({ mods }));

const { trackMenu } = await import("./trackMenu");

function track(artists: string[], album = true): Track {
  return {
    id: "t1",
    uri: "spotify:track:t1",
    name: "Song",
    duration_ms: 1,
    explicit: false,
    artists: artists.map((name, i) => ({ id: `a${i}`, name, uri: `spotify:artist:a${i}` })),
    track_number: 1,
    disc_number: 1,
    type: "track",
    ...(album
      ? { album: { id: "al", name: "Album", uri: "spotify:album:al", album_type: "album", images: [], artists: [], release_date: "2020", total_tracks: 1 } }
      : {}),
  } as Track;
}

beforeEach(() => {
  saved.clear();
  for (const fn of [liked.toggle, player.addToQueue, router.go, mods.trackMenu]) fn.mockClear();
});

describe("trackMenu", () => {
  it("queues, likes, and goes to the album and the artist, then what extensions add", () => {
    saved.set("spotify:track:t1", false);
    const share = { label: "Share", action: () => {} };
    mods.trackMenu.mockReturnValueOnce([share]);
    const items = trackMenu(track(["Sam"]));
    expect(items.map((i) => i.label)).toEqual(["Add to queue", "Save to Liked Songs", "Go to album", "Go to artist", "Share"]);
    expect(items[1].disabled).toBe(false);
    for (const item of items.slice(0, 4)) item.action();
    expect(player.addToQueue).toHaveBeenCalledWith("spotify:track:t1");
    expect(liked.toggle).toHaveBeenCalledWith("spotify:track:t1");
    expect(router.go.mock.calls).toEqual([[{ name: "album", id: "al" }], [{ name: "artist", id: "a0" }]]);
  });

  it("names each of up to three artists, and offers to remove a liked song", () => {
    saved.set("spotify:track:t1", true);
    const labels = trackMenu(track(["A", "B", "C", "D"])).map((i) => i.label);
    expect(labels).toEqual(["Add to queue", "Remove from Liked Songs", "Go to album", "Go to A", "Go to B", "Go to C"]);
  });

  it("leaves out the queue where it's asked to, an album the track doesn't have, and a like it can't tell yet", () => {
    const items = trackMenu(track(["Sam"], false), { queue: false });
    expect(items.map((i) => i.label)).toEqual(["Save to Liked Songs", "Go to artist"]);
    expect(items[0].disabled).toBe(true);
  });
});
