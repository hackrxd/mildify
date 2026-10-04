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
  /** Where the song was when `pos` was last set; it moves on while playing, like the real player's. */
  setPos: 0,
  setAt: 0,
  get pos(): number {
    return this.setPos;
  },
  set pos(ms: number) {
    this.setPos = ms;
    this.setAt = performance.now();
  },
  isPlaying: true,
  isLocal: true,
  deviceId: "here" as string | null,
  volume: 100,
  shuffle: false,
  repeat: "off" as "off" | "context" | "track",
  positionNow(): number {
    return this.isPlaying ? this.setPos + (performance.now() - this.setAt) : this.setPos;
  },
  playUris: vi.fn(async (..._args: unknown[]) => true),
  togglePlay: vi.fn(),
  next: vi.fn(),
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

/** A voice whose lines take real (fake-timer) time, and can be paused. */
class FakeVoice {
  played: { gain: number; onEnd: () => void }[] = [];
  startedAt = 0;
  pausedAt: number | null = null;
  sounding = false;
  ensure() {
    return {};
  }
  decode = vi.fn(async () => ({}) as AudioBuffer);
  play(_buffer: AudioBuffer, gain: number, onEnd: () => void) {
    this.played.push({ gain, onEnd });
    this.startedAt = performance.now();
    this.pausedAt = null;
    this.sounding = true;
  }
  pause = vi.fn(() => {
    this.pausedAt ??= performance.now();
  });
  resume = vi.fn(() => {
    if (this.pausedAt !== null) this.startedAt += performance.now() - this.pausedAt;
    this.pausedAt = null;
  });
  setGain() {}
  now() {
    return this.sounding ? (this.pausedAt ?? performance.now()) - this.startedAt : 0;
  }
  stop = vi.fn(() => {
    this.sounding = false;
  });
  /** The line plays out. */
  end() {
    this.sounding = false;
    this.played.at(-1)?.onEnd();
  }
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
  setup: null,
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
  for (const fn of [
    ...Object.values(backend),
    ...Object.values(sp),
    player.playUris,
    player.togglePlay,
    player.next,
    toasts.show,
    toasts.error,
  ]) {
    fn.mockClear();
  }
  Object.assign(player, {
    track: null,
    pos: 0,
    isPlaying: true,
    isLocal: true,
    deviceId: "here",
    volume: 100,
    shuffle: false,
    repeat: "off",
  });
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
  await vi.advanceTimersByTimeAsync(speechMs);
  voice.end();
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

  it("greets as an item of its own, and brings the first song in near the end of the line", async () => {
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
    const set = dj.upNext!;
    expect(dj.onAir).toEqual({ name: "Set 1", durationMs: speechMs, next: set.songs[0] });
    // 6 s of talk, a 3 s intro: the song is asked for 3.7 s in, less the time it takes to start, so the DJ
    // is done 0.7 s before the singer.
    const wait = speechMs - (3000 - timing.VOCAL_GAP_MS) - mod.PLAY_LATENCY_MS;
    await vi.advanceTimersByTimeAsync(wait - 10);
    expect(player.playUris).not.toHaveBeenCalled();
    expect(dj.talkMs).toBeGreaterThan(wait - 300);
    await vi.advanceTimersByTimeAsync(20);
    expect(player.playUris).toHaveBeenCalledWith(set.songs.map((s) => s.uri), 0, true);
    // The line ends: the music comes back up, and the DJ's item gives way once its song is in.
    voice.end();
    expect(dj.speaking).toBe(false);
    expect(backend.djDuck).toHaveBeenLastCalledWith(1, 0, timing.DUCK_UP_MS);
    expect(dj.onAir).not.toBeNull();
    await playing(set.songs[0].uri, 2000);
    expect(dj.onAir).toBeNull();
  });

