import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SvelteMap } from "svelte/reactivity";
import { backend, type AppError, type DeviceStatus, type LocalEvent } from "./ipc";
import * as sp from "./spotify";
import type { PlaybackState, Track } from "./types";

const events = vi.hoisted(() => ({ emit: null as ((e: LocalEvent) => void) | null }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: LocalEvent }) => void) => {
    events.emit = (payload) => cb({ payload });
    return () => {};
  }),
}));
vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  backend: { device: vi.fn(async () => {}) },
}));
vi.mock("./spotify", () => ({
  playbackState: vi.fn(),
  play: vi.fn(async () => null),
  pause: vi.fn(async () => null),
  skipNext: vi.fn(async () => null),
  skipPrevious: vi.fn(async () => null),
  seek: vi.fn(async () => null),
  setVolume: vi.fn(async () => null),
  setShuffle: vi.fn(async () => null),
  setRepeat: vi.fn(async () => null),
  transfer: vi.fn(async () => null),
  devices: vi.fn(async () => []),
  addToQueue: vi.fn(async () => null),
}));
vi.mock("./toasts.svelte", () => ({ toasts: { show: vi.fn(), error: vi.fn() } }));
// The player derives `isLocal` from the session, so the fake has to be reactive too.
vi.mock("./session.svelte", async () => {
  const { SvelteMap } = await import("svelte/reactivity");
  const s = new SvelteMap<string, unknown>();
  return {
    session: {
      _s: s,
      get ready() {
        return s.get("ready");
      },
      get device() {
        return s.get("device");
      },
      get deviceReady() {
        return s.get("deviceReady");
      },
    },
  };
});

const { session } = (await import("./session.svelte")) as unknown as { session: { _s: SvelteMap<string, unknown> } };

const LOCAL: DeviceStatus = { state: "ready", device_id: "local", name: "Mildify", error: null };

let player: typeof import("./player.svelte").player;

function track(uri = "spotify:track:a", over: Partial<Track> = {}): Track {
  return {
    id: uri.split(":")[2],
    uri,
    name: `Track ${uri}`,
    duration_ms: 200_000,
    explicit: false,
    artists: [{ id: "ar", name: "Artist", uri: "spotify:artist:ar" }],
    track_number: 1,
    disc_number: 1,
    type: "track",
    album: {
      id: "al",
      name: "Album",
      uri: "spotify:album:al",
      album_type: "album",
      images: [
        { url: "small", width: 64, height: 64 },
        { url: "medium", width: 300, height: 300 },
        { url: "large", width: 640, height: 640 },
      ],
      artists: [],
      release_date: "2020",
      total_tracks: 1,
    },
    ...over,
  };
}

function state(over: Partial<PlaybackState> = {}, deviceId = "phone"): PlaybackState {
  return {
    device: {
      id: deviceId,
      name: deviceId === "local" ? "Mildify" : "Phone",
      type: "Smartphone",
      is_active: true,
      is_restricted: false,
      volume_percent: 70,
      supports_volume: true,
    },
    repeat_state: "off",
    shuffle_state: false,
    context: { uri: "spotify:album:al", type: "album" },
    timestamp: 0,
    progress_ms: 10_000,
    is_playing: true,
    item: track(),
    currently_playing_type: "track",
    ...over,
  };
}

const playbackState = vi.mocked(sp.playbackState);

/** Starts the player against a fresh poll result and lets the first refresh land. */
async function start(first: PlaybackState | null) {
  playbackState.mockResolvedValue(first);
  await player.start();
  await vi.advanceTimersByTimeAsync(0);
}

/** Polls right now with the given result. */
async function poll(s: PlaybackState | null) {
  playbackState.mockResolvedValueOnce(s);
  player.refreshSoon(0);
  await vi.advanceTimersByTimeAsync(0);
}

