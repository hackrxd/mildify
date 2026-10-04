import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DjStatus } from "./ipc";
import type { Track } from "./types";

const DURATION = 200_000;

const backend = vi.hoisted(() => ({
  djStatus: vi.fn(),
  djConfigure: vi.fn(),
  djInstall: vi.fn(async () => {}),
  djCancel: vi.fn(async () => {}),
  djRemove: vi.fn(),
  djWarm: vi.fn(async () => {}),
  djGenerate: vi.fn(),
  djSpeak: vi.fn(),
  djSpeech: vi.fn(async () => new ArrayBuffer(8)),
  djDuck: vi.fn(async () => {}),
  djRelease: vi.fn(async () => {}),
  lyrics: vi.fn(),
  device: vi.fn(async () => {}),
}));
const sp = vi.hoisted(() => ({
  topTracksIn: vi.fn(),
  recentlyPlayed: vi.fn(async () => ({ items: [] })),
  savedTracks: vi.fn(async () => ({ items: [], total: 0 })),
  addToQueue: vi.fn(async (_uri: string, _device?: string) => null),
}));
const player = vi.hoisted(() => ({
  track: null as { uri: string; durationMs: number } | null,
  pos: 0,
  isPlaying: true,
  isLocal: true,
  deviceId: "here" as string | null,
  volume: 100,
  positionNow(): number {
    return this.pos;
  },
  playUris: vi.fn(async (..._args: unknown[]) => true),
  togglePlay: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./ipc", () => ({ backend }));
vi.mock("./spotify", () => sp);
vi.mock("./player.svelte", () => ({ player }));
vi.mock("./session.svelte", () => ({
  session: {
    deviceReady: true,
    device: { device_id: "here", name: "Mildify", state: "ready", error: null },
    user: { id: "u", display_name: "Sam Smith" },
  },
}));
vi.mock("./toasts.svelte", () => ({ toasts }));

let mod: typeof import("./dj.svelte");
let timing: typeof import("./djTiming");

class FakeVoice {
  played: { gain: number; onEnd: () => void }[] = [];
  ensure() {
    return {};
  }
  decode = vi.fn(async () => ({}) as AudioBuffer);
  play(_buffer: AudioBuffer, gain: number, onEnd: () => void) {
    this.played.push({ gain, onEnd });
  }
  setGain() {}
  now() {
    return 0;
  }
  stop = vi.fn();
}

function song(n: number): Track {
  return {
    id: `t${n}`,
    uri: `spotify:track:t${n}`,
    name: `Song ${n}`,
    duration_ms: DURATION,
    explicit: false,
    artists: [{ id: `a${n}`, name: `Artist ${n}`, uri: `spotify:artist:a${n}` }],
    track_number: 1,
    disc_number: 1,
    type: "track",
    album: { id: "al", name: "Album", uri: "spotify:album:al", album_type: "album", images: [], artists: [], release_date: "2020", total_tracks: 1 },
  };
}

/** A synced lyric whose singing runs from `first` to `last` ms. */
function sync(first: number, last: number) {
  return { Type: "Line", Content: [{ Text: "la", StartTime: first / 1000, EndTime: last / 1000 }] };
}

const readyStatus = {
  supported: true,
  ready: true,
  settings: { enabled: true, model: "qwen2.5-1.5b", voice: "michael", server_url: "", server_model: "" },
  needed: [],
  install: { running: false, component: null, received: 0, total: null, error: null },
  disk_bytes: 1,
  folder: "/dj",
  models: [],
  voices: [],
} as DjStatus;

let voice: FakeVoice;
let dj: InstanceType<typeof mod.Dj>;
let speechMs: number;
let answers: number;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  localStorage.clear();
  for (const fn of [...Object.values(backend), ...Object.values(sp), player.playUris, player.togglePlay, toasts.show, toasts.error]) {
    fn.mockClear();
  }
  Object.assign(player, { track: null, pos: 0, isPlaying: true, isLocal: true, deviceId: "here", volume: 100 });
  speechMs = 6000;
  answers = 0;
  sp.topTracksIn.mockImplementation(async (range: string, offset: number) => ({
    items: range === "short_term" && offset === 0 ? Array.from({ length: 12 }, (_, i) => song(i + 1)) : [],
    next: null,
    total: 12,
    offset,
    limit: 20,
  }));
  // Each answer picks three songs it hasn't picked before.
  backend.djGenerate.mockImplementation(async () => {
    answers++;
    return { name: `Set ${answers}`, songs: [1, 2, 3], talk: `Here's set number ${answers}, nice and easy.` };
  });
  backend.djSpeak.mockImplementation(async (text: string) => ({ id: 1, duration_ms: speechMs, sentences: [{ text, start_ms: 0, end_ms: speechMs }] }));
  backend.lyrics.mockImplementation(async () => sync(3000, 150_000));
  backend.djConfigure.mockImplementation(async () => readyStatus);
  mod = await import("./dj.svelte");
  timing = await import("./djTiming");
  voice = new FakeVoice();
  dj = new mod.Dj(voice as unknown as InstanceType<typeof mod.Voice>);
  dj.status = readyStatus;
});

afterEach(() => {
  dj.stop();
  vi.useRealTimers();
});

const tick = () => vi.advanceTimersByTimeAsync(mod.TICK_MS);

/** Plays `uri` from `pos`, and lets the DJ notice. */
async function playing(uri: string, pos: number) {
  player.track = { uri, durationMs: DURATION };
  player.pos = pos;
  await tick();
}

/** Starts a session and plays its first song, with the next set picked. */
async function started() {
  await dj.start();
  await vi.advanceTimersByTimeAsync(5000);
  voice.played[0]?.onEnd();
  const first = dj.upNext!;
  await playing(first.songs[0].uri, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(dj.current).toBe(first);
  expect(dj.upNext).not.toBeNull();
  return first;
}

describe("settings", () => {
  it("keeps the listener's instructions, within the limit", async () => {
    const { INSTRUCTIONS_MAX } = await import("./djPicks");
    dj.setInstructions("Talk like a pirate.");
    expect(localStorage.getItem("nativify:djInstructions")).toBe("Talk like a pirate.");
    dj.setInstructions("x".repeat(INSTRUCTIONS_MAX + 50));
    expect(dj.instructions).toHaveLength(INSTRUCTIONS_MAX);
    dj.setInstructions("   ");
    expect(localStorage.getItem("nativify:djInstructions")).toBeNull();
  });

  it("turning the DJ off ends a session", async () => {
    await dj.start();
    expect(dj.phase).toBe("on");
    await dj.configure({ enabled: false });
    expect(dj.phase).toBe("off");
    expect(backend.djConfigure).toHaveBeenCalledWith({ enabled: false });
  });
});

describe("starting", () => {
  it("waits until everything is downloaded", async () => {
    dj.status = { ...readyStatus, ready: false };
    await dj.start();
    expect(dj.phase).toBe("off");
    expect(toasts.show).toHaveBeenCalled();
    expect(sp.topTracksIn).not.toHaveBeenCalled();
  });

  it("greets, then brings the first song in under the end of the line", async () => {
    await dj.start();
    expect(dj.phase).toBe("on");
    // The prompt carries the listener's first name and asks for JSON that fits a schema.
    const [messages, schema] = backend.djGenerate.mock.calls[0] as unknown as [{ content: string }[], object];
    expect(messages[1].content).toContain("The listener's name is Sam.");
    expect(schema).toHaveProperty("properties.songs");
    // Talking over whatever played before, turned down.
    expect(voice.played).toHaveLength(1);
    expect(backend.djDuck).toHaveBeenCalledWith(timing.DUCK_LEVEL, 0, timing.DUCK_DOWN_MS);
    expect(dj.said).toEqual([{ name: "Set 1", talk: "Here's set number 1, nice and easy.", byModel: true }]);
    expect(dj.caption?.[0].text).toBe("Here's set number 1, nice and easy.");
    // 6 s of talk over a 3 s intro: the music is asked for 3.7 s in, less the time it takes to start.
    const wait = speechMs - (3000 - timing.VOCAL_GAP_MS) - mod.PLAY_LATENCY_MS;
    await vi.advanceTimersByTimeAsync(wait - 10);
    expect(player.playUris).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    const set = dj.upNext!;
    expect(player.playUris).toHaveBeenCalledWith(set.songs.map((s) => s.uri), 0, true);
    // The line ends: the music comes back up.
    voice.played[0].onEnd();
    expect(dj.speaking).toBe(false);
    expect(backend.djDuck).toHaveBeenLastCalledWith(1, 0, timing.DUCK_UP_MS);
  });

  it("talks from a template when the model doesn't answer", async () => {
    backend.djGenerate.mockRejectedValue(new Error("no model"));
    await dj.start();
    expect(dj.said[0].byModel).toBe(false);
    expect(dj.said[0].talk).toMatch(/^Hey Sam, it's your DJ\./);
  });

  it("plays on without a voice when the voice fails", async () => {
    backend.djSpeak.mockRejectedValue(new Error("no voice"));
    await dj.start();
    expect(voice.played).toHaveLength(0);
    expect(player.playUris).toHaveBeenCalledTimes(1);
  });

  it("gives up when its songs never start", async () => {
    await dj.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(player.playUris).toHaveBeenCalled();
    expect(dj.phase).toBe("on");
    await vi.advanceTimersByTimeAsync(mod.START_TIMEOUT_MS);
    expect(dj.phase).toBe("off");
    expect(toasts.show).toHaveBeenCalledWith(expect.stringContaining("couldn't get its songs playing"), "error");
  });

  it("refuses a session without enough listening", async () => {
    sp.topTracksIn.mockResolvedValue({ items: [song(1)], next: null, total: 1, offset: 0, limit: 20 });
    await dj.start();
    expect(dj.phase).toBe("off");
    expect(toasts.error).toHaveBeenCalled();
  });
});

describe("between sets", () => {
  it("queues the next set during the last song and talks over its end", async () => {
    const first = await started();
    const next = dj.upNext!;
    const last = first.songs[first.songs.length - 1];
    await playing(last.uri, 100_000);
    await tick();
    expect(sp.addToQueue.mock.calls.map((c) => c[0])).toEqual(next.songs.map((s) => s.uri));

    // 6 s of talk, the next intro fits 2.3 s: talk starts 3.7 s before the end, in the outro after the singing.
    const talkAt = DURATION - (speechMs - (3000 - timing.VOCAL_GAP_MS));
    voice.played = [];
    player.pos = talkAt - 900;
    await tick();
    expect(backend.djDuck).toHaveBeenLastCalledWith(timing.DUCK_LEVEL, expect.any(Number), timing.DUCK_DOWN_MS);
    expect(voice.played).toHaveLength(0);
    player.pos = talkAt - 300;
    await tick();
    await vi.advanceTimersByTimeAsync(300);
    expect(voice.played).toHaveLength(1);
    expect(dj.said.at(-1)?.name).toBe(next.name);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });

    // The queued set comes up: it's the current one, and the one after is picked.
    const asked = backend.djGenerate.mock.calls.length;
    await playing(next.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.current).toBe(next);
    expect(backend.djGenerate.mock.calls.length).toBe(asked + 1);
    expect(voice.played).toHaveLength(1);
  });

  it("holds the next song while a long line finishes, so it never talks over singing", async () => {
    speechMs = 20_000;
    // Every song sings until 2 s before its end.
    backend.lyrics.mockImplementation(async () => sync(3000, DURATION - 2000));
    const first = await started();
    const last = first.songs[first.songs.length - 1];
    await playing(first.songs[1].uri, 0);
    await playing(last.uri, 100_000);
    await tick();
    await tick();
    const overOld = 2000 - timing.VOCAL_GAP_MS;
    const hold = speechMs - (3000 - timing.VOCAL_GAP_MS) - overOld;
    player.pos = DURATION - overOld;
    await tick();
    expect(dj.speaking).toBe(true);
    player.pos = DURATION - mod.HOLD_EARLY_MS;
    await tick();
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    player.isPlaying = false;
    await vi.advanceTimersByTimeAsync(hold - 50);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "play" });
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.device).toHaveBeenCalledWith({ action: "play" });
  });

  it("says its line straight away when the listener skips into the next set", async () => {
    const first = await started();
    const next = dj.upNext!;
    await playing(first.songs[first.songs.length - 1].uri, 10_000);
    await tick();
    voice.played = [];
    await playing(next.songs[0].uri, 0);
    expect(dj.current).toBe(next);
    expect(voice.played).toHaveLength(1);
  });
});

