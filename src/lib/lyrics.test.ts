import { beforeEach, describe, expect, it, vi } from "vitest";
import { backend } from "./ipc";
import { toasts } from "./toasts.svelte";
import { copyText } from "./util";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("spicy-lyrics-renderer", () => ({ setHost: vi.fn() }));
vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  backend: { lyrics: vi.fn(), forgetLyrics: vi.fn(async () => {}), warmLyrics: vi.fn(async () => {}) },
}));
vi.mock("./spotify", () => ({ queue: vi.fn(async () => null) }));
vi.mock("./toasts.svelte", () => ({ toasts: { show: vi.fn(), error: vi.fn() } }));
vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./util")>()),
  copyText: vi.fn(async () => {}),
}));
type Store = typeof import("./lyrics.svelte");
let mod: Store;
let lyrics: Store["lyrics"];
let fake: { _s: Map<string, unknown> };

function play(id: string | null) {
  fake._s.set("track", id ? { uri: `spotify:track:${id}`, name: id, artists: [], album: { name: "" }, durationMs: 0 } : null);
}

async function fresh() {
  vi.resetModules();
  // The store derives the playing song from the player, so the fake has to be reactive. It's
  // mocked again per import: a hoisted mock outlives resetModules, but Svelte's runtime doesn't,
  // and state from the old runtime isn't tracked by the new one.
  vi.doMock("./player.svelte", async () => {
    const { SvelteMap } = await import("svelte/reactivity");
    const s = new SvelteMap<string, unknown>();
    return {
      player: {
        _s: s,
        get track() {
          return s.get("track") ?? null;
        },
        positionNow: () => 0,
        isPlaying: false,
        seek: vi.fn(),
      },
    };
  });
  mod = await import("./lyrics.svelte");
  lyrics = mod.lyrics;
  fake = (await import("./player.svelte")).player as unknown as typeof fake;
}

beforeEach(async () => {
  localStorage.clear();
  await fresh();
  play("a");
});

describe("song timing", () => {
  it("adds the playing song's nudge to the global offset", () => {
    lyrics.setOffset(100);
    lyrics.nudgeSong(50);
    lyrics.nudgeSong(50);
    expect(lyrics.songOffsetMs).toBe(100);
    expect(lyrics.totalOffsetMs).toBe(200);

    play("b");
    expect(lyrics.songOffsetMs).toBe(0);
    expect(lyrics.totalOffsetMs).toBe(100);

    play("a");
    expect(lyrics.totalOffsetMs).toBe(200);
  });

  it("is remembered across restarts, and 0 forgets the song", async () => {
    lyrics.setSongOffset(-250);
    play("b");
    lyrics.setSongOffset(300);
    lyrics.setSongOffset(0);
    await fresh();
    play("a");
    expect(lyrics.songOffsetMs).toBe(-250);
    expect(lyrics.songOffsets).toEqual({ a: -250 });
    expect(lyrics.songOffsetCount).toBe(1);
  });

  it("is capped at the largest nudge", () => {
    lyrics.setSongOffset(mod.SONG_OFFSET_MAX * 3);
    expect(lyrics.songOffsetMs).toBe(mod.SONG_OFFSET_MAX);
    lyrics.nudgeSong(-mod.SONG_OFFSET_MAX * 5);
    expect(lyrics.songOffsetMs).toBe(-mod.SONG_OFFSET_MAX);
  });

  it("drops the least recently adjusted songs past the cap", () => {
    for (let i = 0; i <= mod.SONG_OFFSETS_KEPT; i++) {
      play(`t${i}`);
      lyrics.setSongOffset(10);
    }
    // Adjusting t1 again makes it recent; t0 is the oldest and goes first.
    play("t1");
    lyrics.nudgeSong(10);
    play("new");
    lyrics.setSongOffset(10);
    expect(lyrics.songOffsetCount).toBe(mod.SONG_OFFSETS_KEPT);
    expect(lyrics.songOffsets.t0).toBeUndefined();
    expect(lyrics.songOffsets.t2).toBeUndefined();
    expect(lyrics.songOffsets.t1).toBe(20);
    expect(lyrics.songOffsets.new).toBe(10);
  });

  it("does nothing without a Spotify track playing", () => {
    play(null);
    lyrics.setSongOffset(100);
    expect(lyrics.songOffsetCount).toBe(0);
  });

  it("ignores stored nonsense", async () => {
    localStorage.setItem("nativify:lyricsSongOffsets", JSON.stringify({ a: "x", b: 0, c: 1e9, d: 12.6 }));
    await fresh();
    expect(lyrics.songOffsets).toEqual({ c: mod.SONG_OFFSET_MAX, d: 13 });
    localStorage.setItem("nativify:lyricsSongOffsets", "[1, 2]");
    await fresh();
    expect(lyrics.songOffsets).toEqual({});
  });

  it("forgets every song at once", async () => {
    lyrics.setSongOffset(100);
    lyrics.forgetSongOffsets();
    expect(lyrics.songOffsetMs).toBe(0);
    await fresh();
    expect(lyrics.songOffsetCount).toBe(0);
  });
});

describe("text size", () => {
  it("steps in tenths within its range and is remembered", async () => {
    lyrics.setTextScale(lyrics.textScale + mod.TEXT_SCALE_STEP);
    lyrics.setTextScale(lyrics.textScale + mod.TEXT_SCALE_STEP);
    expect(lyrics.textScale).toBe(1.2);
    await fresh();
    expect(lyrics.textScale).toBe(1.2);
  });

  it("stays between the smallest and largest size", () => {
    lyrics.setTextScale(0.1);
    expect(lyrics.textScale).toBe(mod.TEXT_SCALE_MIN);
    lyrics.setTextScale(lyrics.textScale + mod.TEXT_SCALE_STEP);
    expect(lyrics.textScale).toBe(0.8);
    lyrics.setTextScale(9);
    expect(lyrics.textScale).toBe(mod.TEXT_SCALE_MAX);
  });

  it("falls back to the renderer's size for stored nonsense", async () => {
    localStorage.setItem("nativify:lyricsTextScale", "-2");
    await fresh();
    expect(lyrics.textScale).toBe(1);
  });
});

describe("copy", () => {
  const response = { Body: { Type: "Static", Lines: [{ Text: "one", TransliteratedText: "uno" }, { Text: "two" }] } };

  it("copies the playing song's lyrics once they're loaded", async () => {
    vi.mocked(backend.lyrics).mockResolvedValue(response);
    expect(lyrics.hasText).toBe(false);
    await lyrics.fetchQuietly("a");
    expect(lyrics.hasText).toBe(true);

    await lyrics.copy();
    expect(copyText).toHaveBeenLastCalledWith("one\ntwo");
    await lyrics.copy(true);
    expect(copyText).toHaveBeenLastCalledWith("uno\ntwo");
    expect(toasts.show).toHaveBeenCalledWith("Lyrics copied");
  });

  it("doesn't copy another song's lyrics", async () => {
    vi.mocked(backend.lyrics).mockResolvedValue(response);
    await lyrics.fetchQuietly("a");
    play("b");
    expect(lyrics.hasText).toBe(false);
    await lyrics.copy();
    expect(copyText).not.toHaveBeenCalled();
  });

  it("reports a clipboard that refuses", async () => {
    vi.mocked(backend.lyrics).mockResolvedValue(response);
    vi.mocked(copyText).mockRejectedValueOnce(new Error("denied"));
    await lyrics.fetchQuietly("a");
    await lyrics.copy();
    expect(toasts.error).toHaveBeenCalled();
  });
});
