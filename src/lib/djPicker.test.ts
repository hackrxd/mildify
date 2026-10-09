import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEGMENTS, type Candidate } from "./djPicks";
import type { SegmentAsk } from "./djTalk";

const backend = vi.hoisted(() => ({
  djLookUp: vi.fn(),
  djSongInfo: vi.fn(),
  djGenerate: vi.fn(),
  lyrics: vi.fn(),
}));
vi.mock("./ipc", async (actual) => ({ ...(await actual<typeof import("./ipc")>()), backend }));
vi.mock("./lyrics.svelte", () => ({ lyrics: { songOffsets: {} } }));

const { askModel, GaveUp, lookUp, songVocals } = await import("./djPicker");

const choices: Candidate[] = Array.from({ length: 4 }, (_, i) => ({
  uri: `spotify:track:c${i}`,
  name: `Song ${i}`,
  artists: [`Artist ${i}`],
  album: "",
  year: null,
  durationMs: 1,
  explicit: false,
  reasons: ["onRepeat"],
  likedAt: null,
  playedAt: null,
}));
const ask: SegmentAsk = {
  segment: SEGMENTS.find((s) => s.id === "onRepeat")!,
  choices,
  listener: null,
  previous: null,
  instructions: "",
  now: new Date("2026-10-04T20:30:00"),
};
const answer = { name: "Set", songs: [2, 1, 3], talk: "Here's Song 1 by Artist 1." };
const now = <T,>(round: Promise<T>) => round;

