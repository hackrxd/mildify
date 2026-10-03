import { describe, expect, it } from "vitest";
import { HOLD_GAP_MS, lineAt, lyricLines, lyricsText, nextChange, sung, VERSE_GAP_MS, type LyricLine } from "./lyricLines";

const syl = (Text: string, StartTime: number, EndTime: number, IsPartOfWord = false) => ({
  Text,
  StartTime,
  EndTime,
  IsPartOfWord,
});

describe("lyricLines", () => {
  it("joins syllables into words and keeps their timing, in ms", () => {
    const response = {
      Body: {
        Type: "Syllable",
        Content: [
          {
            Type: "Vocal",
            Lead: {
              StartTime: 2,
              EndTime: 4.5,
              Syllables: [syl("Pa", 2, 2.5, true), syl("per", 2.5, 3), syl("lan", 3, 3.5, true), syl("terns", 3.5, 4.5)],
            },
            Background: [{ Syllables: [syl("ooh", 2, 4)] }],
          },
        ],
      },
    };
    expect(lyricLines(response)).toEqual([
      {
        start: 2000,
        end: 4500,
        text: "Paper lanterns",
        syllables: [
          { start: 2000, end: 2500, text: "Pa", partOfWord: true },
          { start: 2500, end: 3000, text: "per", partOfWord: false },
          { start: 3000, end: 3500, text: "lan", partOfWord: true },
          { start: 3500, end: 4500, text: "terns", partOfWord: false },
        ],
      },
    ]);
  });

  it("drops empty and untimed syllables", () => {
    const body = {
      Type: "Syllable",
      Content: [{ Lead: { StartTime: 1, EndTime: 3, Syllables: [syl("\u200B", 1, 2), { Text: "no time" }, syl("kept", 2, 3)] } }],
    };
    expect(lyricLines(body)[0]).toMatchObject({ text: "kept", syllables: [{ text: "kept" }] });
  });

  it("gives line-synced lines no syllables", () => {
    expect(lyricLines({ Type: "Line", Content: [{ Text: "a", StartTime: 1, EndTime: 2 }] })[0].syllables).toBeUndefined();
  });

  it("reads line-synced lyrics, with or without the Body wrapper", () => {
    const body = {
      Type: "Line",
      Content: [
        { Type: "Vocal", Text: "second", StartTime: 5, EndTime: 7 },
        { Type: "Vocal", Text: "  first\u200B  line ", StartTime: 1, EndTime: 3 },
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
        { Text: "\u200B ", StartTime: 1, EndTime: 2 },
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

describe("sung", () => {
  const s = { start: 1000, end: 2000, text: "la", partOfWord: false };

  it.each([
    [0, 0],
    [1000, 0],
    [1250, 0.25],
    [1500, 0.5],
    [2000, 1],
    [5000, 1],
  ])("at %i ms → %d", (ms, part) => {
    expect(sung(s, ms)).toBe(part);
  });

  it("treats a zero-length syllable as sung once it starts", () => {
    expect(sung({ ...s, end: 1000 }, 999)).toBe(0);
    expect(sung({ ...s, end: 1000 }, 1000)).toBe(1);
  });
});

describe("lyricsText", () => {
  it("writes static lyrics one line per row, empty lines as single verse breaks", () => {
    const response = {
      Body: {
        Type: "Static",
        Lines: [{ Text: "" }, { Text: "Paper  lanterns" }, { Text: "drift" }, { Text: "" }, { Text: "​" }, { Text: "harbor" }, { Text: "" }],
      },
    };
    expect(lyricsText(response)).toBe("Paper lanterns\ndrift\n\nharbor");
  });

  it("orders line-synced lyrics and breaks verses at long pauses", () => {
    const response = {
      Type: "Line",
      Content: [
        { StartTime: 10, EndTime: 12, Text: "third" },
        { StartTime: 0, EndTime: 2, Text: "first" },
        { StartTime: 2.5, EndTime: 5, Text: "second" },
        { StartTime: 13, EndTime: 14, Text: "   " },
      ],
    };
    expect(lyricsText(response)).toBe("first\nsecond\n\nthird");
  });

  it("keeps a pause just under the verse gap in the same verse", () => {
    const gap = VERSE_GAP_MS / 1000 - 0.01;
    const response = {
      Type: "Line",
      Content: [
        { StartTime: 0, EndTime: 1, Text: "a" },
        { StartTime: 1 + gap, EndTime: 3 + gap, Text: "b" },
      ],
    };
    expect(lyricsText(response)).toBe("a\nb");
  });

  it("joins syllables into words and puts background vocals in parentheses", () => {
    const response = {
      Body: {
        Type: "Syllable",
        Content: [
          {
            Lead: { StartTime: 2, EndTime: 4, Syllables: [syl("Pa", 2, 2.5, true), syl("per", 2.5, 3), syl("lanterns", 3, 4)] },
            Background: [{ Syllables: [syl("ooh", 2, 3)] }, { Syllables: [syl("ah", 3, 4)] }],
          },
          { Lead: { StartTime: 4.5, EndTime: 5, Syllables: [] }, Background: [{ Syllables: [syl("hey", 4.5, 5)] }] },
        ],
      },
    };
    expect(lyricsText(response)).toBe("Paper lanterns (ooh ah)\n(hey)");
  });

  it("uses the romanization when asked and present, the original otherwise", () => {
    const response = {
      Type: "Static",
      Lines: [{ Text: "夜空", TransliteratedText: "yozora" }, { Text: "and you" }, { Text: "", TransliteratedText: "only roman" }],
    };
    expect(lyricsText(response, true)).toBe("yozora\nand you\nonly roman");
    expect(lyricsText(response)).toBe("夜空\nand you\nonly roman");
  });

  it("is empty for missing or unknown lyrics", () => {
    expect(lyricsText(null)).toBe("");
    expect(lyricsText({ Body: { Type: "Mystery", Content: [] } })).toBe("");
  });
});
