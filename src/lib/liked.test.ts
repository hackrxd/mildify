import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sp from "./spotify";
import { toasts } from "./toasts.svelte";

vi.mock("./spotify", () => ({
  libraryContains: vi.fn(),
  saveToLibrary: vi.fn(),
  removeFromLibrary: vi.fn(),
}));
vi.mock("./toasts.svelte", () => ({ toasts: { show: vi.fn(), error: vi.fn() } }));

const contains = vi.mocked(sp.libraryContains);
const save = vi.mocked(sp.saveToLibrary);
const remove = vi.mocked(sp.removeFromLibrary);

let liked: typeof import("./liked.svelte").liked;

const uris = (n: number, prefix = "spotify:track:") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  ({ liked } = await import("./liked.svelte"));
  contains.mockReset().mockImplementation(async (u) => u.map((x) => x.endsWith("1")));
  save.mockReset().mockResolvedValue(null);
  remove.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensure", () => {
  it("is unknown until the lookup lands", async () => {
    liked.ensure(["spotify:track:1"]);
    expect(liked.has("spotify:track:1")).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(liked.has("spotify:track:1")).toBe(true);
  });

  it("coalesces calls made close together into one lookup", async () => {
    liked.ensure(["spotify:track:1"]);
    liked.ensure(["spotify:track:2", "spotify:track:1"]);
    await vi.runAllTimersAsync();
    expect(contains).toHaveBeenCalledOnce();
    expect(contains).toHaveBeenCalledWith(["spotify:track:1", "spotify:track:2"]);
    expect(liked.has("spotify:track:2")).toBe(false);
  });

  it("asks about at most 40 URIs per call (the unified endpoint's cap)", async () => {
    liked.ensure(uris(95));
    await vi.runAllTimersAsync();
    expect(contains.mock.calls.map(([u]) => u.length)).toEqual([40, 40, 15]);
    expect(contains.mock.calls.flatMap(([u]) => u)).toEqual(uris(95));
    expect(liked.has("spotify:track:91")).toBe(true);
  });

  it("doesn't look up URIs it already knows, or empty ones", async () => {
    liked.mark(["spotify:track:1"], false);
    liked.ensure(["spotify:track:1", ""]);
    await vi.runAllTimersAsync();
    expect(contains).not.toHaveBeenCalled();
    expect(liked.has("spotify:track:1")).toBe(false);
  });

  it("leaves a batch unknown when its lookup fails, and still does the rest", async () => {
    contains.mockRejectedValueOnce(new Error("429"));
    liked.ensure(uris(41));
    await vi.runAllTimersAsync();
    expect(liked.has("spotify:track:1")).toBeUndefined();
    expect(liked.has("spotify:track:40")).toBe(false);
  });
});

describe("toggle", () => {
  it("saves an unsaved item", async () => {
    liked.mark(["spotify:track:a"], false);
    await liked.toggle("spotify:track:a");
    expect(save).toHaveBeenCalledWith(["spotify:track:a"]);
    expect(liked.has("spotify:track:a")).toBe(true);
    expect(toasts.show).toHaveBeenCalledWith("Saved to your library");
  });

  it("removes a saved item", async () => {
    liked.mark(["spotify:track:a"], true);
    await liked.toggle("spotify:track:a");
    expect(remove).toHaveBeenCalledWith(["spotify:track:a"]);
    expect(liked.has("spotify:track:a")).toBe(false);
  });

  it("updates optimistically and rolls back on failure", async () => {
    liked.mark(["spotify:track:a"], false);
    let fail!: (e: unknown) => void;
    save.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const done = liked.toggle("spotify:track:a");
    expect(liked.has("spotify:track:a")).toBe(true);
    fail(new Error("offline"));
    await done;
    expect(liked.has("spotify:track:a")).toBe(false);
    expect(toasts.error).toHaveBeenCalled();
  });
});