beforeEach(() => {
  for (const f of Object.values(backend)) f.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("askModel", () => {
  it("returns the model's pick", async () => {
    backend.djGenerate.mockResolvedValue(answer);
    const round = await askModel(ask, { tools: false, wait: now, stale: () => false });
    expect(round.pick?.songs.map((s) => s.uri)).toEqual(["spotify:track:c1", "spotify:track:c0", "spotify:track:c2"]);
    expect(round).toMatchObject({ why: null, trouble: null });
    expect(backend.djLookUp).not.toHaveBeenCalled();
  });

  it("looks songs up first when the model can, and hands back what it found", async () => {
    backend.djLookUp.mockResolvedValue({ calls: [{ name: "look_up_songs", arguments: { songs: [2] } }] });
    backend.djSongInfo.mockResolvedValue([
      {
        uri: "spotify:track:c1",
        genres: ["shoegaze"],
        tags: [],
        released: null,
        label: null,
        album: null,
        album_type: null,
        popularity: null,
        languages: [],
        artist_bio: null,
        artist_active: null,
        related_artists: [],
      },
    ]);
    backend.djGenerate.mockResolvedValue(answer);
    const round = await askModel(ask, { tools: true, wait: now, stale: () => false });
    const [messages] = backend.djGenerate.mock.calls[0] as [{ content: string }[]];
    expect(messages[1].content).toContain("What you looked up:");
    expect(messages[1].content).toContain("shoegaze");
    expect(round.found.get("spotify:track:c1")?.genres).toEqual(["shoegaze"]);
  });

  it("says why there's no pick: an unusable answer, a wait given up, or a failure to tell the listener about", async () => {
    backend.djGenerate.mockResolvedValue({ name: "x", songs: [], talk: "" });
    expect(await askModel(ask, { tools: false, wait: now, stale: () => false })).toMatchObject({
      pick: null,
      why: "the model's answer wasn't usable",
      trouble: null,
    });
    const gaveUp = <T,>(_: Promise<T>) => Promise.reject<T>(new GaveUp("the music can't wait"));
    expect(await askModel(ask, { tools: false, wait: gaveUp, stale: () => false })).toMatchObject({
      pick: null,
      why: "the model didn't answer in time",
      trouble: null,
    });
    backend.djGenerate.mockRejectedValue({ kind: "other", message: "OpenAI didn't accept your API key: no" });
    expect(await askModel(ask, { tools: false, wait: now, stale: () => false })).toMatchObject({
      pick: null,
      why: "OpenAI didn't accept your API key: no",
      trouble: "OpenAI didn't accept your API key: no",
    });
  });

  it("reads the answer as the set's ask says: the opening may welcome, and a request grows only by what it names", async () => {
    backend.djGenerate.mockResolvedValue({ name: "Set", songs: [2, 3], talk: "Welcome! Here's Song 1 by Artist 1." });
    const later = { ...ask, previous: { name: "Midnight City", artists: ["M83"] }, topUp: [choices[3]] };
    const round = await askModel(later, { tools: false, wait: now, stale: () => false });
    expect(round.pick?.songs.map((c) => c.name)).toEqual(["Song 1", "Song 2", "Song 3"]);
    expect(round.pick?.talk).toBe("Here's Song 1 by Artist 1.");
    const opening = await askModel(ask, { tools: false, wait: now, stale: () => false });
    expect(opening.pick?.talk).toBe("Welcome! Here's Song 1 by Artist 1.");
  });

  it("asks for a line as long as the setting says, and keeps the answer to it", async () => {
    const talk = "What a week of music you've had, and plenty more to come tonight. Here's Song 1 by Artist 1. Then more.";
    backend.djGenerate.mockResolvedValue({ ...answer, talk });
    const brief = await askModel({ ...ask, talk: "brief" }, { tools: false, wait: now, stale: () => false });
    const [, schema, maxTokens] = backend.djGenerate.mock.calls[0] as [unknown, { properties: { talk: { maxLength: number } } }, number];
    expect([schema.properties.talk.maxLength, maxTokens]).toEqual([220, 250]);
    expect(brief.pick?.talk).toBe(talk);
    const chatty = await askModel({ ...ask, talk: "chatty" }, { tools: false, wait: now, stale: () => false });
    expect(backend.djGenerate.mock.calls[1].slice(2)).toEqual([400]);
    expect(chatty.pick?.talk).toBe(talk);
    // A model that ignores the schema's limit, as cloud ones do, is held to it here.
    backend.djGenerate.mockResolvedValue({ ...answer, talk: `${talk} ${"And on and on it goes. ".repeat(6)}` });
    const long = await askModel({ ...ask, talk: "brief" }, { tools: false, wait: now, stale: () => false });
    expect(long.pick?.talk.length).toBeLessThanOrEqual(220);
    expect(long.pick?.talk).toContain("Here's Song 1 by Artist 1.");
  });

  it("asks for no pick once the set isn't wanted any more", async () => {
    backend.djLookUp.mockResolvedValue({ calls: [] });
    const round = await askModel(ask, { tools: true, wait: now, stale: () => true });
    expect(backend.djGenerate).not.toHaveBeenCalled();
    expect(round).toMatchObject({ pick: null, trouble: null });
  });

  it("has no trouble to tell of when an ask no longer wanted is dropped for a newer one", async () => {
    let stale = false;
    backend.djGenerate.mockImplementation(async () => {
      // A newer set is being picked now.
      stale = true;
      throw { kind: "other", message: "A newer request took this one's place", status: null };
    });
    const round = await askModel(ask, { tools: false, wait: now, stale: () => stale });
    expect(round).toMatchObject({ pick: null, trouble: null });
  });
});

describe("lookUp", () => {
  it("goes on without when the model asks for nothing, or the look-up fails", async () => {
    backend.djLookUp.mockResolvedValue({ calls: [] });
    expect(await lookUp(ask)).toBeNull();
    backend.djLookUp.mockRejectedValue(new Error("down"));
    expect(await lookUp(ask)).toBeNull();
  });
});

describe("songVocals", () => {
  it("has none when the song's lyrics can't be had", async () => {
    backend.lyrics.mockRejectedValue(new Error("no lyrics"));
    expect(await songVocals("spotify:track:c1")).toBeNull();
  });
});
