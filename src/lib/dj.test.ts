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
  djLookUp: vi.fn(),
  djSongInfo: vi.fn(),
  djSetKey: vi.fn(),
  djSpeak: vi.fn(),
  djVoice: vi.fn(async (_command: unknown) => {}),
  djDuck: vi.fn(async () => {}),
  djRelease: vi.fn(async () => {}),
  lyrics: vi.fn(),
  device: vi.fn(async (_command: unknown) => {}),
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
  playingNow: true,
  get isPlaying(): boolean {
    return this.playingNow;
  },
  /** Pausing stops the song where it is. */
  set isPlaying(on: boolean) {
    this.setPos = this.positionNow();
    this.setAt = performance.now();
    this.playingNow = on;
  },
  isLocal: true,
  deviceId: "here" as string | null,
  volume: 100,
  shuffle: false,
  repeat: "off" as "off" | "context" | "track",
  positionNow(): number {
    return this.playingNow ? this.setPos + (performance.now() - this.setAt) : this.setPos;
  },
  playUris: vi.fn(async (..._args: unknown[]) => true),
  togglePlay: vi.fn(),
  next: vi.fn(),
  prev: vi.fn(),
  seek: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn() }));

const events = vi.hoisted(() => ({ handlers: new Map<string, (e: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
    events.handlers.set(name, fn);
    return () => {};
  },
}));
vi.mock("./ipc", async (actual) => ({ ...(await actual<typeof import("./ipc")>()), backend }));
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
const lyricsState = vi.hoisted(() => ({ songOffsets: {} as Record<string, number> }));
vi.mock("./lyrics.svelte", () => ({ lyrics: lyricsState }));
const likedState = vi.hoisted(() => ({ saved: new Map<string, boolean>() }));
vi.mock("./liked.svelte", () => ({ liked: { has: (uri: string) => likedState.saved.get(uri), ensure: () => {} } }));

let mod: typeof import("./dj.svelte");
let timing: typeof import("./djTiming");

/** A voice whose lines take real (fake-timer) time, and can be paused. */
class FakeVoice {
  played: { id: number; gain: number; onEnd: (error?: string) => void }[] = [];
  startedAt = 0;
  pausedAt: number | null = null;
  sounding = false;
  play(id: number, gain: number, onEnd: (error?: string) => void) {
    this.played.push({ id, gain, onEnd });
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
  /** The line plays out, or fails to. */
  end(error?: string) {
    this.sounding = false;
    this.played.at(-1)?.onEnd(error);
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
  settings: {
    enabled: true,
    provider: "local",
    model: "qwen2.5-1.5b",
    voice: "michael",
    server_url: "",
    server_model: "",
    own_tools: false,
    api_models: {},
    api_keys: [],
    musicbrainz: true,
  },
  keys: { openai: false, anthropic: false, gemini: false },
  tools: false,
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
    player.prev,
    player.seek,
    toasts.show,
    toasts.error,
  ]) {
    fn.mockClear();
  }
  backend.device.mockImplementation(async () => {});
  sp.addToQueue.mockImplementation(async () => null);
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
  lyricsState.songOffsets = {};
  events.handlers.clear();
  likedState.saved.clear();
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
  player.isPlaying = true;
  await tick();
}

/** Starts a session with nothing playing, and plays its first song, with the next set picked. */
async function started() {
  player.isPlaying = false;
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

describe("what the DJ is asked", () => {
  const lastPrompt = () => (backend.djGenerate.mock.calls.at(-1) as unknown as [{ content: string }[]])[0];

  it("says hello at the opening, then carries on the show with what it said before", async () => {
    const first = await started();
    const [opening] = backend.djGenerate.mock.calls[0] as unknown as [{ content: string }[]];
    expect(opening[1].content).toContain("greet the listener first");
    const [system, user] = lastPrompt();
    expect(user.content).toContain("This is set 2 of the show, already under way.");
    expect(user.content).toContain(`What you said before: "${first.talk}"`);
    expect(user.content).not.toContain("greet the listener");
    expect(system.content).toContain("Don't greet the listener");
    expect(system.content).toContain("Name only that first song");
  });

  it("counts its sets from the start of each session", async () => {
    await started();
    dj.stop();
    backend.djGenerate.mockClear();
    await started();
    expect(lastPrompt()[1].content).toContain("This is set 2 of the show");
  });

  it("knows what it's about to say for the set playing, when that set is still waiting for its talk", async () => {
    const first = await started();
    // The set playing hasn't had its say yet: as when the listener skipped into it and it waits for its line.
    dj.announced = null;
    dj.said = [];
    dj.upNext = null;
    backend.djGenerate.mockClear();
    await playing(first.songs[first.songs.length - 1].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.djGenerate).toHaveBeenCalled();
    expect(lastPrompt()[1].content).toContain(`What you said before: "${first.talk}"`);
  });

  it("says once, and on the DJ page, why it talks from templates when the model refuses", async () => {
    backend.djGenerate.mockRejectedValue({ kind: "other", message: "OpenAI didn't accept your API key: Incorrect API key" });
    await started();
    expect(toasts.show).toHaveBeenCalledWith(expect.stringContaining("OpenAI didn't accept your API key"), "error", 8000);
    expect(dj.modelTrouble).toContain("didn't accept your API key");
    expect(dj.said[0].why).toContain("didn't accept your API key");
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts.show.mock.calls.filter(([m]) => String(m).includes("talking from templates"))).toHaveLength(1);
  });

  it("doesn't blame the model for the music not waiting", async () => {
    player.isPlaying = false;
    backend.djGenerate.mockImplementation(() => new Promise(() => {}));
    const starting = dj.start();
    await vi.advanceTimersByTimeAsync(mod.OPENING_TIMEOUT_MS + 10);
    await starting;
    expect(dj.modelTrouble).toBeNull();
    expect(toasts.show).not.toHaveBeenCalledWith(expect.stringContaining("talking from templates"), "error", 8000);
    expect((dj.said[0] ?? dj.upNext)?.why).toBe("the model didn't answer in time");
  });

  it("stops when the key it's using is removed", async () => {
    dj.status = { ...readyStatus, settings: { ...readyStatus.settings, provider: "openai" } };
    backend.djSetKey.mockImplementation(async () => readyStatus);
    await started();
    await dj.setKey("openai", null);
    expect(dj.phase).toBe("off");
  });

  it("lets the DJ name every song when the listener allows it", async () => {
    dj.setNameAll(true);
    expect(localStorage.getItem("nativify:djNameAll")).toBe("true");
    await started();
    expect(lastPrompt()[0].content).not.toContain("Name only that first song");
  });

  describe("with a model that can look songs up", () => {
    const info = (uri: string) => ({
      uri,
      genres: ["synth-pop"],
      tags: [],
      released: "2011-09-30",
      label: "Mute",
      album: null,
      album_type: null,
      popularity: null,
      languages: [],
      artist_bio: null,
      artist_active: null,
      related_artists: [],
    });
    beforeEach(() => {
      dj.status = { ...readyStatus, tools: true };
      backend.djLookUp.mockImplementation(async () => ({ calls: [{ name: "look_up_songs", arguments: { songs: [2, 2, 1] } }] }));
      backend.djSongInfo.mockImplementation(async (songs: { uri: string }[]) => songs.map((s) => info(s.uri)));
    });

    it("looks up the songs it asks about, and picks knowing what was found", async () => {
      await started();
      expect(backend.djLookUp).toHaveBeenCalled();
      const [messages, tools] = backend.djLookUp.mock.calls[0] as unknown as [{ content: string }[], { name: string }[]];
      expect(messages[1].content).toContain("look_up_songs");
      expect(tools[0].name).toBe("look_up_songs");
      const [songs] = backend.djSongInfo.mock.calls[0] as unknown as [{ uri: string; name: string; artist: string; artist_id: string }[]];
      expect(songs.map((s) => s.name)).toHaveLength(2);
      expect(songs[0].artist_id).toMatch(/^a\d+$/);
      expect(songs[0].artist).toMatch(/^Artist \d+$/);
      const [, user] = (backend.djGenerate.mock.calls[0] as unknown as [{ content: string }[]])[0];
      expect(user.content).toContain("What you looked up:");
      expect(user.content).toMatch(/\n2\. Song \d+ by Artist \d+: genres synth-pop; released 2011-09-30 on Mute/);
      expect(dj.said[0].byModel).toBe(true);
    });

    it("picks without look-ups when the model doesn't want any", async () => {
      backend.djLookUp.mockImplementation(async () => ({ text: "I know these." }));
      const first = await started();
      expect(backend.djSongInfo).not.toHaveBeenCalled();
      expect(lastPrompt()[1].content).not.toContain("What you looked up");
      expect(first.byModel).toBe(true);
    });

    it("picks without look-ups when they fail", async () => {
      backend.djSongInfo.mockRejectedValue(new Error("offline"));
      const first = await started();
      expect(backend.djSongInfo).toHaveBeenCalled();
      expect(lastPrompt()[1].content).not.toContain("What you looked up");
      expect(first.byModel).toBe(true);
      expect(dj.upNext?.byModel).toBe(true);
    });

    it("talks from a template, and asks nothing more, when the music can't wait for a look-up", async () => {
      player.isPlaying = false;
      // The look-up answers, but only once the DJ has stopped waiting.
      backend.djLookUp.mockImplementation(
        () => new Promise((r) => setTimeout(() => r({ calls: [] }), mod.OPENING_TIMEOUT_MS + 5)),
      );
      const asked = backend.djGenerate.mock.calls.length;
      const starting = dj.start();
      await vi.advanceTimersByTimeAsync(mod.OPENING_TIMEOUT_MS + 10);
      await starting;
      expect(backend.djGenerate.mock.calls.length).toBe(asked);
      expect(dj.said[0]?.byModel ?? dj.upNext?.byModel).toBe(false);
    });
  });

  it("doesn't offer look-ups to a model that can't do them", async () => {
    await started();
    expect(backend.djLookUp).not.toHaveBeenCalled();
    expect(backend.djSongInfo).not.toHaveBeenCalled();
  });
});