  it("starts the first song after the line when talking over beginnings is off", async () => {
    dj.setOverStart(false);
    expect(localStorage.getItem("nativify:djOverStart")).toBe("false");
    await dj.start();
    await vi.advanceTimersByTimeAsync(speechMs - 50);
    expect(player.playUris).not.toHaveBeenCalled();
    voice.end();
    expect(player.playUris).toHaveBeenCalledTimes(1);
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
  /** Plays the current set's last song from 100 s in, so the next set gets queued and planned. */
  async function lastSong(first: { songs: { uri: string }[] }) {
    await playing(first.songs[1].uri, 0);
    await playing(first.songs[first.songs.length - 1].uri, 100_000);
    await tick();
    await tick();
  }

  it("queues the next set during the last song, and talks over its end into the next", async () => {
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    expect(sp.addToQueue.mock.calls.map((c) => c[0])).toEqual(next.songs.map((s) => s.uri));

    // 6 s of talk, 2.3 s of it over the next intro: it starts 3.7 s before the end, after the singing.
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
    expect(dj.onAir?.name).toBe(next.name);
    expect(dj.said.at(-1)?.name).toBe(next.name);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });

    // The queued set comes up under the voice: current now, the one after gets picked, and the DJ's item
    // lasts until it's done talking.
    const asked = backend.djGenerate.mock.calls.length;
    await playing(next.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.current).toBe(next);
    expect(backend.djGenerate.mock.calls.length).toBe(asked + 1);
    expect(voice.played).toHaveLength(1);
    expect(dj.onAir).not.toBeNull();
    voice.end();
    expect(dj.onAir).toBeNull();
  });

  it("talks on its own as long as it needs, and the next song comes in before its singer", async () => {
    speechMs = 20_000;
    // Every song sings until 2 s before its end.
    backend.lyrics.mockImplementation(async () => sync(3000, DURATION - 2000));
    const first = await started();
    await lastSong(first);
    const overOld = 2000 - timing.VOCAL_GAP_MS;
    const musicAt = speechMs - (3000 - timing.VOCAL_GAP_MS);
    player.pos = DURATION - overOld;
    await tick();
    expect(dj.speaking).toBe(true);
    const talkStarted = performance.now();
    player.pos = DURATION - mod.HOLD_EARLY_MS;
    await tick();
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    player.isPlaying = false;
    await vi.advanceTimersByTimeAsync(talkStarted + musicAt - performance.now() - 20);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "next" });
    await vi.advanceTimersByTimeAsync(40);
    expect(backend.device).toHaveBeenCalledWith({ action: "next" });
    expect(backend.device).toHaveBeenLastCalledWith({ action: "play" });
  });

  it("waits for the song to end when talking over ends is off", async () => {
    dj.setOverEnd(false);
    const first = await started();
    await lastSong(first);
    player.pos = DURATION - 1000;
    await tick();
    expect(dj.speaking).toBe(false);
    player.pos = DURATION - mod.HOLD_EARLY_MS;
    await tick();
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    expect(dj.speaking).toBe(true);
  });

  it("brings the next song in only once it's done when talking over beginnings is off", async () => {
    dj.setOverStart(false);
    const first = await started();
    await lastSong(first);
    player.pos = DURATION - timing.MAX_OVER_OUTRO_MS;
    await tick();
    expect(dj.speaking).toBe(true);
    player.pos = DURATION - mod.HOLD_EARLY_MS;
    await tick();
    player.isPlaying = false;
    await vi.advanceTimersByTimeAsync(speechMs - 1000);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "next" });
    voice.end();
    expect(backend.device).toHaveBeenCalledWith({ action: "next" });
  });

  it("starts a short line with the next song when it fits the intro", async () => {
    speechMs = 2000;
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    player.pos = DURATION - 500;
    await tick();
    expect(dj.speaking).toBe(false);
    voice.played = [];
    await playing(next.songs[0].uri, 0);
    expect(voice.played).toHaveLength(1);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
  });

  it("puts its item first when the listener skips into the next set", async () => {
    const first = await started();
    const next = dj.upNext!;
    await playing(first.songs[first.songs.length - 1].uri, 10_000);
    await tick();
    voice.played = [];
    await playing(next.songs[0].uri, 0);
    expect(dj.current).toBe(next);
    expect(voice.played).toHaveLength(1);
    // The song waits at its start, and comes back in where the rest of the line fits its intro.
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    expect(dj.onAir?.name).toBe(next.name);
    await vi.advanceTimersByTimeAsync(speechMs - (3000 - timing.VOCAL_GAP_MS));
    expect(backend.device).toHaveBeenCalledWith({ action: "seek", position_ms: 0 });
    expect(backend.device).toHaveBeenLastCalledWith({ action: "play" });
    voice.end();
    expect(dj.onAir).toBeNull();
  });
});