function emit(e: LocalEvent) {
  events.emit!(e);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.clearAllMocks();
  session._s.clear();
  session._s.set("ready", true);
  session._s.set("device", LOCAL);
  session._s.set("deviceReady", true);
  vi.resetModules();
  ({ player } = await import("./player.svelte"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("polling a remote device", () => {
  it("applies the playback state", async () => {
    await start(state({ shuffle_state: true, repeat_state: "context" }));
    expect(player.deviceId).toBe("phone");
    expect(player.deviceName).toBe("Phone");
    expect(player.isLocal).toBe(false);
    expect(player.isPlaying).toBe(true);
    expect(player.shuffle).toBe(true);
    expect(player.repeat).toBe("context");
    expect(player.volume).toBe(70);
    expect(player.contextUri).toBe("spotify:album:al");
    expect(player.track).toMatchObject({
      uri: "spotify:track:a",
      name: "Track spotify:track:a",
      artists: [{ name: "Artist", uri: "spotify:artist:ar" }],
      album: { name: "Album", uri: "spotify:album:al" },
      cover: "medium",
      coverLarge: "large",
      durationMs: 200_000,
    });
  });

  it("interpolates the position while playing", async () => {
    await start(state());
    expect(player.positionNow()).toBe(10_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.positionNow()).toBe(11_000);
    expect(player.position).toBe(11_000);
  });

  it("holds the position while paused", async () => {
    await start(state({ is_playing: false }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.positionNow()).toBe(10_000);
  });

  it("never runs the position past the end of the track", async () => {
    await start(state({ progress_ms: 199_500 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(player.positionNow()).toBe(200_000);
    expect(player.position).toBe(200_000);
  });

  it("clears the device when nothing is playing anywhere", async () => {
    await start(state());
    await poll(null);
    expect(player.deviceId).toBeNull();
    expect(player.isPlaying).toBe(false);
  });

  it("keeps the same track object while nothing visible changed", async () => {
    await start(state());
    const before = player.track;
    await poll(state({ progress_ms: 13_000 }));
    expect(player.track).toBe(before);
    await poll(state({ item: track("spotify:track:b") }));
    expect(player.track).not.toBe(before);
    expect(player.track?.uri).toBe("spotify:track:b");
  });

  it("polls every 3 s, and every 30 s while the window is hidden", async () => {
    await start(state());
    expect(playbackState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(playbackState).toHaveBeenCalledTimes(2);

    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(playbackState).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(playbackState).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(playbackState).toHaveBeenCalledTimes(4);
  });

  it("doesn't poll before the Web API is signed in", async () => {
    session._s.set("ready", false);
    await start(state());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(playbackState).not.toHaveBeenCalled();
  });

  it("backs off for as long as a rate limit says", async () => {
    const limited: AppError = { kind: "rate_limited", message: "Rate limited, retry in 20s", status: 429 };
    playbackState.mockRejectedValueOnce(limited);
    await start(state());
    expect(playbackState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(playbackState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(playbackState).toHaveBeenCalledTimes(2);
  });
});

describe("the embedded device", () => {
  beforeEach(async () => {
    await start(state({}, "local"));
  });

  it("is recognised as local", () => {
    expect(player.isLocal).toBe(true);
  });

  it("is polled only every 10 s, since it reports its own changes", async () => {
    expect(playbackState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(playbackState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(playbackState).toHaveBeenCalledTimes(2);
  });

  it("applies the first poll even when it lands right after launch", () => {
    // No local event has arrived yet, so there's nothing fresher to prefer.
    expect(performance.now()).toBeLessThan(2500);
    expect(player.isPlaying).toBe(true);
    expect(player.volume).toBe(70);
  });

  it("takes the position from local events, not from polls", async () => {
    emit({ type: "playing", uri: "spotify:track:a", position_ms: 5000 });
    await poll(state({ progress_ms: 9000 }, "local"));
    expect(player.positionNow()).toBe(5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.positionNow()).toBe(6000);
  });

  it("ignores position reports within jitter of its own clock", () => {
    emit({ type: "playing", uri: "spotify:track:a", position_ms: 5000 });
    emit({ type: "position", uri: "spotify:track:a", position_ms: 5060 });
    expect(player.positionNow()).toBe(5000);
    emit({ type: "position", uri: "spotify:track:a", position_ms: 5200 });
    expect(player.positionNow()).toBe(5200);
  });

  it("trusts a local pause over a stale poll for 2.5 s", async () => {
    emit({ type: "paused", uri: "spotify:track:a", position_ms: 5000 });
    expect(player.isPlaying).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    await poll(state({ is_playing: true }, "local"));
    expect(player.isPlaying).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await poll(state({ is_playing: true }, "local"));
    expect(player.isPlaying).toBe(true);
  });

  it("trusts a local volume over a stale poll for 2.5 s", async () => {
    emit({ type: "volume", percent: 30 });
    await poll(state({}, "local"));
    expect(player.volume).toBe(30);
    await vi.advanceTimersByTimeAsync(3000);
    await poll(state({}, "local"));
    expect(player.volume).toBe(70);
  });

  it("marks itself active when it starts playing", async () => {
    await poll(null);
    expect(player.deviceId).toBeNull();
    emit({ type: "playing", uri: "spotify:track:a", position_ms: 0 });
    expect(player.deviceId).toBe("local");
    expect(player.isLocal).toBe(true);
  });

  it("shows loading until playback starts", () => {
    emit({ type: "loading", uri: "spotify:track:a", position_ms: 0 });
    expect(player.isLoading).toBe(true);
    emit({ type: "playing", uri: "spotify:track:a", position_ms: 0 });
    expect(player.isLoading).toBe(false);
  });

  it("takes a new track from a track event, then fills in the album link from a poll", async () => {
    emit({
      type: "track",
      uri: "spotify:track:b",
      name: "B",
      artists: [{ uri: "spotify:artist:x", name: "X" }],
      album: "Album B",
      cover: "cover-b",
      duration_ms: 1000,
      explicit: true,
    });
    expect(player.track).toEqual({
      uri: "spotify:track:b",
      name: "B",
      artists: [{ uri: "spotify:artist:x", name: "X" }],
      album: { name: "Album B", uri: null },
      cover: "cover-b",
      coverLarge: "cover-b",
      durationMs: 1000,
      explicit: true,
    });

    playbackState.mockResolvedValue(state({ item: track("spotify:track:b") }, "local"));
    await vi.advanceTimersByTimeAsync(1200);
    expect(player.track?.album.uri).toBe("spotify:album:al");
  });

  it("keeps what it knows when a track event repeats the current track", () => {
    emit({
      type: "track",
      uri: "spotify:track:a",
      name: "A",
      artists: [],
      album: "Album",
      cover: null,
      duration_ms: 200_000,
      explicit: false,
    });
    expect(player.track?.album.uri).toBe("spotify:album:al");
    expect(player.track?.cover).toBe("medium");
    expect(player.track?.coverLarge).toBe("large");
  });

  it.each([
    [{ context: false, track: false }, "off"],
    [{ context: true, track: false }, "context"],
    [{ context: true, track: true }, "track"],
    [{ context: false, track: true }, "track"],
  ] as const)("maps repeat %o to %s", (flags, mode) => {
    emit({ type: "repeat", ...flags });
    expect(player.repeat).toBe(mode);
  });

  it("re-polls soon after playback stops (usually a transfer away)", async () => {
    emit({ type: "playing", uri: "spotify:track:a", position_ms: 0 });
    const calls = playbackState.mock.calls.length;
    emit({ type: "stopped", uri: "spotify:track:a" });
    expect(player.isPlaying).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(playbackState).toHaveBeenCalledTimes(calls + 1);
  });

  it("sends transport commands straight to the device", async () => {
    await player.togglePlay();
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    expect(sp.pause).not.toHaveBeenCalled();
    expect(player.isPlaying).toBe(false);

    await player.seek(1234.4);
    expect(backend.device).toHaveBeenLastCalledWith({ action: "seek", position_ms: 1234 });

    player.setVolume(42.6);
    expect(backend.device).toHaveBeenLastCalledWith({ action: "volume", percent: 43 });
    expect(sp.setVolume).not.toHaveBeenCalled();
  });

  it("falls back to the Web API while the device isn't ready", async () => {
    session._s.set("deviceReady", false);
    await player.next();
    expect(sp.skipNext).toHaveBeenCalledWith("local");
    expect(backend.device).not.toHaveBeenCalled();
  });
});

describe("controls on a remote device", () => {
  beforeEach(async () => {
    await start(state());
  });

  it("pauses and resumes through the Web API, optimistically", async () => {
    const done = player.togglePlay();
    expect(player.isPlaying).toBe(false);
    await done;
    expect(sp.pause).toHaveBeenCalledWith("phone");
    expect(backend.device).not.toHaveBeenCalled();
    await player.togglePlay();
    expect(sp.play).toHaveBeenCalledWith("phone");
  });

  it("freezes the position where it was paused", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    await player.togglePlay();
    await vi.advanceTimersByTimeAsync(500);
    expect(player.positionNow()).toBe(11_000);
  });

  it("cycles repeat off → context → track → off", async () => {
    await player.cycleRepeat();
    await player.cycleRepeat();
    await player.cycleRepeat();
    expect(vi.mocked(sp.setRepeat).mock.calls).toEqual([
      ["context", "phone"],
      ["track", "phone"],
      ["off", "phone"],
    ]);
    expect(player.repeat).toBe("off");
  });

  it("toggles shuffle", async () => {
    await player.toggleShuffle();
    expect(sp.setShuffle).toHaveBeenCalledWith(true, "phone");
    expect(player.shuffle).toBe(true);
  });

  it("debounces volume changes, sending the last value clamped to 0-100", async () => {
    player.setVolume(20);
    player.setVolume(60);
    player.setVolume(150);
    expect(player.volume).toBe(100);
    expect(sp.setVolume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(sp.setVolume).toHaveBeenCalledOnce();
    expect(sp.setVolume).toHaveBeenCalledWith(100, "phone");
  });

  it("toasts a failed command instead of throwing", async () => {
    const { toasts } = await import("./toasts.svelte");
    vi.mocked(sp.skipNext).mockRejectedValueOnce(new Error("offline"));
    await expect(player.next()).resolves.toBeUndefined();
    expect(toasts.error).toHaveBeenCalled();
  });

  it("plays a context on the active device", async () => {
    await player.playContext("spotify:playlist:p", "spotify:track:t");
    expect(sp.play).toHaveBeenCalledWith("phone", { context_uri: "spotify:playlist:p", offset: { uri: "spotify:track:t" } });
    await player.playUris(["spotify:track:1", "spotify:track:2"], 1);
    expect(sp.play).toHaveBeenLastCalledWith("phone", {
      uris: ["spotify:track:1", "spotify:track:2"],
      offset: { position: 1 },
    });
  });
});

describe("with nothing playing anywhere", () => {
  beforeEach(async () => {
    await start(null);
  });

  it("plays on the embedded device", async () => {
    await player.playContext("spotify:album:x");
    expect(sp.play).toHaveBeenCalledWith("local", { context_uri: "spotify:album:x", offset: undefined });
  });

  it("activates the embedded device and retries when Spotify doesn't know it yet", async () => {
    vi.mocked(sp.play).mockRejectedValueOnce({ kind: "api", message: "Device not found", status: 404 });
    const done = player.playContext("spotify:album:x");
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(sp.transfer).toHaveBeenCalledWith("local", false);
    expect(sp.play).toHaveBeenCalledTimes(2);
    expect(sp.play).toHaveBeenLastCalledWith("local", { context_uri: "spotify:album:x", offset: undefined });
  });

  it("resumes on the embedded device from the play button", async () => {
    await player.togglePlay();
    expect(sp.transfer).toHaveBeenCalledWith("local", true);
    expect(player.deviceId).toBe("local");
  });

  it("says so when there is no device to play on", async () => {
    const { toasts } = await import("./toasts.svelte");
    session._s.set("deviceReady", false);
    await player.playContext("spotify:album:x");
    expect(sp.play).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith(expect.stringMatching(/No playback device/), "error");
  });
});
