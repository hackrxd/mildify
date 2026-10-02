import { describe, expect, it } from "vitest";
import { HOLD_GAP_MS, lineAt, lyricLines, nextChange, type LyricLine } from "./lyricLines";

const syl = (Text: string, IsPartOfWord = false) => ({ Text, StartTime: 0, EndTime: 0, IsPartOfWord });

describe("lyricLines", () => {
  it("joins syllables into words and converts seconds to ms", () => {
    const response = {
      Body: {
        Type: "Syllable",
        Content: [
          {
            Type: "Vocal",
            Lead: { StartTime: 2, EndTime: 4.5, Syllables: [syl("Pa", true), syl("per"), syl("lan", true), syl("terns")] },
            Background: [{ Syllables: [syl("ooh")] }],
          },
        ],
      },
    };
    expect(lyricLines(response)).toEqual([{ start: 2000, end: 4500, text: "Paper lanterns" }]);
  });

  it("reads line-synced lyrics, with or without the Body wrapper", () => {
    const body = {
      Type: "Line",
      Content: [
        { Type: "Vocal", Text: "second", StartTime: 5, EndTime: 7 },
        { Type: "Vocal", Text: "  first​  line ", StartTime: 1, EndTime: 3 },
      ],
    };
    const expected = [
      { start: 1000, end: 3000, text: "first line" },
      { start: 5000, end: 7000, text: "second" },
    ];
    expect(lyricLines(body)).toEqual(expected);
    expect(lyricLines({ Body: body })).toEqual(expected);
  });

  it("drops empty and untimed lines", () => {
    const body = {
      Type: "Line",
      Content: [
        { Text: "​ ", StartTime: 1, EndTime: 2 },
        { Text: "no time" },
        { Text: "kept", StartTime: 3, EndTime: 4 },
      ],
    };
    expect(lyricLines(body).map((l) => l.text)).toEqual(["kept"]);
  });

  it("gives nothing for static lyrics, nulls and unknown shapes", () => {
    expect(lyricLines({ Body: { Type: "Static", Lines: [{ Text: "a" }] } })).toEqual([]);
    expect(lyricLines(null)).toEqual([]);
    expect(lyricLines({ Body: null })).toEqual([]);
    expect(lyricLines({ Body: { Type: "Other", Content: [{ Text: "a", StartTime: 1, EndTime: 2 }] } })).toEqual([]);
  });
});

describe("lineAt", () => {
  const lines: LyricLine[] = [
    { start: 1000, end: 2000, text: "a" },
    // Short gap after "a": it holds until "b".
    { start: 2500, end: 4000, text: "b" },
    // Long gap after "b": it goes away at its end.
    { start: 4000 + HOLD_GAP_MS + 1000, end: 9000, text: "c" },
  ];

  it.each([
    [0, -1],
    [999, -1],
    [1000, 0],
    [2200, 0],
    [2500, 1],
    [3999, 1],
    [4000, -1],
    [8000, 2],
    [8999, 2],
    [9000, -1],
    [60_000, -1],
  ])("at %i ms → %i", (ms, index) => {
    expect(lineAt(lines, ms)).toBe(index);
  });

  it("is -1 with no lines", () => {
    expect(lineAt([], 1000)).toBe(-1);
  });
});

describe("nextChange", () => {
  const lines: LyricLine[] = [
    { start: 1000, end: 2000, text: "a" },
    { start: 2500, end: 4000, text: "b" },
    { start: 10_000, end: 11_000, text: "c" },
  ];

  it.each([
    [0, 1000],
    [1500, 2500],
    [3000, 4000],
    [5000, 10_000],
    [10_500, 11_000],
    [12_000, Infinity],
  ])("at %i ms → %d", (ms, at) => {
    expect(nextChange(lines, ms)).toBe(at);
  });
});
