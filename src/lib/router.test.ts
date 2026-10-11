import { beforeEach, describe, expect, it, vi } from "vitest";

let router: typeof import("./router.svelte").router;
let sectionOf: typeof import("./router.svelte").sectionOf;

beforeEach(async () => {
  // The router is a singleton; load a fresh one per test.
  vi.resetModules();
  ({ router, sectionOf } = await import("./router.svelte"));
});

describe("router", () => {
  it("starts at home with no history", () => {
    expect(router.current).toEqual({ name: "home" });
    expect(router.canBack).toBe(false);
    expect(router.canForward).toBe(false);
  });

  it("goes back and forward through history", () => {
    router.go({ name: "liked" });
    router.go({ name: "album", id: "a" });
    expect(router.current).toEqual({ name: "album", id: "a" });

    router.back();
    expect(router.current).toEqual({ name: "liked" });
    expect(router.canForward).toBe(true);

    router.back();
    expect(router.current).toEqual({ name: "home" });
    expect(router.canBack).toBe(false);

    router.forward();
    router.forward();
    expect(router.current).toEqual({ name: "album", id: "a" });
    expect(router.canForward).toBe(false);
  });

  it("ignores back and forward past either end", () => {
    const v = router.version;
    router.back();
    router.forward();
    expect(router.current).toEqual({ name: "home" });
    expect(router.version).toBe(v);
  });

  it("drops forward history when navigating somewhere new", () => {
    router.go({ name: "liked" });
    router.go({ name: "albums" });
    router.back();
    router.go({ name: "artists" });
    expect(router.canForward).toBe(false);
    router.back();
    expect(router.current).toEqual({ name: "liked" });
  });

  it("doesn't push a duplicate of the current route", () => {
    router.go({ name: "album", id: "a" });
    const v = router.version;
    router.go({ name: "album", id: "a" });
    expect(router.version).toBe(v);
    router.back();
    expect(router.current).toEqual({ name: "home" });
  });

  it("treats the same view with a different id as a new route", () => {
    router.go({ name: "album", id: "a" });
    router.go({ name: "album", id: "b" });
    router.back();
    expect(router.current).toEqual({ name: "album", id: "a" });
  });

  it("bumps the version on every navigation", () => {
    const v = router.version;
    router.go({ name: "liked" });
    router.back();
    router.forward();
    expect(router.version).toBe(v + 3);
  });

  it("replaces the current entry without adding history", () => {
    router.go({ name: "search", q: "a" });
    const v = router.version;
    router.replace({ name: "search", q: "ab" });
    expect(router.current).toEqual({ name: "search", q: "ab" });
    expect(router.version).toBe(v);
    router.back();
    expect(router.current).toEqual({ name: "home" });
    router.forward();
    expect(router.current).toEqual({ name: "search", q: "ab" });
  });

  describe("openUri", () => {
    it.each([
      ["spotify:album:abc", { name: "album", id: "abc" }],
      ["spotify:artist:abc", { name: "artist", id: "abc" }],
      ["spotify:playlist:abc", { name: "playlist", id: "abc" }],
      ["spotify:user:someone:collection", { name: "liked" }],
    ])("%s", (uri, route) => {
      router.openUri(uri);
      expect(router.current).toEqual(route);
    });

    it("ignores URIs without a view", () => {
      router.openUri("spotify:track:abc");
      router.openUri("spotify:show:abc");
      expect(router.current).toEqual({ name: "home" });
      expect(router.canBack).toBe(false);
    });
  });

  describe("sections", () => {
    it("opens Settings at the DJ's section, by the element's id", () => {
      expect(sectionOf({ name: "settings", section: "dj" })).toBe("dj-settings");
      expect(sectionOf({ name: "settings" })).toBeNull();
      expect(sectionOf({ name: "dj" })).toBeNull();
    });

    it("goes to a section of the page it's on as a new page", () => {
      router.go({ name: "settings" });
      const v = router.version;
      router.go({ name: "settings", section: "dj" });
      expect(router.version).toBe(v + 1);
      router.back();
      expect(router.current).toEqual({ name: "settings" });
    });
  });
});
