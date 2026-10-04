import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlaying } from "./player.svelte";

type Handler = (e: { payload: unknown }) => Promise<void>;
let handler: Handler | undefined;
const devtoolsAnswer = vi.fn(async (..._: unknown[]) => {});

const player = {
  track: null as NowPlaying | null,
  isPlaying: false,
  volume: 50,
  positionNow: vi.fn(() => 1234.5),
  seek: vi.fn(async (_ms: number) => {}),
  setVolume: vi.fn((_p: number) => {}),
  togglePlay: vi.fn(async () => {}),
  next: vi.fn(async () => {}),
  prev: vi.fn(async () => {}),
};

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_: string, fn: Handler) => {
    handler = fn;
    return () => {};
  },
}));
vi.mock("./ipc", () => ({ backend: { devtoolsAnswer: (...a: unknown[]) => devtoolsAnswer(...a) } }));
vi.mock("./player.svelte", () => ({ player }));
// Like the real DJ: its item takes play/pause and next while it's up, and previous does nothing then; otherwise
// they reach the player.
const dj = {
  onAir: null as object | null,
  togglePause: vi.fn(() => (dj.onAir ? undefined : player.togglePlay())),
  skipTalk: vi.fn(() => (dj.onAir ? undefined : player.next())),
  previous: vi.fn(() => (dj.onAir ? undefined : player.prev())),
};
vi.mock("./dj.svelte", () => ({ dj }));

let devtools: typeof import("./devtools");

const song: NowPlaying = {
  uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
  name: "Song",
  artists: [{ name: "Artist", uri: "spotify:artist:a" }],
  album: { name: "Album", uri: null },
  cover: "small.jpg",
  coverLarge: "large.jpg",
  durationMs: 200000,
  explicit: true,
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  handler = undefined;
  Object.assign(player, { track: null, isPlaying: false, volume: 50 });
  devtools = await import("./devtools");
});

describe("snapshot", () => {
  it("reads the player in devtools.rs's shape", () => {
    Object.assign(player, { track: song, isPlaying: true, volume: 30 });
    expect(devtools.snapshot()).toEqual({
      track: {
        uri: song.uri,
        name: "Song",
        artists: song.artists,
        album: song.album,
        art: "large.jpg",
        duration_ms: 200000,
        explicit: true,
      },
      position_ms: 1234.5,
      playing: true,
      volume: 30,
    });
  });

  it("falls back to the small cover, and to no track", () => {
    player.track = { ...song, coverLarge: null };
    expect(devtools.snapshot().track?.art).toBe("small.jpg");
    player.track = null;
    expect(devtools.snapshot().track).toBeNull();
  });
});

describe("act", () => {
  it("runs each control on the player", async () => {
    expect(await devtools.act({ action: "seek", position_ms: 5000 })).toBeNull();
    expect(player.seek).toHaveBeenCalledWith(5000);
    await devtools.act({ action: "volume", fraction: 0.25 });
    expect(player.setVolume).toHaveBeenCalledWith(25);
    await devtools.act({ action: "toggle_play" });
    await devtools.act({ action: "next" });
    await devtools.act({ action: "back" });
    expect(player.togglePlay).toHaveBeenCalledOnce();
    expect(player.next).toHaveBeenCalledOnce();
    expect(player.prev).toHaveBeenCalledOnce();
  });

  it("acts on the DJ's talk while it's the item playing", async () => {
    dj.onAir = { name: "Set" };
    await devtools.act({ action: "toggle_play" });
    await devtools.act({ action: "next" });
    await devtools.act({ action: "back" });
    await devtools.act({ action: "seek", position_ms: 5000 });
    expect(dj.togglePause).toHaveBeenCalledOnce();
    expect(dj.skipTalk).toHaveBeenCalledOnce();
    expect(player.togglePlay).not.toHaveBeenCalled();
    expect(player.next).not.toHaveBeenCalled();
    expect(player.prev).not.toHaveBeenCalled();
    expect(player.seek).not.toHaveBeenCalled();
    dj.onAir = null;
  });
});

describe("startDevtools", () => {
  it("answers each ask with its id", async () => {
    await devtools.startDevtools();
    player.track = song;
    await handler!({ payload: { id: 7, ask: { action: "snapshot" } } });
    expect(devtoolsAnswer).toHaveBeenCalledWith(7, devtools.snapshot());
    await handler!({ payload: { id: 8, ask: { action: "next" } } });
    expect(devtoolsAnswer).toHaveBeenLastCalledWith(8, null);
  });

  it("still answers when a control fails, so the caller isn't left waiting", async () => {
    await devtools.startDevtools();
    player.next.mockRejectedValueOnce(new Error("offline"));
    await handler!({ payload: { id: 9, ask: { action: "next" } } });
    expect(devtoolsAnswer).toHaveBeenCalledWith(9, null);
  });
});