describe("asking for a set, and skipping one", () => {
  const lastPrompt = () => (backend.djGenerate.mock.calls.at(-1) as unknown as [{ content: string }[]])[0];

  it("picks a requested set in place of the one it had ready", async () => {
    await started();
    const old = dj.upNext!;
    const asked = backend.djGenerate.mock.calls.length;
    dj.request("  something calm  ");
    expect(dj.requested).toBe("something calm");
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.djGenerate.mock.calls.length).toBe(asked + 1);
    expect(lastPrompt()[1].content).toContain('"""\nsomething calm\n"""');
    expect(dj.upNext).not.toBe(old);
    expect(dj.upNext?.request).toBe("something calm");
    // Still asked for until its set comes on.
    expect(dj.requested).toBe("something calm");
  });

  it("does nothing with a request while it's off, or an empty one", async () => {
    dj.request("something calm");
    expect(dj.requested).toBeNull();
    await started();
    dj.request("   ");
    expect(dj.requested).toBeNull();
  });

  it("keeps a request for the set after one whose talk has started, and forgets it once it's on", async () => {
    speechMs = 20_000;
    const first = await started();
    await lastSong2(first);
    expect(dj.speaking).toBe(true);
    const next = dj.upNext!;
    const asked = backend.djGenerate.mock.calls.length;
    dj.request("something calm");
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.djGenerate.mock.calls.length).toBe(asked);
    expect(dj.upNext).toBe(next);
    await playing(next.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPrompt()[1].content).toContain("something calm");
    expect(dj.upNext?.request).toBe("something calm");
    voice.end();
    // The requested set comes on.
    const requested = dj.upNext!;
    await playing(next.songs[next.songs.length - 1].uri, 100_000);
    await tick();
    await tick();
    player.pos = DURATION - timing.MAX_OVER_OUTRO_MS;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.said.at(-1)?.name).toBe(requested.name);
    expect(dj.requested).toBeNull();
  });

  it("lets go of a set it was still picking when asked for another", async () => {
    player.isPlaying = false;
    await dj.start();
    const first = dj.upNext!;
    // The next set takes the model a while.
    backend.djGenerate.mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => r({ name: "Too late", songs: [1, 2, 3], talk: "This one took a while to pick." }), 10_000)),
    );
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    await playing(first.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext).toBeNull();
    dj.request("something calm");
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext?.request).toBe("something calm");
    const requested = dj.upNext;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dj.upNext).toBe(requested);
    // Nor is it read aloud.
    expect(backend.djSpeak).not.toHaveBeenCalledWith("This one took a while to pick.");
  });

  it("takes the set it lets go of back out of the player's queue", async () => {
    const first = await started();
    await playing(first.songs[1].uri, 0);
    await playing(first.songs[first.songs.length - 1].uri, 100_000);
    await tick();
    await tick();
    expect(sp.addToQueue).toHaveBeenCalled();
    backend.device.mockClear();
    sp.addToQueue.mockClear();
    dj.request("something calm");
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.device).toHaveBeenCalledWith({ action: "clear_queue" });
    // And queues the requested one in its place.
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(sp.addToQueue.mock.calls.map((c) => c[0])).toEqual(dj.upNext!.songs.map((s) => s.uri));
  });

  it("skips the rest of a set into a next one picked again, and tells the model it was skipped", async () => {
    const first = await started();
    const ready = dj.upNext!;
    await playing(first.songs[0].uri, 30_000);
    backend.device.mockClear();
    const lines = voice.played.length;
    const asked = backend.djGenerate.mock.calls.length;
    await dj.skipSet();
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    expect(backend.device).toHaveBeenCalledWith({ action: "clear_queue" });
    // The set it had ready followed the rest of the skipped one: it's picked again, after the song skipped.
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.djGenerate.mock.calls.length).toBe(asked + 1);
    const prompt = lastPrompt()[1].content;
    expect(prompt).toContain(`The listener skipped the rest of the set "${first.name}"`);
    expect(prompt).toContain(`You're coming out of "${first.songs[0].name}"`);
    const next = dj.upNext ?? dj.current!;
    expect(next).not.toBe(ready);
    expect(next).not.toBe(first);
    // The new set's talk, then its songs.
    expect(voice.played.length).toBe(lines + 1);
    expect(dj.onAir?.name).toBe(next.name);
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.playUris).toHaveBeenLastCalledWith(next.songs.map((s) => s.uri), 0, true);
    const before = backend.djGenerate.mock.calls.length;
    await playing(next.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.current).toBe(next);
    // Said once.
    expect(backend.djGenerate.mock.calls.length).toBe(before + 1);
    expect(lastPrompt()[1].content).not.toContain("skipped the rest of the set");
  });

  it("waits only a few seconds for a set to be picked after a skip, then talks from a template", async () => {
    player.isPlaying = false;
    await dj.start();
    const first = dj.upNext!;
    backend.djGenerate.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    await playing(first.songs[0].uri, 30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext).toBeNull();
    await dj.skipSet();
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    expect(dj.activity).toContain("something else");
    await vi.advanceTimersByTimeAsync(mod.SKIP_WAIT_MS - 100);
    expect(dj.onAir).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(dj.said.at(-1)?.byModel).toBe(false);
    expect(dj.onAir).not.toBeNull();
  });

  it("still rushes the set it picks instead, once the one it let go of answers", async () => {
    player.isPlaying = false;
    await dj.start();
    const first = dj.upNext!;
    // The set it lets go of answers late; the one asked for instead doesn't answer at all.
    backend.djGenerate.mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => r({ name: "Too late", songs: [1, 2, 3], talk: "This one took a while to pick." }), 5_000)),
    );
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    await playing(first.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    backend.djGenerate.mockImplementation(() => new Promise(() => {}));
    dj.request("something calm");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dj.upNext).toBeNull();
    // The set's last song nears its end: the music can't wait for the model.
    await playing(first.songs[first.songs.length - 1].uri, DURATION - mod.RUSH_MS + 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext?.byModel).toBe(false);
  });

  it("plays only what a request names when it talks from a template, or an ordinary set while it waits", async () => {
    const radiohead = (n: number) => ({ ...song(n), artists: [{ id: "rh", name: "Radiohead", uri: "spotify:artist:rh" }] });
    sp.topTracksIn.mockImplementation(async (range: string, offset: number) => ({
      items: range === "short_term" && offset === 0 ? Array.from({ length: 18 }, (_, i) => (i >= 12 ? radiohead(i + 1) : song(i + 1))) : [],
      next: null,
      total: 18,
      offset,
      limit: 20,
    }));
    player.isPlaying = false;
    await dj.start();
    const first = dj.upNext!;
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    await playing(first.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    backend.djGenerate.mockImplementation(async () => {
      throw { kind: "dj", message: "no model" };
    });
    // Nothing in the listening is called this.
    dj.request("something calm");
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext?.byModel).toBe(false);
    expect(dj.upNext?.request).toBeNull();
    expect(dj.upNext?.segment).not.toBe("request");
    expect(dj.requested).toBe("something calm");
    // Songs it does name: those, and only those.
    dj.request("more Radiohead");
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext?.segment).toBe("request");
    expect(dj.upNext!.songs.length).toBeGreaterThan(0);
    expect(dj.upNext!.songs.every((s) => s.artists.includes("Radiohead"))).toBe(true);
  });

  it("doesn't skip what it's already left: a set the player is past, or one a Next is leaving", async () => {
    const first = await started();
    const next = dj.upNext!;
    backend.device.mockClear();
    // The player moved on to the next set's song before the DJ noticed.
    player.track = { uri: next.songs[0].uri, durationMs: DURATION };
    await dj.skipSet();
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
    expect(backend.device).not.toHaveBeenCalledWith({ action: "clear_queue" });
    player.track = { uri: "spotify:track:somewhere-else", durationMs: DURATION };
    await dj.skipSet();
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
    player.track = { uri: first.songs[0].uri, durationMs: DURATION };
    await dj.skipSet();
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
  });

  it("stops when nothing is left to pick after a skip", async () => {
    // Enough for one set, and not another.
    sp.topTracksIn.mockImplementation(async (range: string, offset: number) => ({
      items: range === "short_term" && offset === 0 ? Array.from({ length: 5 }, (_, i) => song(i + 1)) : [],
      next: null,
      total: 5,
      offset,
      limit: 20,
    }));
    player.isPlaying = false;
    await dj.start();
    const first = dj.upNext!;
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    await playing(first.songs[0].uri, 30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext).toBeNull();
    await dj.skipSet();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts.show).toHaveBeenCalledWith(expect.stringContaining("That's all your DJ had for now"));
    expect(dj.phase).toBe("off");
  });

  it("tells the set asked for instead that the last one was skipped", async () => {
    const first = await started();
    await playing(first.songs[0].uri, 30_000);
    backend.djGenerate.mockImplementationOnce(() => new Promise(() => {}));
    await dj.skipSet();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPrompt()[1].content).toContain("skipped the rest of the set");
    dj.request("something calm");
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPrompt()[1].content).toContain("something calm");
    expect(lastPrompt()[1].content).toContain(`skipped the rest of the set "${first.name}"`);
  });

  it("queues a set asked for only after the one it lets go of is out of the queue", async () => {
    const first = await started();
    const log: string[] = [];
    backend.device.mockImplementation(async (c: unknown) => void log.push((c as { action: string }).action));
    // Each song takes the player a second to take.
    sp.addToQueue.mockImplementation((uri: string) => {
      log.push(`add ${uri}`);
      return new Promise((r) => setTimeout(() => r(null), 1000));
    });
    await playing(first.songs[1].uri, 0);
    await playing(first.songs[first.songs.length - 1].uri, 100_000);
    await tick();
    const old = dj.upNext!;
    // Its first song is on its way into the queue.
    expect(log).toEqual([`add ${old.songs[0].uri}`]);
    dj.request("something calm");
    await vi.advanceTimersByTimeAsync(0);
    const asked = dj.upNext!;
    expect(asked).not.toBe(old);
    await tick();
    await vi.advanceTimersByTimeAsync(10_000);
    const adds = (set: typeof old) => set.songs.map((s) => `add ${s.uri}`);
    expect(log.filter((l) => l.startsWith("add") || l === "clear_queue")).toEqual([...adds(old).slice(0, 1), "clear_queue", ...adds(asked)]);
  });

  it("gives the model its few seconds when a set is skipped near the end of its last song", async () => {
    const first = await started();
    await playing(first.songs[first.songs.length - 1].uri, DURATION - 20_000);
    await vi.advanceTimersByTimeAsync(0);
    backend.djGenerate.mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => r({ name: "Worth the wait", songs: [1, 2, 3], talk: "Here's something else." }), 3000)),
    );
    await dj.skipSet();
    await vi.advanceTimersByTimeAsync(3500);
    expect(dj.said.at(-1)?.name).toBe("Worth the wait");
    expect(dj.said.at(-1)?.byModel).toBe(true);
  });

  it("skips once: a second press while it picks doesn't start over", async () => {
    const first = await started();
    await playing(first.songs[0].uri, 30_000);
    backend.djGenerate.mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => r({ name: "Worth the wait", songs: [1, 2, 3], talk: "Here's something else." }), 6000)),
    );
    const asked = backend.djGenerate.mock.calls.length;
    await dj.skipSet();
    await vi.advanceTimersByTimeAsync(5000);
    await dj.skipSet();
    await vi.advanceTimersByTimeAsync(1500);
    expect(backend.djGenerate.mock.calls.length).toBe(asked + 1);
    expect(dj.said.at(-1)?.name).toBe("Worth the wait");
  });

  it("Next while it picks after a skip stops waiting for the model; Previous goes nowhere", async () => {
    const first = await started();
    await playing(first.songs[0].uri, 30_000);
    backend.djGenerate.mockImplementation(() => new Promise(() => {}));
    await dj.skipSet();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dj.onAir).toBeNull();
    await dj.previous();
    expect(player.prev).not.toHaveBeenCalled();
    dj.skipTalk();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.next).not.toHaveBeenCalled();
    expect(dj.onAir).not.toBeNull();
    expect(dj.said.at(-1)?.byModel).toBe(false);
  });

  it("takes a set it's still queueing back out of the queue when Next starts it with a play request", async () => {
    const first = await started();
    const log: string[] = [];
    backend.device.mockImplementation(async (c: unknown) => void log.push((c as { action: string }).action));
    sp.addToQueue.mockImplementation((uri: string) => {
      log.push(`add ${uri}`);
      return new Promise((r) => setTimeout(() => r(null), 1000));
    });
    await playing(first.songs[1].uri, 0);
    await playing(first.songs[first.songs.length - 1].uri, 100_000);
    await tick();
    const next = dj.upNext!;
    expect(log).toEqual([`add ${next.songs[0].uri}`]);
    dj.skipTalk();
    await vi.advanceTimersByTimeAsync(5000);
    expect(log.filter((l) => l.startsWith("add") || l === "clear_queue")).toEqual([`add ${next.songs[0].uri}`, "clear_queue"]);
  });

  it("takes what made it into the queue back out when the rest of the set wouldn't go in", async () => {
    const first = await started();
    const log: string[] = [];
    backend.device.mockImplementation(async (c: unknown) => void log.push((c as { action: string }).action));
    let adds = 0;
    sp.addToQueue.mockImplementation(async (uri: string) => {
      log.push(`add ${uri}`);
      if (++adds > 1) throw new Error("the queue is full");
      return null;
    });
    await playing(first.songs[1].uri, 0);
    await playing(first.songs[first.songs.length - 1].uri, 100_000);
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(adds).toBe(2);
    player.pos = DURATION - 500;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toContain("pause");
    expect(log.filter((l) => l === "clear_queue")).toHaveLength(1);
  });

  it("doesn't skip a set while its own talk is on", async () => {
    speechMs = 20_000;
    const first = await started();
    await lastSong2(first);
    backend.device.mockClear();
    await dj.skipSet();
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
  });
});