describe("the DJ's item", () => {
  it("next skips the rest of the talk and brings its song in", async () => {
    speechMs = 20_000;
    const first = await started();
    await lastSong2(first);
    expect(dj.speaking).toBe(true);
    dj.skipTalk();
    expect(dj.speaking).toBe(false);
    expect(backend.device).toHaveBeenCalledWith({ action: "next" });
    expect(backend.djDuck).toHaveBeenLastCalledWith(1, 0, timing.DUCK_UP_MS);
    expect(player.next).not.toHaveBeenCalled();
    await playing(dj.upNext!.songs[0].uri, 0);
    expect(dj.onAir).toBeNull();
    // With no DJ item up, next is the player's again.
    dj.skipTalk();
    expect(player.next).toHaveBeenCalled();
  });

  it("pause holds the talk and the music under it", async () => {
    speechMs = 20_000;
    const first = await started();
    await lastSong2(first);
    expect(player.isPlaying).toBe(true);
    dj.togglePause();
    expect(dj.paused).toBe(true);
    expect(voice.pause).toHaveBeenCalled();
    expect(backend.device).toHaveBeenLastCalledWith({ action: "pause" });
    const held = dj.speechNow();
    await vi.advanceTimersByTimeAsync(3000);
    expect(dj.speechNow()).toBe(held);
    dj.togglePause();
    expect(dj.paused).toBe(false);
    expect(voice.resume).toHaveBeenCalled();
    expect(backend.device).toHaveBeenLastCalledWith({ action: "play" });
    expect(player.togglePlay).not.toHaveBeenCalled();
  });
});

/** Plays to the point where the DJ starts talking over the current set's last song. */
async function lastSong2(first: { songs: { uri: string }[] }) {
  await playing(first.songs[1].uri, 0);
  await playing(first.songs[first.songs.length - 1].uri, 100_000);
  await tick();
  await tick();
  player.pos = DURATION - timing.MAX_OVER_OUTRO_MS;
  await tick();
}

describe("shuffle and repeat", () => {
  it("are off while the DJ plays, and back as they were when it stops", async () => {
    player.shuffle = true;
    player.repeat = "track";
    const first = await started();
    expect(backend.device).toHaveBeenCalledWith({ action: "shuffle", on: false });
    expect(backend.device).toHaveBeenCalledWith({ action: "repeat", mode: "off" });
    // The player reports them off; nothing more is sent.
    player.shuffle = false;
    player.repeat = "off";
    backend.device.mockClear();
    await playing(first.songs[1].uri, 0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.device).not.toHaveBeenCalled();
    dj.stop();
    expect(backend.device).toHaveBeenCalledWith({ action: "shuffle", on: true });
    expect(backend.device).toHaveBeenCalledWith({ action: "repeat", mode: "track" });
  });

  it("are left alone when they were off", async () => {
    await started();
    dj.stop();
    expect(backend.device).not.toHaveBeenCalledWith(expect.objectContaining({ action: "shuffle" }));
    expect(backend.device).not.toHaveBeenCalledWith(expect.objectContaining({ action: "repeat" }));
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
