import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DjEvent, DjSet, OnAir, SaidLine } from "./dj.svelte";
import type { Candidate } from "./djPicks";
import type { DjSongView } from "./djExtensions.svelte";
import type { AddedItem } from "./menu.svelte";
import { SEGMENT_BRIEF_MAX } from "./djTalk";

let m: typeof import("./djExtensions.svelte");

beforeEach(async () => {
  vi.resetModules();
  m = await import("./djExtensions.svelte");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function song(n: number): Candidate {
  return {
    uri: `spotify:track:t${n}`,
    name: `Song ${n}`,
    artists: [`Artist ${n}`],
    artistIds: [`a${n}`],
    album: "Album",
    year: "2011",
    durationMs: 200_000,
    explicit: false,
    reasons: ["onRepeat", "likedLately"],
    likedAt: new Date("2026-09-01T10:00:00Z"),
    playedAt: null,
  };
}

function set(id: number, songs = [song(1), song(2)]): DjSet {
  return {
    id,
    segment: "onRepeat",
    from: null,
    name: `Set ${id}`,
    songs,
    live: false,
    plan: songs,
    choices: [song(9)],
    talk: "Here's one you've had on repeat.",
    byModel: false,
    why: "OpenAI didn't accept your API key: sk-pr…abcd",
    request: null,
    speech: { id: 1, durationMs: 4000, lines: [] } as unknown as DjSet["speech"],
    firstVocals: null,
    lookedUp: new Map(),
  };
}

const line = (setId: number): SaidLine => ({
  name: `Set ${setId}`,
  setId,
  talk: "Hello there.",
  byModel: false,
  why: "the model didn't answer in time",
  spoken: true,
});

/** A DJ to read, whose events go out when `emit` says. */
function fakeDj() {
  const listeners = new Set<(e: DjEvent) => void>();
  return {
    phase: "on" as "off" | "starting" | "on",
    ready: true,
    current: null as DjSet | null,
    upNext: null as DjSet | null,
    onAir: null as OnAir | null,
    said: [] as SaidLine[],
    speaking: false,
    showing: false,
    requested: null as string | null,
    listeners,
    on(fn: (e: DjEvent) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    emit(e: DjEvent) {
      for (const fn of [...listeners]) fn(e);
    },
  };
}

/** Records what an extension registered, and undoes it all when turned off. */
function tracker() {
  const undo: (() => void)[] = [];
  let on = true;
  return {
    live: () => on,
    /** How many undos it holds. */
    held: () => undo.length,
    track: vi.fn((fn: () => void) => {
      undo.push(fn);
      return () => {
        const i = undo.indexOf(fn);
        if (i >= 0) undo.splice(i, 1)[0]();
      };
    }),
    turnOff() {
      on = false;
      for (const fn of undo.splice(0).reverse()) fn();
    },
  };
}

const owner = { id: "log.js", name: "DJ log" };

function api(dj = fakeDj(), t = tracker(), add = vi.fn((_item: AddedItem<DjSet>) => () => {})) {
  return { ns: m.djApi(dj, owner, t, add), dj, t, add };
}

describe("copies", () => {
  it("are frozen, and leave out what the DJ keeps to itself", () => {
    const s = set(1);
    const view = m.setView(s);
    expect(Object.keys(view).sort()).toEqual(["byModel", "from", "id", "live", "name", "request", "segment", "songs", "talk"]);
    expect(view).toMatchObject({ id: 1, name: "Set 1", segment: "onRepeat", talk: "Here's one you've had on repeat." });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.songs)).toBe(true);
    expect(Object.isFrozen(view.songs[0])).toBe(true);
    expect(Object.isFrozen(view.songs[0].artists)).toBe(true);
    expect(() => (view.songs as unknown[]).push(1)).toThrow();
    expect(() => ((view.songs[0].artists as string[])[0] = "Someone else")).toThrow();
    // The DJ's own objects are untouched by them.
    expect(Object.isFrozen(s.songs)).toBe(false);
    expect(Object.isFrozen(s.songs[0])).toBe(false);
  });

  it("give a song's listening, with its dates as text", () => {
    const view = m.songView(song(1));
    expect(view).toEqual({
      uri: "spotify:track:t1",
      name: "Song 1",
      artists: ["Artist 1"],
      album: "Album",
      year: "2011",
      durationMs: 200_000,
      explicit: false,
      reasons: ["onRepeat", "likedLately"],
      likedAt: "2026-09-01T10:00:00.000Z",
      playedAt: null,
    });
  });

  it("leave out why a line came from a template, which may quote a provider's error", () => {
    expect(m.lineView(line(1))).toEqual({ setId: 1, name: "Set 1", talk: "Hello there.", byModel: false, spoken: true });
  });

  it("are the same for the same set, and new for a new one", () => {
    const s = set(1);
    expect(m.setView(s)).toBe(m.setView(s));
    // A set picked as it goes is a new object each time it grows.
    const grown = { ...s, songs: [...s.songs, song(3)] };
    expect(m.setView(grown)).not.toBe(m.setView(s));
    expect(m.setView(grown).songs[0]).toBe(m.setView(s).songs[0]);
  });
});

describe("ns.dj", () => {
  it("reads the DJ as copies", () => {
    const { ns, dj } = api();
    expect(ns.current).toBeNull();
    const s = set(1);
    dj.current = s;
    dj.upNext = set(2);
    dj.onAir = { name: "Set 2", durationMs: 5000, next: dj.upNext.songs[0], set: dj.upNext };
    dj.said = [line(1)];
    dj.requested = "something calm";
    expect(ns.current).toBe(m.setView(s));
    expect(ns.upNext?.id).toBe(2);
    expect(ns.onAir).toEqual({ setId: 2, name: "Set 2", durationMs: 5000, next: m.songView(dj.upNext.songs[0]) });
    expect(ns.said).toEqual([m.lineView(dj.said[0])]);
    expect(Object.isFrozen(ns.said)).toBe(true);
    expect(ns).toMatchObject({ phase: "on", ready: true, speaking: false, showing: false, requested: "something calm" });
  });

  it("gives the same list of lines until the DJ says something", () => {
    const { ns, dj } = api();
    dj.said = [line(1)];
    const said = ns.said;
    expect(ns.said).toBe(said);
    dj.said = [...dj.said, line(2)];
    expect(ns.said).not.toBe(said);
    expect(ns.said[0]).toBe(said[0]);
  });

  it("offers no settings, keys, errors or controls", () => {
    const { ns } = api();
    for (const key of ["status", "configure", "setKey", "modelTrouble", "voiceTrouble", "start", "stop", "generate", "instructions"]) {
      expect(key in ns, key).toBe(false);
    }
    expect(Object.isFrozen(ns)).toBe(true);
  });
});

describe("events", () => {
  it("reach an extension just after the DJ's step, as copies", async () => {
    const { ns, dj } = api();
    const heard: unknown[] = [];
    ns.on((e) => void heard.push(e));
    const s = set(1);
    dj.emit({ type: "set-started", set: s });
    dj.emit({ type: "song-started", song: s.songs[0], set: null });
    dj.emit({ type: "line-spoken", line: line(1) });
    dj.emit({ type: "stopped" });
    expect(heard).toEqual([]);
    await Promise.resolve();
    expect(heard).toEqual([
      { type: "set-started", set: m.setView(s) },
      { type: "song-started", song: m.songView(s.songs[0]), set: null },
      { type: "line-spoken", line: m.lineView(line(1)) },
      { type: "stopped" },
    ]);
    expect(heard.every((e) => Object.isFrozen(e))).toBe(true);
  });

  it("stop at once when the listener is removed, even one already on its way", async () => {
    const { ns, dj } = api();
    const fn = vi.fn();
    const off = ns.on(fn);
    dj.emit({ type: "stopped" });
    off();
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
    expect(dj.listeners.size).toBe(0);
  });

  it("go on to the other listeners when one throws, which is logged under the extension's name", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ns, dj } = api();
    ns.on(() => {
      throw new Error("oops");
    });
    const fn = vi.fn();
    ns.on(fn);
    dj.emit({ type: "stopped" });
    await Promise.resolve();
    expect(fn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("[DJ log] a DJ event listener failed", expect.any(Error));
  });

  it("stop when the extension is turned off", async () => {
    const { ns, dj, t } = api();
    const fn = vi.fn();
    ns.on(fn);
    expect(dj.listeners.size).toBe(1);
    t.turnOff();
    expect(dj.listeners.size).toBe(0);
    dj.emit({ type: "stopped" });
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("set actions", () => {
  it("see the set as a copy", () => {
    const { ns, add } = api();
    const action = vi.fn();
    const when = vi.fn(() => true);
    const label = vi.fn((s: { name: string }) => `Log ${s.name}`);
    ns.addSetAction({ label, when, action });
    const item = add.mock.calls[0][0];
    const s = set(1);
    expect(typeof item.label === "function" && item.label(s)).toBe("Log Set 1");
    expect(item.when?.(s)).toBe(true);
    item.action(s);
    for (const fn of [label, when, action]) expect(fn).toHaveBeenCalledWith(m.setView(s));
  });

  it("are removed when the extension is turned off", () => {
    const removed = vi.fn();
    const { ns, t } = api(fakeDj(), tracker(), vi.fn(() => removed));
    ns.addSetAction({ label: "Log it", action: () => {} });
    t.turnOff();
    expect(removed).toHaveBeenCalledOnce();
  });
});

describe("instructions", () => {
  const a = { id: "a.js", name: "A" };
  const b = { id: "b.js", name: "B" };
  const given = () => m.djExtensions.instructions.map((x) => `${x.owner.name}: ${x.text}`);

  it("are one set per extension, kept in the order first given", () => {
    m.djExtensions.setInstructions(a, "Keep it light.");
    m.djExtensions.setInstructions(b, "No explicit songs.");
    m.djExtensions.setInstructions(a, "  Keep it short.  ");
    expect(given()).toEqual(["A: Keep it short.", "B: No explicit songs."]);
    // Taken back, and given again: last.
    expect(m.djExtensions.setInstructions(a, "   ")).toBeNull();
    expect(given()).toEqual(["B: No explicit songs."]);
    m.djExtensions.setInstructions(a, "Keep it short.");
    expect(given()).toEqual(["B: No explicit songs.", "A: Keep it short."]);
  });

  it("are capped, never in the middle of a character", async () => {
    const { EXTENSION_INSTRUCTIONS_MAX } = await import("./djTalk");
    m.djExtensions.setInstructions(a, "x".repeat(EXTENSION_INSTRUCTIONS_MAX + 50));
    expect(m.djExtensions.instructions[0].text).toHaveLength(EXTENSION_INSTRUCTIONS_MAX);
    // Half an emoji isn't valid JSON for the backend, which would turn the whole request away.
    m.djExtensions.setInstructions(a, "x".repeat(EXTENSION_INSTRUCTIONS_MAX - 1) + "😀");
    expect(m.djExtensions.instructions[0].text).toBe("x".repeat(EXTENSION_INSTRUCTIONS_MAX - 1));
  });

  it("of nothing but quote marks and invisible characters are none", () => {
    m.djExtensions.setInstructions(a, "Keep it light.");
    expect(m.djExtensions.setInstructions(a, ' "" \u200B" ')).toBeNull();
    expect(given()).toEqual([]);
  });

  it("said again are kept as they were, with the same remover", () => {
    const first = m.djExtensions.setInstructions(a, "Keep it light.");
    m.djExtensions.setInstructions(b, "No explicit songs.");
    const before = m.djExtensions.instructions;
    expect(m.djExtensions.setInstructions(a, " Keep it light. ")).toBe(first);
    expect(m.djExtensions.instructions).toBe(before);
    const { ns, t } = api();
    const remove = ns.setInstructions("One.");
    expect(ns.setInstructions("One.")).toBe(remove);
    expect(t.held()).toBe(1);
    remove();
    expect(given()).toEqual(["A: Keep it light.", "B: No explicit songs."]);
  });

  it("reach the model as far as they fit, the first given first", () => {
    const owners = ["a", "b", "c", "d"].map((id) => ({ id, name: id }));
    const lengths = [300, 250, 60, 40];
    owners.forEach((o, i) => m.djExtensions.setInstructions(o, "x".repeat(lengths[i])));
    expect(m.EXTENSION_INSTRUCTIONS_BUDGET).toBe(600);
    // 60 more would make 610: it waits, and the 40 after it fits.
    expect(m.djExtensions.promptInstructions().map((x) => x.owner.id)).toEqual(["a", "b", "d"]);
    m.djExtensions.setInstructions(owners[1], "");
    expect(m.djExtensions.promptInstructions().map((x) => x.owner.id)).toEqual(["a", "c", "d"]);
  });

  it("are given through ns.dj, and taken back by its remover or by turning the extension off", () => {
    const { ns, t } = api();
    const remove = ns.setInstructions("Keep it light.");
    expect(given()).toEqual(["DJ log: Keep it light."]);
    remove();
    expect(given()).toEqual([]);
    ns.setInstructions("Keep it short.");
    t.turnOff();
    expect(given()).toEqual([]);
  });

  it("given again replace the last, whose remover then does nothing, and don't pile up", () => {
    const { ns, t } = api();
    const first = ns.setInstructions("One.");
    for (const text of ["Two.", "Three.", "Four."]) ns.setInstructions(text);
    expect(given()).toEqual(["DJ log: Four."]);
    expect(t.held()).toBe(1);
    first();
    expect(given()).toEqual(["DJ log: Four."]);
    ns.setInstructions("");
    expect(given()).toEqual([]);
    expect(t.held()).toBe(0);
  });
});

describe("segments", () => {
  const a = { id: "a.js", name: "A" };
  const short = { id: "short", label: "Short songs", brief: "songs under three minutes", fits: (s: DjSongView) => s.durationMs < 180_000 };
  const ids = () => m.djExtensions.segments.map((x) => x.segment.id);

  it("are named for their extension, and tell which of the listener's songs fit from copies of them", () => {
    const seen: DjSongView[] = [];
    const entry = m.djExtensions.addSegment(a, { ...short, fits: (s) => (seen.push(s), short.fits(s)) });
    expect(entry.segment).toMatchObject({ id: "ext:a.js/short", label: "Short songs", brief: "songs under three minutes", phrase: "Short songs", from: "A" });
    const long = song(1);
    expect(entry.segment.fits(long)).toBe(false);
    expect(entry.segment.fits({ ...long, durationMs: 120_000 })).toBe(true);
    expect(seen[0]).toBe(m.songView(long));
    expect(Object.isFrozen(seen[0])).toBe(true);
    // Whatever it answers that's true-ish fits.
    expect(m.djExtensions.addSegment(a, { ...short, fits: () => 1 as unknown as boolean }).segment.fits(long)).toBe(true);
    // An id can't pass for one of the DJ's own.
    expect(m.djExtensions.addSegment(a, { ...short, id: "request" }).segment.id).toBe("ext:a.js/request");
  });

  it("have their names and phrases cleaned for the DJ to say, and capped", () => {
    const entry = m.djExtensions.addSegment(a, {
      id: "x",
      label: "  **Short** songs 🎵 " + "x".repeat(60),
      brief: "  ",
      phrase: "some *short* songs",
      fits: () => true,
    });
    expect(entry.segment.label).toBe(("Short songs " + "x".repeat(60)).slice(0, m.SEGMENT_LABEL_MAX));
    // Without a brief, it's what its name says.
    expect(entry.segment.brief).toBe(entry.segment.label);
    expect(entry.segment.phrase).toBe("some short songs");
    expect(m.djExtensions.addSegment(a, { ...short, id: "y", phrase: "z".repeat(200) }).segment.phrase).toHaveLength(m.SEGMENT_PHRASE_MAX);
    expect(m.djExtensions.addSegment(a, { ...short, id: "z", label: " " }).segment.label).toBe("z");
    // Quote marks would end the DJ's quote of them early.
    const quoted = m.djExtensions.addSegment(a, { ...short, id: "y", label: '"Short" “songs”', phrase: 'some "short" ones' }).segment;
    expect([quoted.label, quoted.phrase]).toEqual(["Short songs", "some short ones"]);
    // Never cut in the middle of a character.
    const wide = "x".repeat(m.SEGMENT_LABEL_MAX - 1) + "𠀀";
    const phrase = "x".repeat(m.SEGMENT_PHRASE_MAX - 1) + "𠀀";
    const cut = m.djExtensions.addSegment(a, { ...short, id: "y", label: wide, phrase, brief: "y".repeat(SEGMENT_BRIEF_MAX - 1) + "😀" });
    expect(cut.segment.label).toBe("x".repeat(m.SEGMENT_LABEL_MAX - 1));
    expect(cut.segment.phrase).toBe("x".repeat(m.SEGMENT_PHRASE_MAX - 1));
    expect(cut.segment.brief).toBe("y".repeat(SEGMENT_BRIEF_MAX - 1));
    // A brief of nothing but quote marks says nothing: its name does.
    expect(m.djExtensions.addSegment(a, { ...short, id: "y", brief: ' """" ' }).segment.brief).toBe("Short songs");
  });

  it("are up to three an extension, one with the same id replacing it", () => {
    for (const id of ["one", "two", "three"]) m.djExtensions.addSegment(a, { ...short, id });
    expect(() => m.djExtensions.addSegment(a, { ...short, id: "four" })).toThrow("up to 3 DJ segments");
    m.djExtensions.addSegment(a, { ...short, id: "two", label: "Shorter" });
    expect(m.djExtensions.segments.map((x) => x.segment.label)).toEqual(["Short songs", "Shorter", "Short songs"]);
    // Another extension has three of its own.
    m.djExtensions.addSegment({ id: "b.js", name: "B" }, short);
    expect(m.djExtensions.promptSegments().map((s) => s.id)).toEqual(["ext:a.js/one", "ext:a.js/two", "ext:a.js/three", "ext:b.js/short"]);
  });

  it("need a short word for an id, and a fits function", () => {
    for (const id of ["", " ", "short songs", "a/b", "ext:x", "é", "x".repeat(41), undefined]) {
      expect(() => m.djExtensions.addSegment(a, { ...short, id: id as never })).toThrow("A DJ segment's id is 1 to 40 of");
    }
    expect(() => m.djExtensions.addSegment(a, { ...short, fits: undefined as never })).toThrow("fits(song)");
    expect(ids()).toEqual([]);
    m.djExtensions.addSegment(a, { ...short, id: "x".repeat(40) });
    m.djExtensions.addSegment(a, { ...short, id: "Short-songs_2.0" });
    expect(ids()).toEqual([`ext:a.js/${"x".repeat(40)}`, "ext:a.js/Short-songs_2.0"]);
  });

  it("don't fit a song when they can't tell, and say so once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const entry = m.djExtensions.addSegment(a, {
      ...short,
      fits: () => {
        throw new Error("oops");
      },
    });
    expect(entry.segment.fits(song(1))).toBe(false);
    expect(entry.segment.fits(song(2))).toBe(false);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('[A] the DJ segment "Short songs" couldn\'t tell whether a song fits', expect.any(Error));
  });

  it("are added through ns.dj, and taken away by its remover or by turning the extension off", () => {
    const { ns, t } = api();
    const remove = ns.addSegment(short);
    expect(ids()).toEqual(["ext:log.js/short"]);
    remove();
    expect(ids()).toEqual([]);
    const first = ns.addSegment(short);
    ns.addSegment({ ...short, label: "Shorter" });
    // The one replaced doesn't pile up, and has nothing left to take away.
    expect(t.held()).toBe(1);
    first();
    expect(m.djExtensions.segments.map((x) => x.segment.label)).toEqual(["Shorter"]);
    t.turnOff();
    expect(ids()).toEqual([]);
  });
});

it("adds nothing once the extension is turned off", async () => {
  const { ns, dj, t, add } = api();
  t.turnOff();
  const fn = vi.fn();
  const removers = [
    ns.on(fn),
    ns.addSetAction({ label: "Late", action: () => {} }),
    ns.setInstructions("Late."),
    ns.addSegment({ id: "late", label: "Late", brief: "late", fits: () => true }),
  ];
  expect(dj.listeners.size).toBe(0);
  expect(m.djExtensions.instructions).toEqual([]);
  expect(m.djExtensions.segments).toEqual([]);
  expect(add).not.toHaveBeenCalled();
  expect(t.track).not.toHaveBeenCalled();
  dj.emit({ type: "stopped" });
  await Promise.resolve();
  expect(fn).not.toHaveBeenCalled();
  for (const remove of removers) remove();
  // Still readable, as the player is.
  expect(ns.phase).toBe("on");
});
