// Mildify's tests for the vendored renderer; not part of upstream.
import { describe, expect, it } from "vitest";
import isRtl from "../src/utils/Lyrics/isRtl.ts";

describe("isRtl", () => {
  it.each([
    ["שלום עולם", true],
    ["مرحبا بالعالم", true],
    ["سلام دنیا", true],
    ["Hello world", false],
    ["こんにちは", false],
    ["", false],
  ])("%j → %s", (text, rtl) => {
    expect(isRtl(text)).toBe(rtl);
  });

  it("decides by the first strongly directional character", () => {
    expect(isRtl("Hello שלום")).toBe(false);
    expect(isRtl("שלום Hello")).toBe(true);
  });

  it("skips leading digits, spaces and punctuation", () => {
    expect(isRtl("  (1, 2...) \"שלום\"")).toBe(true);
    expect(isRtl("123 - Hello")).toBe(false);
  });

  it("defaults to left-to-right without any letters", () => {
    expect(isRtl("123 !?")).toBe(false);
  });
});
