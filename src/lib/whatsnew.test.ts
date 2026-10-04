import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../CHANGELOG.md?raw", () => ({
  default: [
    "## Unreleased",
    "- Coming",
    "## 1.3.0 - 2026-10-06",
    "- Ahead of this build",
    "## 1.2.0 - 2026-10-05",
    "- Newest",
    "## 1.1.0 - 2026-10-04",
    "- Middle",
    "## 1.0.0 - 2026-10-03",
    "- Oldest",
  ].join("\n"),
}));

let whatsNew: typeof import("./whatsnew.svelte").whatsNew;
let router: typeof import("./router.svelte").router;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("__APP_VERSION__", "1.2.0");
  vi.stubEnv("DEV", false);
  localStorage.clear();
});

async function start() {
  ({ whatsNew } = await import("./whatsnew.svelte"));
  ({ router } = await import("./router.svelte"));
  whatsNew.start();
}

describe("after an update", () => {
  it("offers every release since the last version seen, once", async () => {
    localStorage.setItem("nativify:seenVersion", "1.0.0");
    await start();
    expect(whatsNew.banner).toBe(true);
    expect(whatsNew.releases.filter((r) => whatsNew.isNew(r)).map((r) => r.version)).toEqual(["1.2.0", "1.1.0"]);
    expect(localStorage.getItem("nativify:seenVersion")).toBe("1.2.0");

    vi.resetModules();
    await start();
    expect(whatsNew.banner).toBe(false);
  });

  it("opens the page and puts the banner away", async () => {
    localStorage.setItem("nativify:seenVersion", "1.1.0");
    await start();
    whatsNew.open();
    expect(whatsNew.banner).toBe(false);
    expect(router.current).toEqual({ name: "changelog" });
  });

  it("counts an install from before the page as the previous release", async () => {
    localStorage.setItem("nativify:audioFx", "true");
    await start();
    expect(whatsNew.since).toBe("1.1.0");
    expect(whatsNew.banner).toBe(true);
  });
});

describe("no banner", () => {
  it("on a fresh install", async () => {
    await start();
    expect(whatsNew.banner).toBe(false);
    expect(localStorage.getItem("nativify:seenVersion")).toBe("1.2.0");
  });

  it("on the same version, or going back to an older one", async () => {
    for (const seen of ["1.2.0", "1.3.0"]) {
      vi.resetModules();
      localStorage.setItem("nativify:seenVersion", seen);
      await start();
      expect(whatsNew.banner).toBe(false);
    }
  });
});

it("lists released versions up to this build, newest first", async () => {
  await start();
  expect(whatsNew.releases.map((r) => r.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
});