describe("the voice", () => {
  let v: InstanceType<typeof mod.Voice>;
  const emit = (payload: unknown) => events.handlers.get("dj-voice")!({ payload });
  beforeEach(() => {
    v = new mod.Voice();
  });

  it("plays a line in the backend, and keeps its clock between reports", async () => {
    const onEnd = vi.fn();
    v.play(7, 0.5, onEnd);
    expect(backend.djVoice).toHaveBeenCalledWith({ action: "play", id: 7, gain: 0.5 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(v.now()).toBe(1000);
    // The output started later than asked: its position wins.
    emit({ state: "playing", id: 7, position_ms: 700 });
    expect(v.now()).toBe(700);
    // A report within jitter of the clock leaves it be.
    await vi.advanceTimersByTimeAsync(250);
    emit({ state: "playing", id: 7, position_ms: 990 });
    expect(v.now()).toBe(950);
    // Another line's news isn't this one's.
    emit({ state: "ended", id: 6 });
    expect(onEnd).not.toHaveBeenCalled();
    emit({ state: "ended", id: 7 });
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(v.now()).toBe(0);
  });

  it("holds its clock while paused, and pauses the line", async () => {
    v.play(1, 1, vi.fn());
    await vi.advanceTimersByTimeAsync(500);
    v.pause();
    expect(backend.djVoice).toHaveBeenLastCalledWith({ action: "pause" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(v.now()).toBe(500);
    v.resume();
    expect(backend.djVoice).toHaveBeenLastCalledWith({ action: "resume" });
    await vi.advanceTimersByTimeAsync(100);
    expect(v.now()).toBe(600);
  });

  it("sends the gain only when it changes, and stops a line without ending it", () => {
    const onEnd = vi.fn();
    v.play(1, 0.5, onEnd);
    v.setGain(0.5);
    v.setGain(0.25);
    expect(backend.djVoice.mock.calls.filter(([c]) => (c as { action: string }).action === "gain")).toEqual([
      [{ action: "gain", gain: 0.25 }],
    ]);
    v.stop();
    expect(backend.djVoice).toHaveBeenLastCalledWith({ action: "stop" });
    emit({ state: "ended", id: 1 });
    expect(onEnd).not.toHaveBeenCalled();
    expect(v.now()).toBe(0);
    // Nothing playing: nothing to pause, resume or stop.
    backend.djVoice.mockClear();
    v.pause();
    v.resume();
    v.stop();
    expect(backend.djVoice).not.toHaveBeenCalled();
  });

  it("ends a line it can't play, with the reason", async () => {
    const onEnd = vi.fn();
    v.play(3, 1, onEnd);
    emit({ state: "failed", id: 3, error: "No audio output device" });
    expect(onEnd).toHaveBeenCalledWith("No audio output device");
    backend.djVoice.mockRejectedValueOnce({ kind: "other", message: "That line is gone" });
    const gone = vi.fn();
    v.play(4, 1, gone);
    await vi.advanceTimersByTimeAsync(0);
    expect(gone).toHaveBeenCalledWith("That line is gone");
  });
});

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
    player.isPlaying = false;
    await dj.start();
    expect(dj.phase).toBe("on");
    // The prompt carries the listener's first name and asks for JSON that fits a schema.
    const [messages, schema] = backend.djGenerate.mock.calls[0] as unknown as [{ content: string }[], object];
    expect(messages[1].content).toContain("The listener's name is Sam.");
    expect(schema).toHaveProperty("properties.songs");
    expect(voice.played).toHaveLength(1);
    expect(backend.djDuck).toHaveBeenCalledWith(timing.DUCK_LEVEL, 0, timing.DUCK_DOWN_MS);
    expect(dj.said).toEqual([{ name: "Set 1", talk: "Here's set number 1, nice and easy.", byModel: true, why: null }]);
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

  it("fades out the song that was playing, and stopping brings it back", async () => {
    player.track = { uri: "spotify:track:before", durationMs: DURATION };
    await dj.start();
    expect(voice.played).toHaveLength(1);
    // Silent once the player's output queue has played out, then paused.
    expect(backend.djDuck).toHaveBeenCalledWith(0, 600, mod.OPENING_FADE_MS);
    expect(backend.djDuck).not.toHaveBeenCalledWith(timing.DUCK_LEVEL, 0, timing.DUCK_DOWN_MS);
    await vi.advanceTimersByTimeAsync(990);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
    await vi.advanceTimersByTimeAsync(20);
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    player.isPlaying = false;
    dj.stop();
    expect(backend.device).toHaveBeenLastCalledWith({ action: "play" });
    expect(backend.djDuck).toHaveBeenLastCalledWith(1, 0, timing.DUCK_UP_MS);
  });

  it("stopping while paused leaves the music paused", async () => {
    player.track = { uri: "spotify:track:before", durationMs: DURATION };
    await dj.start();
    dj.togglePause();
    expect(backend.device).toHaveBeenLastCalledWith({ action: "pause" });
    dj.stop();
    expect(backend.device).not.toHaveBeenCalledWith({ action: "play" });
  });

  it("times the next song by its singer as heard, with the listener's nudge for its lyrics", async () => {
    // Every song's lyrics run a second late: its singer comes in at 4 s, not 3.
    lyricsState.songOffsets = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t${i + 1}`, 1000]));
    player.isPlaying = false;
    await dj.start();
    // 6 s of talk, 3.3 s of room in the intro: half the line goes over it.
    const wait = speechMs / 2 - mod.PLAY_LATENCY_MS;
    await vi.advanceTimersByTimeAsync(wait - 10);
    expect(player.playUris).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(player.playUris).toHaveBeenCalled();
  });

  it("lets a song the listener picks during its greeting be heard", async () => {
    player.track = { uri: "spotify:track:before", durationMs: DURATION };
    await dj.start();
    expect(backend.djDuck).toHaveBeenLastCalledWith(0, 600, mod.OPENING_FADE_MS);
    await vi.advanceTimersByTimeAsync(300);
    await playing("spotify:track:mine", 0);
    // Up from the silence, under the voice, and not paused once the fade would have ended.
    expect(backend.djDuck).toHaveBeenLastCalledWith(timing.DUCK_LEVEL, 0, timing.DUCK_UP_MS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
  });

  it("keeps its song paused when the listener paused before it came in", async () => {
    player.isPlaying = false;
    await dj.start();
    const set = dj.upNext!;
    await vi.advanceTimersByTimeAsync(speechMs - (3000 - timing.VOCAL_GAP_MS) - mod.PLAY_LATENCY_MS + 10);
    expect(player.playUris).toHaveBeenCalled();
    // Asked for, not playing yet: pausing pauses it all the same.
    dj.togglePause();
    expect(backend.device).toHaveBeenLastCalledWith({ action: "pause" });
    backend.device.mockClear();
    // It comes in anyway, a moment later: paused again.
    await playing(set.songs[0].uri, 0);
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    expect(dj.onAir).not.toBeNull();
    player.isPlaying = false;
    dj.togglePause();
    expect(backend.device).toHaveBeenLastCalledWith({ action: "play" });
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

  it("plays on without a voice when the voice fails, and says so once", async () => {
    backend.djSpeak.mockRejectedValue(new Error("The DJ's voice failed: no espeak data"));
    player.isPlaying = false;
    await dj.start();
    expect(voice.played).toHaveLength(0);
    expect(player.playUris).toHaveBeenCalledTimes(1);
    // The next set's line fails too: still one message.
    await playing(dj.upNext!.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext).not.toBeNull();
    const told = toasts.show.mock.calls.filter(([m]) => String(m).includes("lost its voice"));
    expect(told).toEqual([[expect.stringContaining("no espeak data"), "error", 8000]]);
  });

  it("hands over to the music when a line can't be played", async () => {
    player.isPlaying = false;
    await dj.start();
    expect(voice.played).toHaveLength(1);
    voice.end("No audio output device");
    expect(player.playUris).toHaveBeenCalled();
    expect(dj.speaking).toBe(false);
    expect(toasts.show).toHaveBeenCalledWith(expect.stringContaining("No audio output device"), "error", 8000);
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

  it("talks on its own as long as it needs, and brings the next song in from its start before its singer", async () => {
    speechMs = 20_000;
    // Every song sings until 4 s before its end.
    backend.lyrics.mockImplementation(async () => sync(3000, DURATION - 4000));
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    const overOld = 4000 - timing.VOCAL_GAP_MS;
    const musicAt = speechMs - (3000 - timing.VOCAL_GAP_MS);
    player.pos = DURATION - overOld;
    await tick();
    expect(dj.speaking).toBe(true);
    // The finishing song plays to its end, and the music goes silent right there.
    await vi.advanceTimersByTimeAsync(overOld - mod.MUTE_LEAD_MS + mod.TICK_MS);
    expect(backend.djDuck).toHaveBeenLastCalledWith(0, expect.any(Number), mod.MUTE_RAMP_MS);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
    // Spotify starts the queued song: it waits at its start…
    await vi.advanceTimersByTimeAsync(mod.MUTE_LEAD_MS - mod.TICK_MS);
    await playing(next.songs[0].uri, 0);
    expect(dj.current).toBe(next);
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    player.isPlaying = false;
    expect(dj.onAir?.name).toBe(next.name);
    // …and comes in from the top under the end of the line, turned down.
    await vi.advanceTimersByTimeAsync(musicAt - dj.speechNow() - 20);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "seek", position_ms: 0 });
    await vi.advanceTimersByTimeAsync(40);
    expect(backend.device).toHaveBeenCalledWith({ action: "seek", position_ms: 0 });
    expect(backend.device).toHaveBeenLastCalledWith({ action: "play" });
    expect(backend.djDuck).toHaveBeenLastCalledWith(timing.DUCK_LEVEL, 0, 0);
    player.isPlaying = true;
    voice.end();
    expect(backend.djDuck).toHaveBeenLastCalledWith(1, 0, timing.DUCK_UP_MS);
    expect(dj.onAir).toBeNull();
  });

  it("lets a held song that comes in about on time play on", async () => {
    // 6 s of talk, none of it over the next intro: 5 s over the end, 1 s alone.
    dj.setOverStart(false);
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    player.pos = DURATION - timing.MAX_OVER_OUTRO_MS;
    await tick();
    expect(dj.speaking).toBe(true);
    // 0.2 s before its time: close enough.
    await vi.advanceTimersByTimeAsync(speechMs - 200 - mod.TICK_MS);
    await playing(next.songs[0].uri, 0);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
    // Back up from the silence at the finishing song's end, under the last of the line.
    expect(backend.djDuck).toHaveBeenLastCalledWith(timing.DUCK_LEVEL, 0, 0);
  });

  it("waits for the song to end when talking over ends is off", async () => {
    dj.setOverEnd(false);
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    player.pos = DURATION - 2000;
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dj.speaking).toBe(false);
    // Silent at its end rather than cut short.
    expect(backend.djDuck).toHaveBeenLastCalledWith(0, expect.any(Number), mod.MUTE_RAMP_MS);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
    await vi.advanceTimersByTimeAsync(1000);
    // The queued song comes up: the DJ talks first, and the song waits for its time in the line.
    await playing(next.songs[0].uri, 0);
    expect(dj.speaking).toBe(true);
    expect(dj.onAir?.name).toBe(next.name);
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    player.isPlaying = false;
    await vi.advanceTimersByTimeAsync(speechMs - (3000 - timing.VOCAL_GAP_MS));
    expect(backend.device).toHaveBeenCalledWith({ action: "seek", position_ms: 0 });
    expect(backend.device).toHaveBeenLastCalledWith({ action: "play" });
  });

  it("starts talking once the finishing song's last moments are heard", async () => {
    dj.setOverEnd(false);
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    // The silence at the end is timed 1.2 s ahead: heard 2 s after this.
    player.pos = DURATION - 2000;
    await tick();
    await vi.advanceTimersByTimeAsync(1300);
    expect(backend.djDuck).toHaveBeenLastCalledWith(0, expect.any(Number), mod.MUTE_RAMP_MS);
    // Spotify moves on while the song's last half second is still to be heard.
    voice.played = [];
    await playing(next.songs[0].uri, 0);
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    expect(voice.played).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(voice.played).toHaveLength(1);
    expect(dj.onAir?.name).toBe(next.name);
  });

  it("doesn't talk over a song that's paused, wherever it's moved to", async () => {
    const first = await started();
    await lastSong(first);
    const talkAt = DURATION - (speechMs - (3000 - timing.VOCAL_GAP_MS));
    player.isPlaying = false;
    player.pos = talkAt + 500;
    await tick();
    await tick();
    expect(dj.speaking).toBe(false);
    expect(dj.onAir).toBeNull();
    player.isPlaying = true;
    await tick();
    expect(dj.speaking).toBe(true);
  });

  it("times the silence at a song's end again when the song pauses or moves a little", async () => {
    dj.setOverEnd(false);
    const first = await started();
    await lastSong(first);
    player.pos = DURATION - 2000;
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.djDuck).toHaveBeenLastCalledWith(0, expect.any(Number), mod.MUTE_RAMP_MS);
    // Paused from the player bar, with no DJ item up yet, and played on a while later.
    player.isPlaying = false;
    const at = player.positionNow();
    await vi.advanceTimersByTimeAsync(5000);
    backend.djDuck.mockClear();
    dj.togglePause();
    expect(player.togglePlay).toHaveBeenCalled();
    expect(backend.djDuck.mock.calls).toEqual([
      [1, 0, 0],
      [0, Math.round(DURATION - at - mod.MUTE_RAMP_MS), mod.MUTE_RAMP_MS],
    ]);
    player.isPlaying = true;
    backend.djDuck.mockClear();
    await tick();
    expect(backend.djDuck).not.toHaveBeenCalled();
    // A step back too small to plan again: the silence moves with the song.
    player.pos = player.positionNow() - 500;
    await tick();
    expect(backend.djDuck).toHaveBeenLastCalledWith(0, expect.any(Number), mod.MUTE_RAMP_MS);
    // Timed from where the song was at that tick, at most a tick ago.
    const left = DURATION - player.positionNow() - mod.MUTE_RAMP_MS;
    const [, delay] = backend.djDuck.mock.lastCall as unknown as number[];
    expect(delay).toBeGreaterThanOrEqual(left - 5);
    expect(delay).toBeLessThanOrEqual(left + mod.TICK_MS + 5);
  });

  it("brings the next song in from its start once it's done when talking over beginnings is off", async () => {
    dj.setOverStart(false);
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    player.pos = DURATION - timing.MAX_OVER_OUTRO_MS;
    await tick();
    expect(dj.speaking).toBe(true);
    await vi.advanceTimersByTimeAsync(timing.MAX_OVER_OUTRO_MS);
    // The queued song is early for the rest of the line: it waits at its start.
    await playing(next.songs[0].uri, 0);
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    player.isPlaying = false;
    await vi.advanceTimersByTimeAsync(speechMs - dj.speechNow() - 100);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "seek", position_ms: 0 });
    voice.end();
    expect(backend.device).toHaveBeenCalledWith({ action: "seek", position_ms: 0 });
    expect(backend.device).toHaveBeenLastCalledWith({ action: "play" });
    expect(backend.djDuck).toHaveBeenLastCalledWith(1, 0, 0);
  });

  it("says a short line between the songs, and brings the next in under its second half", async () => {
    speechMs = 2000;
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    // 1 s would fit over the finishing song's end: too short a moment to start there.
    player.pos = DURATION - 1500;
    await tick();
    await vi.advanceTimersByTimeAsync(500);
    expect(dj.speaking).toBe(false);
    voice.played = [];
    await vi.advanceTimersByTimeAsync(1000);
    await playing(next.songs[0].uri, 0);
    expect(voice.played).toHaveLength(1);
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    player.isPlaying = false;
    await vi.advanceTimersByTimeAsync(speechMs / 2);
    expect(backend.device).toHaveBeenCalledWith({ action: "seek", position_ms: 0 });
  });

  it("asked for a set while bringing the last one in, still brings it in", async () => {
    speechMs = 2000;
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    player.pos = DURATION - 1500;
    await tick();
    await vi.advanceTimersByTimeAsync(1500);
    await playing(next.songs[0].uri, 0);
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    player.isPlaying = false;
    dj.request("something calm");
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext?.request).toBe("something calm");
    await vi.advanceTimersByTimeAsync(speechMs / 2);
    expect(backend.device).toHaveBeenCalledWith({ action: "seek", position_ms: 0 });
  });

  it("starts over when the listener goes back in the song it was talking over", async () => {
    const first = await started();
    const next = dj.upNext!;
    await lastSong(first);
    const talkAt = DURATION - (speechMs - (3000 - timing.VOCAL_GAP_MS));
    player.pos = talkAt;
    await tick();
    expect(dj.speaking).toBe(true);
    expect(dj.said).toHaveLength(2);
    // Back to the middle of the song: the DJ's item is gone, and the music back up.
    await playing(first.songs[first.songs.length - 1].uri, 100_000);
    expect(dj.speaking).toBe(false);
    expect(dj.onAir).toBeNull();
    expect(dj.said).toHaveLength(1);
    expect(backend.djDuck).toHaveBeenLastCalledWith(1, 0, timing.DUCK_UP_MS);
    // It talks again when the end comes round.
    voice.played = [];
    player.pos = talkAt;
    await tick();
    await tick();
    expect(voice.played).toHaveLength(1);
    expect(dj.onAir?.name).toBe(next.name);
  });

  it("gives up when the song after its talk never comes in", async () => {
    const first = await started();
    await lastSong(first);
    player.pos = DURATION - (speechMs - (3000 - timing.VOCAL_GAP_MS));
    await tick();
    expect(dj.speaking).toBe(true);
    // The finishing song ends, and nothing follows it.
    player.pos = DURATION;
    player.isPlaying = false;
    voice.end();
    expect(dj.onAir).not.toBeNull();
    await vi.advanceTimersByTimeAsync(mod.START_TIMEOUT_MS - 1000);
    expect(dj.phase).toBe("on");
    await vi.advanceTimersByTimeAsync(2000);
    expect(dj.phase).toBe("off");
    expect(toasts.show).toHaveBeenCalledWith(expect.stringContaining("couldn't get its songs playing"), "error");
  });

  it("queues the set after next in its turn when the listener skips ahead while it's queueing", async () => {
    const first = await started();
    const next = dj.upNext!;
    let release!: () => void;
    sp.addToQueue.mockImplementationOnce(() => new Promise((r) => (release = () => r(null))));
    await lastSong(first);
    await playing(next.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    const after = dj.upNext!;
    expect(after).not.toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(0);
    voice.end();
    await playing(next.songs[1].uri, 0);
    await playing(next.songs[2].uri, 100_000);
    await tick();
    expect(sp.addToQueue.mock.calls.map((c) => c[0])).toEqual([...next.songs, ...after.songs].map((s) => s.uri));
  });

  it("renews the turned-down music while the DJ is paused, and times the silence at a song's end again", async () => {
    speechMs = 20_000;
    backend.lyrics.mockImplementation(async () => sync(3000, DURATION - 4000));
    const first = await started();
    await lastSong(first);
    player.pos = DURATION - (4000 - timing.VOCAL_GAP_MS);
    await tick();
    await vi.advanceTimersByTimeAsync(4000 - timing.VOCAL_GAP_MS - mod.MUTE_LEAD_MS + mod.TICK_MS);
    expect(backend.djDuck).toHaveBeenLastCalledWith(0, expect.any(Number), mod.MUTE_RAMP_MS);
    dj.togglePause();
    player.isPlaying = false;
    const at = player.positionNow();
    // The player would lift a duck on its own after a while: the DJ says it again before then.
    backend.djDuck.mockClear();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(backend.djDuck).toHaveBeenCalled();
    // Playing on, the song's end is as far off as when it paused.
    backend.djDuck.mockClear();
    dj.togglePause();
    expect(backend.djDuck.mock.calls).toEqual([
      [timing.DUCK_LEVEL, 0, 0],
      [0, Math.round(DURATION - at - mod.MUTE_RAMP_MS), mod.MUTE_RAMP_MS],
    ]);
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

describe("picking as it goes", () => {
  const queued = () =>
    backend.device.mock.calls.map(([c]) => c as { action: string; uri?: string }).filter((c) => c.action === "queue").map((c) => c.uri);
  const artistOf = (uri: string) => Number(uri.replace("spotify:track:t", "")) % 100;

  /** Every artist has two songs, t{n} and t{n+100}, all on repeat. */
  function twins(saved: boolean | null = false) {
    sp.topTracksIn.mockImplementation(async (range: string, offset: number) => ({
      items: range === "short_term" && offset === 0 ? Array.from({ length: 12 }, (_, i) => [song(i + 1), { ...song(i + 101), artists: song(i + 1).artists }]).flat() : [],
      next: null,
      total: 24,
      offset,
      limit: 20,
    }));
    if (saved === null) return;
    for (let i = 1; i <= 12; i++) {
      likedState.saved.set(`spotify:track:t${i}`, saved);
      likedState.saved.set(`spotify:track:t${i + 100}`, saved);
    }
  }

  /** Starts a session picking as it goes, and plays its first song. */
  async function liveStarted(beforePlay?: (set: import("./dj.svelte").DjSet) => void) {
    dj.setLive(true);
    expect(localStorage.getItem("nativify:djLive")).toBe("true");
    player.isPlaying = false;
    await dj.start();
    const set = dj.upNext!;
    beforePlay?.(set);
    expect(set.live).toBe(true);
    expect(set.songs).toHaveLength(1);
    expect(set.plan.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    expect(player.playUris).toHaveBeenCalledWith([set.songs[0].uri], 0, true);
    await playing(set.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    return set;
  }

  it("plays only the first song, and lines up each next one as the one before plays", async () => {
    const set = await liveStarted();
    expect(dj.current?.id).toBe(set.id);
    expect(dj.current?.songs.map((s) => s.uri)).toEqual(set.plan.slice(0, 2).map((s) => s.uri));
    expect(backend.device).toHaveBeenCalledWith({ action: "clear_queue" });
    expect(queued()).toEqual([set.plan[1].uri]);
    expect(dj.linedUp).toBe(1);
    // No next set yet: it's picked once the set's last song is under way.
    expect(dj.upNext).toBeNull();
    const asked = backend.djGenerate.mock.calls.length;
    await playing(set.plan[1].uri, 0);
    expect(queued()).toEqual([set.plan[1].uri, set.plan[2].uri]);
    await playing(set.plan[2].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    // As long as the plan: the set ends here, and the next one gets picked.
    expect(queued()).toHaveLength(2);
    expect(backend.djGenerate.mock.calls.length).toBe(asked + 1);
    expect(dj.upNext).not.toBeNull();
  });

  it("lines up more like a song the listener likes", async () => {
    twins();
    const set = await liveStarted();
    const first = set.songs[0].uri;
    expect(artistOf(queued()[0]!)).not.toBe(artistOf(first));
    // The listener likes the song playing: what's lined up is picked again, by the same artist.
    likedState.saved.set(first, true);
    await tick();
    expect(queued()).toHaveLength(2);
    expect(artistOf(queued()[1]!)).toBe(artistOf(first));
    expect(dj.current?.songs[1].uri).toBe(queued()[1]);
  });

  it("keeps what's lined up once the player may have started loading it", async () => {
    twins();
    const set = await liveStarted();
    player.pos = DURATION - mod.REPICK_UNTIL_MS + 1000;
    likedState.saved.set(set.songs[0].uri, true);
    await tick();
    await tick();
    expect(queued()).toHaveLength(1);
  });

  it("goes by new likes only, not songs that were liked already", async () => {
    twins();
    // The first song was in the listener's library before the DJ played it.
    const set = await liveStarted((set) => likedState.saved.set(set.songs[0].uri, true));
    await tick();
    await tick();
    expect(queued()).toHaveLength(1);
    expect(artistOf(queued()[0]!)).not.toBe(artistOf(set.songs[0].uri));
  });

  it("moves on after a couple of skips, and tells the model what was skipped", async () => {
    // A set planned five songs long.
    backend.djGenerate.mockImplementation(async () => {
      answers++;
      return { name: `Set ${answers}`, songs: [1, 2, 3, 4, 5], talk: `Here's set number ${answers}, nice and easy.` };
    });
    const set = await liveStarted();
    expect(set.plan).toHaveLength(5);
    // Skipped early, twice.
    await playing(dj.current!.songs[1].uri, 0);
    await playing(dj.current!.songs[2].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.current!.songs).toHaveLength(3);
    expect(dj.upNext).not.toBeNull();
    const [messages] = backend.djGenerate.mock.calls.at(-1) as unknown as [{ content: string }[]];
    expect(messages[1].content).toContain("They skipped");
    expect(messages[1].content).toContain(set.songs[0].name);
  });

  it("doesn't leave the listener in silence when they skip the last song before the next set is ready", async () => {
    await liveStarted();
    await playing(dj.current!.songs[1].uri, DURATION - 1000);
    // The set's last song: the next set is being picked, slowly.
    backend.djGenerate.mockImplementationOnce(() => new Promise(() => {}));
    await playing(dj.current!.songs[2].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    backend.device.mockClear();
    const lines = voice.played.length;
    dj.skipTalk();
    await vi.advanceTimersByTimeAsync(0);
    // Not the player's next, which would stop with nothing after: the music waits, and the DJ stops waiting
    // for the model and talks from a template.
    expect(player.next).not.toHaveBeenCalled();
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    await vi.advanceTimersByTimeAsync(0);
    expect(voice.played.length).toBe(lines + 1);
    expect(dj.said.at(-1)?.byModel).toBe(false);
    expect(dj.onAir?.name).toBe(dj.upNext?.name);
  });

  it("ends the set with the song playing when the player won't take the next one", async () => {
    dj.setLive(true);
    backend.device.mockImplementation(async (c: unknown) => {
      if ((c as { action: string }).action === "queue") throw { kind: "device", message: "not active" };
    });
    await liveStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.current!.songs).toHaveLength(1);
    expect(dj.upNext).not.toBeNull();
    backend.device.mockImplementation(async () => {});
  });

  /** Lets the song playing finish, as a listener who doesn't skip would. */
  async function finish() {
    player.pos = DURATION - 300;
    await tick();
  }

  /** Plays the set on, song by song without skipping, until the next set is picked. */
  async function untilNextSet() {
    for (let i = 0; i < 10 && !dj.upNext; i++) {
      const songs = dj.current!.songs;
      const at = songs.findIndex((s) => s.uri === player.track?.uri);
      if (at === songs.length - 1) {
        await tick();
        continue;
      }
      await finish();
      await playing(songs[at + 1].uri, 0);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(dj.upNext).not.toBeNull();
  }

  /** Brings in the next set's first song, the one before having played out. */
  async function nextSet() {
    const set = dj.upNext!;
    await finish();
    await playing(set.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.current?.id).toBe(set.id);
    return set;
  }

  const prompt = () => (backend.djGenerate.mock.calls.at(-1) as unknown as [{ content: string }[]])[0][1].content;

  it("takes back what it lined up when the listener plays something else", async () => {
    await liveStarted();
    backend.device.mockClear();
    await playing("spotify:track:mine", 0);
    await vi.advanceTimersByTimeAsync(mod.FOREIGN_MS + mod.TICK_MS * 2);
    expect(dj.phase).toBe("off");
    expect(backend.device).toHaveBeenCalledWith({ action: "clear_queue" });
  });

  it("takes back what it lined up when it's stopped", async () => {
    await liveStarted();
    backend.device.mockClear();
    dj.stop();
    expect(backend.device).toHaveBeenCalledWith({ action: "clear_queue" });
  });

  it("puts nothing in the queue once it's stopped while lining a song up", async () => {
    const clears: (() => void)[] = [];
    await liveStarted(() => {
      backend.device.mockImplementation(async (c: unknown) => {
        if ((c as { action: string }).action === "clear_queue") return new Promise<void>((r) => clears.push(r));
      });
    });
    expect(clears).toHaveLength(1);
    dj.stop();
    for (const r of clears) r();
    await vi.advanceTimersByTimeAsync(0);
    expect(queued()).toEqual([]);
    backend.device.mockImplementation(async () => {});
  });

  it("leaves the player's queue alone when it stops a set picked ahead", async () => {
    await started();
    dj.stop();
    expect(backend.device).not.toHaveBeenCalledWith({ action: "clear_queue" });
  });

  it("follows a like in the set it's in, not in every set after", async () => {
    // Every artist has four songs, so a liked one still has songs left for the next set.
    sp.topTracksIn.mockImplementation(async (range: string, offset: number) => ({
      items:
        range === "short_term" && offset === 0
          ? Array.from({ length: 12 }, (_, i) => [0, 100, 200, 300].map((k) => ({ ...song(i + 1 + k), artists: song(i + 1).artists }))).flat()
          : [],
      next: null,
      total: 48,
      offset,
      limit: 20,
    }));
    for (let i = 1; i <= 312; i++) likedState.saved.set(`spotify:track:t${i}`, false);
    const set = await liveStarted();
    const fav = artistOf(set.songs[0].uri);
    likedState.saved.set(set.songs[0].uri, true);
    await tick();
    expect(artistOf(queued().at(-1)!)).toBe(fav);
    await untilNextSet();
    const second = await nextSet();
    // The new set goes by its own plan.
    expect(queued().at(-1)).toBe(second.plan[1].uri);
  });

  it("tells the model about likes and skips once, and only when picking as it goes", async () => {
    // Picked ahead: a skip isn't for the model to bring up.
    const first = await started();
    await playing(first.songs[1].uri, 0);
    await nextSet();
    expect(prompt()).not.toContain("They skipped");
  });

  it("tells the model about a skip again when the set that heard it is let go of", async () => {
    const set = await liveStarted();
    await playing(dj.current!.songs[1].uri, 0);
    // The set picked next takes a while to read aloud, and is let go of meanwhile.
    backend.djSpeak.mockImplementationOnce(() => new Promise(() => {}));
    const asked = backend.djGenerate.mock.calls.length;
    for (let i = 0; i < 10 && backend.djGenerate.mock.calls.length === asked; i++) {
      const songs = dj.current!.songs;
      const at = songs.findIndex((s) => s.uri === player.track?.uri);
      if (at === songs.length - 1) await tick();
      else {
        await finish();
        await playing(songs[at + 1].uri, 0);
      }
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(prompt()).toContain(`They skipped "${set.songs[0].name}"`);
    dj.request("something calm");
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt()).toContain("something calm");
    expect(prompt()).toContain(`They skipped "${set.songs[0].name}"`);
  });

  it("tells the model about a skip once", async () => {
    const set = await liveStarted();
    await playing(dj.current!.songs[1].uri, 0);
    await untilNextSet();
    expect(prompt()).toContain(`They skipped "${set.songs[0].name}"`);
    await nextSet();
    await untilNextSet();
    expect(prompt()).not.toContain("They skipped");
  });

  it.each([
    ["counts a song left early as skipped", 1000, true],
    ["doesn't count a song left near its end as skipped", DURATION - 20_000, false],
  ])("with nothing after the set's last song yet, %s", async (_, pos, skipped) => {
    await liveStarted();
    await finish();
    await playing(dj.current!.songs[1].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    const last = dj.current!.songs[2];
    // The next set is long in coming.
    const answer = backend.djGenerate.getMockImplementation()!;
    backend.djGenerate.mockImplementation(() => new Promise(() => {}));
    await finish();
    await playing(last.uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext).toBeNull();
    player.pos = pos;
    dj.skipTalk();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    backend.djGenerate.mockImplementation(answer);
    // The DJ talks from a template and plays the next set; the prompt after says what was skipped, if anything.
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    player.isPlaying = false;
    await nextSet();
    await untilNextSet();
    if (skipped) expect(prompt()).toContain(`They skipped "${last.name}"`);
    else expect(prompt()).not.toContain(`They skipped "${last.name}"`);
  });

  it("goes back a song within the set, without counting a skip", async () => {
    const set = await liveStarted();
    const [a, b] = dj.current!.songs;
    await finish();
    await playing(b.uri, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.current!.songs).toHaveLength(3);
    backend.device.mockClear();
    await dj.previous();
    expect(player.prev).not.toHaveBeenCalled();
    expect(backend.device.mock.calls.map(([c]) => c)).toEqual([
      { action: "clear_queue" },
      { action: "queue", uri: a.uri },
      { action: "next" },
    ]);
    expect(dj.current!.songs.map((s) => s.uri)).toEqual([a.uri]);
    await playing(a.uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    // The song gone back from comes again after it: it wasn't skipped.
    expect(queued().at(-1)).toBe(b.uri);
    expect(dj.current!.songs.map((s) => s.uri)).toEqual([a.uri, b.uri]);
    expect(set.plan[1].uri).toBe(b.uri);
  });

  it("doesn't count a skip when the player says it went back before the DJ hears back", async () => {
    await liveStarted();
    const [a, b] = dj.current!.songs;
    await finish();
    await playing(b.uri, 1000);
    await vi.advanceTimersByTimeAsync(0);
    let went!: () => void;
    backend.device.mockImplementation(async (c: unknown) => {
      if ((c as { action: string }).action === "next") return new Promise<void>((r) => (went = r));
    });
    const back = dj.previous();
    await vi.advanceTimersByTimeAsync(0);
    await playing(a.uri, 0);
    went();
    await back;
    backend.device.mockImplementation(async () => {});
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(queued().at(-1)).toBe(b.uri);
  });

  it("goes back to the song's start past its first seconds, and at the set's first song", async () => {
    await liveStarted();
    // The player's own previous would drop the song, which came in from its queue or a play request.
    await dj.previous();
    expect(player.seek).toHaveBeenLastCalledWith(0);
    await finish();
    await playing(dj.current!.songs[1].uri, 5000);
    await dj.previous();
    expect(player.seek).toHaveBeenCalledTimes(2);
    expect(player.prev).not.toHaveBeenCalled();
    expect(backend.device).not.toHaveBeenCalledWith({ action: "next" });
  });

  /** What went to the player, in order: the device's commands, and the player's own Next. */
  const sent = () =>
    [
      ...backend.device.mock.calls.map(([c], i) => ({ c: c as { action: string; uri?: string }, at: backend.device.mock.invocationCallOrder[i] })),
      ...player.next.mock.calls.map((_, i) => ({ c: { action: "player next" } as { action: string; uri?: string }, at: player.next.mock.invocationCallOrder[i] })),
    ]
      .sort((x, y) => x.at - y.at)
      .map(({ c }) => (c.uri ? `${c.action} ${c.uri}` : c.action));

  it("goes back twice when Previous is pressed twice quickly", async () => {
    await liveStarted();
    const [a, b] = dj.current!.songs;
    await finish();
    await playing(b.uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    const c = dj.current!.songs[2];
    await finish();
    await playing(c.uri, 1000);
    backend.device.mockClear();
    void dj.previous();
    await dj.previous();
    expect(sent()).toEqual(["clear_queue", `queue ${b.uri}`, "next", "clear_queue", `queue ${a.uri}`, "next"]);
    expect(dj.current!.songs.map((s) => s.uri)).toEqual([a.uri]);
    expect(player.prev).not.toHaveBeenCalled();
  });

  it("lines up a song after the one gone back to when Next follows Previous quickly", async () => {
    await liveStarted();
    const [a, b] = dj.current!.songs;
    await finish();
    await playing(b.uri, 1000);
    await vi.advanceTimersByTimeAsync(0);
    backend.device.mockClear();
    // The player hasn't said it's back on the first song when Next comes.
    void dj.previous();
    dj.skipTalk();
    await vi.advanceTimersByTimeAsync(0);
    const after = dj.current!.songs[1];
    expect(dj.current!.songs[0].uri).toBe(a.uri);
    expect(sent()).toEqual(["clear_queue", `queue ${a.uri}`, "next", "clear_queue", `queue ${after.uri}`, "player next"]);
  });

  it("goes back to the song Next left when Previous follows it quickly, and forgets that skip", async () => {
    await liveStarted();
    const [a, b] = dj.current!.songs;
    await finish();
    await playing(b.uri, 1000);
    await vi.advanceTimersByTimeAsync(0);
    const c = dj.current!.songs[2];
    backend.device.mockClear();
    dj.skipTalk();
    void dj.previous();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toEqual(["player next", "clear_queue", `queue ${b.uri}`, "next"]);
    expect(dj.current!.songs.map((s) => s.uri)).toEqual([a.uri, b.uri]);
    // The player passes through the song Next went to, then comes back.
    await playing(c.uri, 0);
    await playing(b.uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(queued().at(-1)).toBe(c.uri);
    await untilNextSet();
    expect(prompt()).not.toContain(`They skipped "${b.name}"`);
    expect(prompt()).not.toContain(`They skipped "${c.name}"`);
  });

  it("sends one Next into the next set when Next is pressed twice quickly on a set's last song", async () => {
    await liveStarted();
    await untilNextSet();
    // The next set's first song goes into the player's queue.
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(sp.addToQueue).toHaveBeenCalledWith(dj.upNext!.songs[0].uri, "here");
    dj.skipTalk();
    dj.skipTalk();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.next).toHaveBeenCalledOnce();
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
  });

  it("goes back only once the next set's song is in the queue", async () => {
    await liveStarted();
    const [a, b] = dj.current!.songs;
    await finish();
    await playing(b.uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    await finish();
    await playing(dj.current!.songs[2].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.upNext).not.toBeNull();
    let added!: () => void;
    sp.addToQueue.mockImplementationOnce(() => new Promise((r) => (added = () => r(null))));
    await tick();
    backend.device.mockClear();
    const back = dj.previous();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.device).not.toHaveBeenCalled();
    added();
    await back;
    expect(sent()).toEqual(["clear_queue", `queue ${b.uri}`, "next"]);
    expect(a).toBeDefined();
  });

  it("still tells the model about a skip when the set after it was made from a template", async () => {
    const set = await liveStarted();
    await playing(dj.current!.songs[1].uri, 0);
    backend.djGenerate.mockRejectedValueOnce(new Error("too slow"));
    await untilNextSet();
    expect(dj.upNext!.byModel).toBe(false);
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    await nextSet();
    await untilNextSet();
    expect(prompt()).toContain(`They skipped "${set.songs[0].name}"`);
  });

  it("does nothing on previous while the DJ talks", async () => {
    speechMs = 20_000;
    const first = await started();
    await lastSong2(first);
    await dj.previous();
    expect(player.prev).not.toHaveBeenCalled();
  });

  it("stays in the set when Next is pressed twice quickly", async () => {
    const set = await liveStarted();
    const [, b] = dj.current!.songs;
    backend.device.mockClear();
    // Two presses, before the player says the first one has landed.
    dj.skipTalk();
    dj.skipTalk();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.next).toHaveBeenCalledTimes(2);
    const c = dj.current!.songs[2];
    expect(c).toBeDefined();
    expect(c.uri).toBe(set.plan[2].uri);
    // The song after the second one went in the queue before the second Next.
    const queuedAt = backend.device.mock.invocationCallOrder[backend.device.mock.calls.findIndex(([x]) => (x as { uri?: string }).uri === c.uri)];
    expect(queuedAt).toBeLessThan(player.next.mock.invocationCallOrder[1]);
    expect(queuedAt).toBeGreaterThan(player.next.mock.invocationCallOrder[0]);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
    // The songs come up; nothing more is lined up for the one between.
    await playing(b.uri, 0);
    expect(queued().filter((u) => u === c.uri)).toHaveLength(1);
  });

  it("sends Next only once the song it's lining up is in the player's queue", async () => {
    let lined!: () => void;
    await liveStarted(() => {
      backend.device.mockImplementation(async (c: unknown) => {
        if ((c as { action: string }).action === "queue") return new Promise<void>((r) => (lined = r));
      });
    });
    dj.skipTalk();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.next).not.toHaveBeenCalled();
    lined();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.next).toHaveBeenCalledOnce();
    backend.device.mockImplementation(async () => {});
  });

  it("skips the rest of a set picked as it goes: what it lined up goes, and nothing more is lined up", async () => {
    const set = await liveStarted();
    await finish();
    await playing(dj.current!.songs[1].uri, 1000);
    await vi.advanceTimersByTimeAsync(0);
    const playingNow = dj.current!.songs[1];
    // The next set takes the model a while.
    let answer!: (v: unknown) => void;
    backend.djGenerate.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    backend.device.mockClear();
    await dj.skipSet();
    expect(backend.device).toHaveBeenCalledWith({ action: "clear_queue" });
    expect(backend.device).toHaveBeenCalledWith({ action: "pause" });
    await tick();
    await tick();
    expect(queued()).toEqual([]);
    answer({ name: "Something else", songs: [1, 2, 3], talk: "Let's try something different, shall we." });
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.onAir?.name).toBe("Something else");
    await vi.advanceTimersByTimeAsync(speechMs);
    voice.end();
    await vi.advanceTimersByTimeAsync(0);
    const next = dj.upNext!;
    await playing(next.songs[0].uri, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(dj.current?.id).toBe(next.id);
    // Leaving the skipped set isn't a skip of the song that was playing.
    await untilNextSet();
    expect(prompt()).not.toContain(`They skipped "${playingNow.name}"`);
    expect(set.id).toBeLessThan(next.id);
  });

  it("lines nothing more up when a set is skipped as a song comes up", async () => {
    await liveStarted();
    await finish();
    backend.djGenerate.mockImplementationOnce(() => new Promise(() => {}));
    // The second song starts, and the set is skipped before the DJ lines up the third.
    player.track = { uri: dj.current!.songs[1].uri, durationMs: DURATION };
    player.pos = 0;
    backend.device.mockClear();
    await dj.skipSet();
    await tick();
    await tick();
    expect(queued()).toEqual([]);
  });

  it("is off by default, and picks a whole set ahead then", async () => {
    expect(dj.live).toBe(false);
    const first = await started();
    expect(first.live).toBe(false);
    expect(first.songs).toEqual(first.plan);
    expect(queued()).toEqual([]);
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

  it("leaves music the listener picks while it's paused alone, and steps out", async () => {
    speechMs = 20_000;
    const first = await started();
    await lastSong2(first);
    dj.togglePause();
    expect(backend.device).toHaveBeenLastCalledWith({ action: "pause" });
    player.isPlaying = false;
    backend.device.mockClear();
    await playing("spotify:track:mine", 0);
    await vi.advanceTimersByTimeAsync(mod.FOREIGN_MS + mod.TICK_MS * 2);
    expect(backend.device).not.toHaveBeenCalledWith({ action: "pause" });
    expect(dj.phase).toBe("off");
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
