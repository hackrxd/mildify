import { describe, expect, it } from "vitest";
import {
  captionLines,
  MAX_OVER_INTRO_MS,
  MAX_OVER_OUTRO_MS,
  MIN_OVER_INTRO_MS,
  MIN_OVER_OUTRO_MS,
  planTalk,
  UNKNOWN_OUTRO_MS,
  vocals,
  VOCAL_GAP_MS,
  volumeGain,
} from "./djTiming";

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
  const base = { old, oldLeftMs: 30_000, oldDurationMs: 200_000 };

  it("brings the next song in under the end of a line, at most half of it", () => {
    // 4 s of talk, a long intro: the song comes in 2 s in, and the first 2 s go over the finishing song.
    expect(planTalk({ ...base, speechMs: 4000, next: { first: 15_000, last: 1 } })).toEqual({
      overOld: 2000,
      hold: 0,
      musicAt: 2000,
      overIntro: 2000,
    });
  });

  it("is an item of its own: at most a few seconds over either song", () => {
    // 30 s of talk, long instrumental edges on both sides: 5 s over each, 20 s alone.
    const plan = planTalk({
      speechMs: 30_000,
      next: { first: 40_000, last: 1 },
      old: { first: 0, last: 100_000 },
      oldLeftMs: 90_000,
      oldDurationMs: 200_000,
    });
    expect(plan).toEqual({ overOld: MAX_OVER_OUTRO_MS, hold: 20_000, musicAt: 25_000, overIntro: MAX_OVER_INTRO_MS });
  });

  it("starts over the end of the finishing song once its singer is done", () => {
    // 7 s of talk, a 3 s intro: 2.3 s over the intro, the rest over the 9.3 s outro.
    const plan = planTalk({ ...base, speechMs: 7000, next: { first: 3000, last: 1 } });
    expect(plan).toEqual({ overOld: 7000 - 2300, hold: 0, musicAt: 7000 - 2300, overIntro: 2300 });
  });

  it("talks alone as long as it takes when the line is longer than both edges", () => {
    // 20 s of talk, a 3 s intro, a 3 s outro.
    const plan = planTalk({
      ...base,
      speechMs: 20_000,
      next: { first: 3000, last: 1 },
      old: { first: 0, last: 197_000 },
    });
    expect(plan.overOld).toBe(3000 - VOCAL_GAP_MS);
    expect(plan.overIntro).toBe(3000 - VOCAL_GAP_MS);
    expect(plan.musicAt).toBe(20_000 - plan.overIntro);
    expect(plan.overOld + plan.hold).toBe(plan.musicAt);
  });

  it("plays the next song after the line when its intro is too short to talk over", () => {
    const plan = planTalk({ ...base, speechMs: 6000, next: { first: VOCAL_GAP_MS + MIN_OVER_INTRO_MS - 1, last: 1 } });
    expect(plan.overIntro).toBe(0);
    expect(plan.musicAt).toBe(6000);
  });

  it("assumes the singer starts at once, and a short outro, without lyrics", () => {
    const plan = planTalk({ speechMs: 8000, next: null, old: null, oldLeftMs: 60_000, oldDurationMs: 200_000 });
    expect(plan).toEqual({ overOld: UNKNOWN_OUTRO_MS, hold: 8000 - UNKNOWN_OUTRO_MS, musicAt: 8000, overIntro: 0 });
  });

  it("can't start in the past", () => {
    const plan = planTalk({ speechMs: 8000, next: null, old: null, oldLeftMs: 2000, oldDurationMs: 200_000 });
    expect(plan).toMatchObject({ overOld: 2000, hold: 6000 });
  });

  it("doesn't start over a song for just a moment", () => {
    expect(planTalk({ speechMs: 8000, next: null, old: null, oldLeftMs: MIN_OVER_OUTRO_MS - 1, oldDurationMs: 200_000 })).toMatchObject({
      overOld: 0,
      hold: 8000,
    });
    // Its singer stops 2 s before the end: 1.3 s of room isn't enough.
    const plan = planTalk({ ...base, speechMs: 8000, next: null, old: { first: 0, last: 198_000 } });
    expect(plan).toMatchObject({ overOld: 0, hold: 8000 });
  });

  it("with nothing playing, the line comes first and the song near its end", () => {
    expect(planTalk({ speechMs: 9000, next: { first: 4700, last: 1 }, old: null, oldLeftMs: 0, oldDurationMs: 0 })).toEqual({
      overOld: 0,
      hold: 5000,
      musicAt: 5000,
      overIntro: 4000,
    });
  });

  it("keeps off the next song when talking over beginnings is off", () => {
    const plan = planTalk({ ...base, speechMs: 8000, next: { first: 15_000, last: 1 }, overStart: false });
    expect(plan).toMatchObject({ overIntro: 0, musicAt: 8000, overOld: MAX_OVER_OUTRO_MS, hold: 3000 });
  });

  it("waits for the finishing song when talking over ends is off", () => {
    const plan = planTalk({ ...base, speechMs: 8000, next: { first: 3000, last: 1 }, overEnd: false });
    expect(plan).toMatchObject({ overOld: 0, hold: 8000 - 2300, overIntro: 2300 });
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
