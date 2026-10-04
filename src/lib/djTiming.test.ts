import { describe, expect, it } from "vitest";
import { captionLines, planTalk, UNKNOWN_OUTRO_MS, vocals, VOCAL_GAP_MS, volumeGain } from "./djTiming";

const lineSync = {
  Type: "Line",
  Content: [
    { Text: "First", StartTime: 12.5, EndTime: 15 },
    { Text: "Last", StartTime: 170, EndTime: 182.25 },
  ],
};

describe("vocals", () => {
  it("reads where the singing starts and stops", () => {
    expect(vocals(lineSync)).toEqual({ first: 12_500, last: 182_250 });
    expect(vocals({ Body: lineSync })).toEqual({ first: 12_500, last: 182_250 });
  });

  it("knows nothing without a synced lyric", () => {
    expect(vocals(null)).toBeNull();
    expect(vocals({ Type: "Static", Lines: [{ Text: "words" }] })).toBeNull();
  });
});

describe("planTalk", () => {
  const old = { first: 10_000, last: 190_000 };

  it("talks over the next song's intro when the line fits there", () => {
    expect(planTalk({ speechMs: 5000, next: { first: 15_000, last: 1 }, old, oldLeftMs: 30_000, oldDurationMs: 200_000 })).toEqual({
      overOld: 0,
      hold: 0,
    });
  });

  it("starts over the end of the finishing song once its singer is done", () => {
    // 12 s of talk, a 6 s intro: about 6.7 s go before the next song, inside the 9.3 s outro.
    const plan = planTalk({ speechMs: 12_000, next: { first: 6000, last: 1 }, old, oldLeftMs: 30_000, oldDurationMs: 200_000 });
    expect(plan).toEqual({ overOld: 12_000 - (6000 - VOCAL_GAP_MS), hold: 0 });
  });

  it("holds the next song when the line is longer than both gaps", () => {
    // 20 s of talk, a 2 s intro, a 3 s outro.
    const plan = planTalk({ speechMs: 20_000, next: { first: 2000, last: 1 }, old: { first: 0, last: 197_000 }, oldLeftMs: 60_000, oldDurationMs: 200_000 });
    expect(plan.overOld).toBe(3000 - VOCAL_GAP_MS);
    expect(plan.overOld + plan.hold).toBe(20_000 - (2000 - VOCAL_GAP_MS));
  });

  it("assumes the singer starts at once, and a short outro, without lyrics", () => {
    const plan = planTalk({ speechMs: 8000, next: null, old: null, oldLeftMs: 60_000, oldDurationMs: 200_000 });
    expect(plan).toEqual({ overOld: UNKNOWN_OUTRO_MS, hold: 8000 - UNKNOWN_OUTRO_MS });
  });

  it("can't start in the past", () => {
    const plan = planTalk({ speechMs: 8000, next: null, old: null, oldLeftMs: 1200, oldDurationMs: 200_000 });
    expect(plan).toEqual({ overOld: 1200, hold: 6800 });
  });

  it("with nothing playing, the whole line goes before the music", () => {
    expect(planTalk({ speechMs: 9000, next: { first: 4700, last: 1 }, old: null, oldLeftMs: 0, oldDurationMs: 0 })).toEqual({
      overOld: 0,
      hold: 5000,
    });
  });
});

describe("captionLines", () => {
  it("times each word by its share of the sentence", () => {
    const [line, second] = captionLines([
      { text: "Hey there", start_ms: 0, end_ms: 900 },
      { text: "Up next", start_ms: 900, end_ms: 2000 },
    ]);
    expect(line.text).toBe("Hey there");
    expect(line.syllables?.map((s) => [s.text, s.start, s.end])).toEqual([
      ["Hey", 0, 337.5],
      ["there", 337.5, 900],
    ]);
    expect(second.start).toBe(900);
    expect(second.syllables?.at(-1)?.end).toBe(2000);
  });

  it("skips empty sentences", () => {
    expect(captionLines([{ text: "  ", start_ms: 0, end_ms: 10 }])).toEqual([]);
  });
});

describe("volumeGain", () => {
  it("follows librespot's volume curve", () => {
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(100)).toBe(1);
    expect(volumeGain(50)).toBeCloseTo(0.0316, 3);
    expect(volumeGain(150)).toBe(1);
  });
});
