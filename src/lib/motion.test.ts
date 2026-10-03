import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let motion: typeof import("./motion");

function prefersReduced(reduce: boolean) {
  vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: reduce && media.includes("reduce") }));
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const node = () => document.createElement("span");

describe("motion", () => {
  it("pops from small to full size, overshooting on the way", async () => {
    prefersReduced(false);
    motion = await import("./motion");
    const t = motion.pop(node());
    expect(t.duration).toBeGreaterThan(0);
    expect(t.css!(0, 1)).toBe("transform: scale(0.4); opacity: 0");
    expect(t.css!(1, 0)).toBe("transform: scale(1); opacity: 1");
    expect(t.easing!(0.6)).toBeGreaterThan(1);
  });

  it("rises into place and grows from the given scale", async () => {
    prefersReduced(false);
    motion = await import("./motion");
    const t = motion.rise(node(), { y: 6, scale: 0.9, delay: 40 });
    expect(t.delay).toBe(40);
    expect(t.css!(0, 1)).toBe("transform: translateY(6px) scale(0.9); opacity: 0");
    expect(t.css!(1, 0)).toBe("transform: translateY(0px) scale(1); opacity: 1");
  });

  it("skips both when the system asks for reduced motion", async () => {
    prefersReduced(true);
    motion = await import("./motion");
    expect(motion.reducedMotion()).toBe(true);
    expect(motion.pop(node())).toEqual({ duration: 0 });
    expect(motion.rise(node())).toEqual({ duration: 0 });
  });

  it("animates where matchMedia is missing", async () => {
    vi.stubGlobal("matchMedia", undefined);
    motion = await import("./motion");
    expect(motion.reducedMotion()).toBe(false);
    expect(motion.pop(node()).duration).toBeGreaterThan(0);
  });
});
