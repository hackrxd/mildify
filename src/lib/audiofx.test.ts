import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: { level: number; bass: number } }) => void;
let handler: Handler | undefined;
const unlisten = vi.fn();
const audioMeter = vi.fn(async (_on: boolean) => {});
const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_: string, fn: Handler) => {
    handler = fn;
    return unlisten;
  },
}));
vi.mock("./ipc", () => ({ backend: { audioMeter: (on: boolean) => audioMeter(on) } }));
vi.mock("./motion", () => ({ reducedMotion: () => motion.reduced }));

let mod: typeof import("./audiofx.svelte");
/** Pending animation frame callbacks, run by `frames`. */
let queued: FrameRequestCallback[];
let clock: number;

function frames(n: number, ms = 16) {
  for (let i = 0; i < n; i++) {
    clock += ms;
    const run = queued;
    queued = [];
    for (const cb of run) cb(clock);
  }
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  handler = undefined;
  unlisten.mockClear();
  audioMeter.mockClear();
  motion.reduced = false;
  queued = [];
  clock = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queued.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => (queued = []));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  mod = await import("./audiofx.svelte");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Pulse", () => {
  it("stays still in silence", () => {
    const p = new mod.Pulse();
    p.feed(0);
    for (let i = 0; i < 60; i++) p.step(16);
    expect(p.value).toBe(0);
  });

  it("jumps on a hit and falls back after it", () => {
    const p = new mod.Pulse();
    p.feed(0.01);
    for (let i = 0; i < 60; i++) p.step(16);
    const resting = p.value;
    p.feed(0.2);
    for (let i = 0; i < 5; i++) p.step(16);
    const hit = p.value;
    expect(hit).toBeGreaterThan(0.8);
    p.feed(0.01);
    for (let i = 0; i < 30; i++) p.step(16);
    expect(p.value).toBeLessThan(hit / 4);
    expect(p.value).toBeLessThanOrEqual(resting + 0.01);
  });

  it("moves the same at any volume", () => {
    const loud = new mod.Pulse();
    const quiet = new mod.Pulse();
    for (let i = 0; i < 120; i++) {
      const beat = i % 30 < 4;
      loud.feed(beat ? 0.3 : 0.05);
      quiet.feed(beat ? 0.03 : 0.005);
      loud.step(16);
      quiet.step(16);
      expect(quiet.value).toBeCloseTo(loud.value, 2);
    }
  });

  it("settles under sustained bass", () => {
    const p = new mod.Pulse();
    p.feed(0.2);
    for (let i = 0; i < 5; i++) p.step(16);
    const onset = p.value;
    for (let i = 0; i < 120; i++) p.step(16);
    expect(p.value).toBeLessThan(onset * 0.6);
  });

  it("ignores bad levels and long frames", () => {
    const p = new mod.Pulse();
    p.feed(Number.NaN);
    expect(p.step(10_000)).toBe(0);
    p.feed(-1);
    expect(p.step(-5)).toBe(0);
  });
});

describe("audioFx", () => {
  it("is off until turned on, and remembers it", async () => {
    expect(mod.audioFx.on).toBe(false);
    mod.audioFx.setOn(true);
    vi.resetModules();
    expect((await import("./audiofx.svelte")).audioFx.on).toBe(true);
    mod.audioFx.setOn(false);
    expect(localStorage.getItem("nativify:audioFx")).toBeNull();
  });

  it("pulses the element with the levels and cleans up after", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    const detach = mod.audioFx.attach(() => el);
    await vi.waitFor(() => expect(handler).toBeDefined());
    expect(audioMeter).toHaveBeenCalledWith(true);

    handler!({ payload: { level: 0.5, bass: 0.3 } });
    frames(5);
    expect(Number(el.style.getPropertyValue("--audio-pulse"))).toBeGreaterThan(0.5);

    detach();
    expect(el.style.getPropertyValue("--audio-pulse")).toBe("");
    expect(audioMeter).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
    el.remove();
  });

  it("finds the element again once it's replaced", () => {
    let el = document.createElement("div");
    document.body.append(el);
    const detach = mod.audioFx.attach(() => el);
    frames(1);
    expect(el.style.getPropertyValue("--audio-pulse")).toBe("0.000");
    el.remove();
    el = document.createElement("div");
    document.body.append(el);
    frames(1);
    expect(el.style.getPropertyValue("--audio-pulse")).toBe("0.000");
    detach();
    el.remove();
  });

  it("keeps the meter on while anything is pulsing", () => {
    const a = mod.audioFx.attach(() => null);
    const b = mod.audioFx.attach(() => null);
    a();
    expect(audioMeter.mock.calls).toEqual([[true]]);
    b();
    expect(audioMeter.mock.calls).toEqual([[true], [false]]);
  });

  it("does nothing when the system asks for less motion", () => {
    motion.reduced = true;
    mod.audioFx.attach(() => null)();
    expect(audioMeter).not.toHaveBeenCalled();
    expect(queued).toEqual([]);
  });
});
