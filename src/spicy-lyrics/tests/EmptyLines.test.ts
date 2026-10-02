// Native Spotify's tests for the vendored renderer; not part of upstream.
import { describe, expect, it } from "vitest";
import {
  HasLyricsText,
  HasRenderableText,
  IsEmptyLyrics,
  IsEmptyLyricsLine,
  RemoveEmptyLyricsLines,
  StripEmptyLyricsLines,
} from "../src/utils/Lyrics/EmptyLines.ts";
import { PickDisplayText } from "../src/utils/Lyrics/Applyer/Utils/PickDisplayText.ts";
import { StripZeroWidth } from "../src/utils/Lyrics/Applyer/Utils/StripZeroWidth.ts";

const syl = (Text: string, TransliteratedText?: string) => ({ Text, TransliteratedText });

describe("StripZeroWidth", () => {
  it("removes invisible characters", () => {
    expect(StripZeroWidth("a​b‎‏c⁠d﻿")).toBe("abcd");
  });

  it("keeps ZWJ and ZWNJ, which change how scripts and emoji render", () => {
    expect(StripZeroWidth("می‌خواهم")).toBe("می‌خواهم");
    expect(StripZeroWidth("👩‍💻")).toBe("👩‍💻");
  });
});

describe("HasLyricsText", () => {
  it.each(["la", " la ", "♪"])("%j has text", (t) => {
    expect(HasLyricsText(t)).toBe(true);
  });

  it.each(["", "   ", "​", " ﻿​ ", undefined, null, 3])("%j has none", (t) => {
    expect(HasLyricsText(t)).toBe(false);
  });
});

describe("HasRenderableText", () => {
  it("accepts text in either the original or the romanization", () => {
    expect(HasRenderableText(syl("a"))).toBe(true);
    expect(HasRenderableText(syl("", "a"))).toBe(true);
    expect(HasRenderableText(syl("", " "))).toBe(false);
    expect(HasRenderableText(null)).toBe(false);
  });
});

describe("IsEmptyLyricsLine", () => {
  it("judges line-synced and static lines by their text", () => {
    expect(IsEmptyLyricsLine({ Text: "hello" })).toBe(false);
    expect(IsEmptyLyricsLine({ Text: "" })).toBe(true);
    expect(IsEmptyLyricsLine({ Text: "", TransliteratedText: "konnichiwa" })).toBe(false);
  });

  it("judges syllable lines by their lead and background vocals", () => {
    expect(IsEmptyLyricsLine({ Lead: { Syllables: [syl("la")] } })).toBe(false);
    expect(IsEmptyLyricsLine({ Lead: { Syllables: [syl(""), syl("​")] } })).toBe(true);
    expect(IsEmptyLyricsLine({ Lead: { Syllables: [] }, Background: [{ Syllables: [syl("ooh")] }] })).toBe(false);
    expect(IsEmptyLyricsLine({ Lead: { Syllables: [] }, Background: [{ Syllables: [syl(" ")] }] })).toBe(true);
    expect(IsEmptyLyricsLine({ Lead: undefined, Background: [] })).toBe(true);
  });
});

describe("RemoveEmptyLyricsLines", () => {
  it("keeps only lines with text, in order", () => {
    expect(RemoveEmptyLyricsLines([{ Text: "a" }, { Text: "" }, { Text: "b" }])).toEqual([{ Text: "a" }, { Text: "b" }]);
  });

  it("returns an empty list for anything that isn't a list", () => {
    expect(RemoveEmptyLyricsLines(undefined)).toEqual([]);
    expect(RemoveEmptyLyricsLines(null)).toEqual([]);
  });
});

describe("StripEmptyLyricsLines", () => {
  it("prunes empty lines from line-synced lyrics", () => {
    const lyrics = { Type: "Line", Content: [{ Text: "a" }, { Text: " " }] };
    StripEmptyLyricsLines(lyrics);
    expect(lyrics.Content).toEqual([{ Text: "a" }]);
  });

  it("prunes empty syllables and background groups from syllable-synced lyrics", () => {
    const lyrics: any = {
      Type: "Syllable",
      Content: [
        {
          Lead: { Syllables: [syl("la"), syl("​"), syl("la")] },
          Background: [{ Syllables: [syl("")] }, { Syllables: [syl("ooh"), syl(" ")] }],
        },
        { Lead: { Syllables: [syl("hey")] }, Background: [{ Syllables: [syl("")] }] },
        { Lead: { Syllables: [syl("")] } },
      ],
    };
    StripEmptyLyricsLines(lyrics);
    expect(lyrics.Content).toEqual([
      {
        Lead: { Syllables: [syl("la"), syl("la")] },
        Background: [{ Syllables: [syl("ooh")] }],
      },
      { Lead: { Syllables: [syl("hey")] } },
    ]);
  });

  it("prunes static lyrics", () => {
    const lyrics = { Type: "Static", Lines: [{ Text: "a" }, { Text: "" }] };
    StripEmptyLyricsLines(lyrics);
    expect(lyrics.Lines).toEqual([{ Text: "a" }]);
  });

  it("ignores things that aren't lyrics", () => {
    expect(() => StripEmptyLyricsLines(null)).not.toThrow();
    expect(() => StripEmptyLyricsLines("x")).not.toThrow();
  });
});

describe("IsEmptyLyrics", () => {
  it("is empty when pruning left nothing", () => {
    expect(IsEmptyLyrics({ Content: [] })).toBe(true);
    expect(IsEmptyLyrics({ Lines: [] })).toBe(true);
    expect(IsEmptyLyrics(null)).toBe(true);
  });

  it("isn't empty with lines left", () => {
    expect(IsEmptyLyrics({ Content: [{ Text: "a" }] })).toBe(false);
    expect(IsEmptyLyrics({ Lines: [{ Text: "a" }], Content: [] })).toBe(false);
  });

  it("leaves shapes it doesn't recognise alone", () => {
    expect(IsEmptyLyrics({ Something: "else" })).toBe(false);
  });
});

describe("PickDisplayText", () => {
  it("shows the romanization only when asked and present", () => {
    expect(PickDisplayText(syl("こんにちは", "konnichiwa"), true)).toBe("konnichiwa");
    expect(PickDisplayText(syl("こんにちは", "konnichiwa"), false)).toBe("こんにちは");
    expect(PickDisplayText(syl("hello"), true)).toBe("hello");
  });

  it("falls back to the romanization when the original is blank", () => {
    expect(PickDisplayText(syl("", "konnichiwa"), false)).toBe("konnichiwa");
    expect(PickDisplayText(syl("​", "konnichiwa"), false)).toBe("konnichiwa");
  });

  it("never returns undefined", () => {
    expect(PickDisplayText({}, false)).toBe("");
    expect(PickDisplayText(null, true)).toBe("");
  });
});
