import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let reveal: typeof import("./reveal").reveal;

class FakeObserver {
  static current: FakeObserver | null = null;
  watched = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.current = this;
  }
  observe(el: Element) {
    this.watched.add(el);
  }
  unobserve(el: Element) {
    this.watched.delete(el);
  }
  disconnect() {
    this.watched.clear();
  }
}

async function load({ reduce = false, observer = true } = {}) {
  FakeObserver.current = null;
  vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: reduce }));
  vi.stubGlobal("IntersectionObserver", observer ? FakeObserver : undefined);
  ({ reveal } = await import("./reveal"));
}

/** A list of `n` items, each attached to `reveal`. */
function list(n: number) {
  const ul = document.createElement("ul");
  return Array.from({ length: n }, () => {
    const li = ul.appendChild(document.createElement("li"));
    reveal(li);
    return li;
  });
}

/** Reports items as on screen (or not) at these positions, in one batch. */
function arrive(items: [Element, number, number?][], visible = true) {
  const entries = items.map(([target, top, left = 0]) => ({ target, isIntersecting: visible, boundingClientRect: { top, left } }));
  const observer = FakeObserver.current!;
  observer.callback(entries as unknown as IntersectionObserverEntry[], observer as unknown as IntersectionObserver);
}

const beat = (el: HTMLElement) => el.style.getPropertyValue("--reveal-beat");

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reveal", () => {
  it("keeps items hidden until they scroll into view", async () => {
    await load();
    const items = list(3);
    expect(items.map((el) => el.dataset.reveal)).toEqual(["wait", "wait", "wait"]);
    expect(FakeObserver.current!.watched.size).toBe(3);
  });

  it("pops in what arrives together top to bottom, a beat apart, and stops watching it", async () => {
    await load();
    const [a, b, c] = list(3);
    arrive([[c, 300], [a, 100], [b, 200]]);
    expect([a, b, c].map((el) => el.dataset.reveal)).toEqual(["in", "in", "in"]);
    expect([a, b, c].map(beat)).toEqual(["0", "1", "2"]);
    expect(FakeObserver.current!.watched.size).toBe(0);
  });

  it("takes a row of cards left to right", async () => {
    await load();
    const [a, b, c] = list(3);
    arrive([[c, 50, 400], [a, 50, 0], [b, 50, 200]]);
    expect([a, b, c].map(beat)).toEqual(["0", "1", "2"]);
  });

  it("counts beats per list", async () => {
    await load();
    const [a, b] = list(2);
    const [x, y] = list(2);
    arrive([[a, 10], [x, 20], [b, 30], [y, 40]]);
    expect([a, b, x, y].map(beat)).toEqual(["0", "1", "0", "1"]);
  });

  it("caps the beat so a long jump doesn't crawl in", async () => {
    await load();
    const items = list(15);
    arrive(items.map((el, i) => [el, i * 56] as [Element, number]));
    expect(beat(items[9])).toBe("9");
    expect(beat(items[14])).toBe("10");
  });

  it("leaves items that are still off screen waiting", async () => {
    await load();
    const [a] = list(1);
    arrive([[a, 2000]], false);
    expect(a.dataset.reveal).toBe("wait");
    expect(FakeObserver.current!.watched.has(a)).toBe(true);
  });

  it("stops watching an item that goes away", async () => {
    await load();
    const li = document.createElement("li");
    const cleanup = reveal(li);
    expect(FakeObserver.current!.watched.has(li)).toBe(true);
    if (cleanup) cleanup();
    expect(FakeObserver.current!.watched.has(li)).toBe(false);
  });

  it("leaves items alone with reduced motion", async () => {
    await load({ reduce: true });
    const [a] = list(1);
    expect(a.dataset.reveal).toBeUndefined();
    expect(FakeObserver.current).toBeNull();
  });

  it("leaves items alone without IntersectionObserver", async () => {
    await load({ observer: false });
    const [a] = list(1);
    expect(a.dataset.reveal).toBeUndefined();
  });
});
