import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let toasts: typeof import("./toasts.svelte").toasts;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  ({ toasts } = await import("./toasts.svelte"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toasts", () => {
  it("shows a toast and dismisses it after its timeout", () => {
    toasts.show("Added to queue");
    expect(toasts.items).toMatchObject([{ message: "Added to queue", tone: "info" }]);
    vi.advanceTimersByTime(3999);
    expect(toasts.items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts.items).toHaveLength(0);
  });

  it("replaces an identical message instead of stacking it", () => {
    toasts.show("Added to queue");
    toasts.show("Saved to your library");
    toasts.show("Added to queue");
    expect(toasts.items.map((t) => t.message)).toEqual(["Saved to your library", "Added to queue"]);
  });

  it("keeps the replacement's own timeout", () => {
    toasts.show("Added to queue");
    vi.advanceTimersByTime(3000);
    toasts.show("Added to queue");
    // The first toast's timer fires now, but it only dismisses the toast it made.
    vi.advanceTimersByTime(1000);
    expect(toasts.items).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(toasts.items).toHaveLength(0);
  });

  it("shows errors longer, with the error's message", () => {
    toasts.error({ kind: "api", message: "Not found", status: 404 });
    expect(toasts.items).toMatchObject([{ message: "Not found", tone: "error" }]);
    vi.advanceTimersByTime(4000);
    expect(toasts.items).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(toasts.items).toHaveLength(0);
  });

  it("dismisses a toast by id", () => {
    toasts.show("a");
    toasts.show("b");
    toasts.dismiss(toasts.items[0].id);
    expect(toasts.items.map((t) => t.message)).toEqual(["b"]);
  });
});
