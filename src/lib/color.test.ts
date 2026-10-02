import { describe, expect, it } from "vitest";
import { coverColor, dominant } from "./color";

/** RGBA pixel data: `count` pixels of each colour. */
function pixels(...runs: [rgb: [number, number, number], count: number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [[r, g, b], count] of runs) {
    for (let i = 0; i < count; i++) out.push(r, g, b, 255);
  }
  return new Uint8ClampedArray(out);
}

function hsl(s: string): [number, number, number] {
  const m = s.match(/^hsl\((\d+) (\d+)% (\d+)%\)$/);
  if (!m) throw new Error(`not an hsl() colour: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe("dominant", () => {
  it.each([
    ["red", [255, 0, 0], 0],
    ["green", [0, 255, 0], 120],
    ["blue", [0, 0, 255], 240],
  ] as const)("keeps the hue of a solid %s cover", (_, rgb, hue) => {
    expect(hsl(dominant(pixels([[...rgb], 16])))[0]).toBe(hue);
  });

  it("caps saturation and lightness so the colour works behind light text", () => {
    expect(dominant(pixels([[255, 0, 0], 16]))).toBe("hsl(0 65% 42%)");
  });

  it("keeps very dark covers from going black", () => {
    expect(dominant(pixels([[0, 0, 0], 16]))).toBe("hsl(0 0% 22%)");
  });

  it("keeps very light covers from going white", () => {
    expect(dominant(pixels([[255, 255, 255], 16]))).toBe("hsl(0 0% 42%)");
  });

  it("lets a small vivid detail outweigh a sea of grey", () => {
    const [hue, sat] = hsl(dominant(pixels([[128, 128, 128], 90], [[0, 0, 255], 10])));
    expect(hue).toBe(240);
    // A plain average of the same pixels would be about 12% saturated.
    expect(sat).toBeGreaterThanOrEqual(50);
  });
});

describe("coverColor", () => {
  it("resolves null without a URL", async () => {
    expect(await coverColor(null)).toBeNull();
    expect(await coverColor(undefined)).toBeNull();
    expect(await coverColor("")).toBeNull();
  });

  it("samples each URL once", () => {
    expect(coverColor("https://i.scdn.co/image/a")).toBe(coverColor("https://i.scdn.co/image/a"));
    expect(coverColor("https://i.scdn.co/image/a")).not.toBe(coverColor("https://i.scdn.co/image/b"));
  });
});