describe("stepping out", () => {
  it("stops when the listener plays something else, and lifts the music", async () => {
    await started();
    await playing("spotify:track:somethingElse", 0);
    await vi.advanceTimersByTimeAsync(mod.FOREIGN_MS + mod.TICK_MS * 2);
    expect(dj.phase).toBe("off");
    expect(toasts.show).toHaveBeenCalledWith(expect.stringContaining("something else"));
    expect(backend.djRelease).toHaveBeenCalled();
  });

  it("stops when the music moves to another device", async () => {
    await started();
    player.isLocal = false;
    player.deviceId = "phone";
    await vi.advanceTimersByTimeAsync(mod.FOREIGN_MS + mod.TICK_MS * 2);
    expect(dj.phase).toBe("off");
  });

  it("remembers what it played, so the next session starts somewhere else", async () => {
    const first = await started();
    const played = JSON.parse(localStorage.getItem("nativify:djPlayed") ?? "{}");
    expect(Object.keys(played)).toContain(first.songs[0].uri);
  });

  it("stopping lifts a duck and frees the model", async () => {
    await dj.start();
    dj.stop();
    expect(backend.djDuck).toHaveBeenLastCalledWith(1, 0, timing.DUCK_UP_MS);
    expect(backend.djRelease).toHaveBeenCalled();
    expect(voice.stop).toHaveBeenCalled();
  });
});
