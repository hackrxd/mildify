import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModInfo, ModList } from "./ipc";
import type { ExtensionApi } from "./mods.svelte";

const listMods = vi.fn<() => Promise<ModList>>();
const show = vi.fn();

vi.mock("./ipc", () => ({
  backend: { listMods: () => listMods(), openModsFolder: vi.fn() },
  api: vi.fn(),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("./toasts.svelte", () => ({ toasts: { show: (...a: unknown[]) => show(...a), error: vi.fn() } }));
vi.mock("./player.svelte", () => ({ player: { name: "player" } }));
vi.mock("./router.svelte", () => ({ router: { name: "router" } }));
vi.mock("./session.svelte", () => ({ session: { name: "session" } }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "9.9.9" }));

let mods: typeof import("./mods.svelte").mods;
let modUrl: typeof import("./mods.svelte").modUrl;

const mod = (id: string, modified = 1, entry = id): ModInfo => ({
  id,
  entry,
  name: id.replace(/\.m?js$|\.css$/, ""),
  description: null,
  author: null,
  version: null,
  modified,
});

let list: ModList;
/** Extension modules by id, as `importer` returns them. */
let modules: Record<string, Record<string, unknown>>;
let imported: string[];

const themeLink = () => document.querySelector<HTMLLinkElement>("link[data-nativify-theme]");
const quickCss = () => document.querySelector<HTMLStyleElement>("style[data-nativify-quick-css]");

/** Window listeners each fresh `mods` adds, removed after the test so old instances stay quiet. */
let listeners: [string, EventListenerOrEventListenerObject][] = [];

async function boot() {
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, fn, opts) => {
    listeners.push([type, fn]);
    add(type, fn, opts);
  });
  vi.resetModules();
  ({ mods, modUrl } = await import("./mods.svelte"));
  mods.importer = async (url) => {
    imported.push(url);
    const id = decodeURIComponent(url.split("/extensions/")[1].split("/")[1]);
    const m = modules[id];
    if (!m) throw new Error(`no module ${id}`);
    return m;
  };
  await mods.init();
}

beforeEach(() => {
  localStorage.clear();
  document.head.replaceChildren();
  document.body.replaceChildren();
  list = {
    themes_dir: "/cfg/themes",
    extensions_dir: "/cfg/extensions",
    base_url: "nsmod://localhost/",
    safe_mode: false,
    themes: [mod("Glass", 5, "Glass/theme.css"), mod("plain.css", 7)],
    extensions: [],
  };
  listMods.mockReset().mockImplementation(async () => structuredClone(list));
  show.mockReset();
  modules = {};
  imported = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [type, fn] of listeners) window.removeEventListener(type, fn);
  listeners = [];
});

describe("modUrl", () => {
  it("encodes each path segment and keeps the slashes", async () => {
    await boot();
    expect(modUrl("nsmod://localhost/", "themes", "My Theme/theme #1.css", 42)).toBe(
      "nsmod://localhost/themes/42/My%20Theme/theme%20%231.css",
    );
    expect(modUrl("http://nsmod.localhost/", "extensions", "a.js", "1x")).toBe("http://nsmod.localhost/extensions/1x/a.js");
  });

  it("versions the files an entry imports relatively, too", async () => {
    await boot();
    const entry = modUrl("http://nsmod.localhost/", "extensions", "rp/index.js", 7);
    expect(new URL("./format.js", entry).href).toBe("http://nsmod.localhost/extensions/7/rp/format.js");
    const edited = modUrl("http://nsmod.localhost/", "extensions", "rp/index.js", 8);
    expect(new URL("./format.js", edited).href).not.toBe(new URL("./format.js", entry).href);
  });
});

describe("theme", () => {
  it("applies the saved theme on start, after the app's stylesheets", async () => {
    localStorage.setItem("nativify:theme", "Glass");
    await boot();
    expect(themeLink()?.getAttribute("href")).toBe("nsmod://localhost/themes/5/Glass/theme.css");
    expect(themeLink()?.parentElement).toBe(document.body);
    expect(mods.activeTheme?.id).toBe("Glass");
  });

  it("switches, persists and goes back to the default", async () => {
    await boot();
    expect(themeLink()).toBeNull();
    mods.setTheme("plain.css");
    expect(themeLink()?.getAttribute("href")).toBe("nsmod://localhost/themes/7/plain.css");
    expect(localStorage.getItem("nativify:theme")).toBe("plain.css");
    mods.setTheme(null);
    expect(themeLink()).toBeNull();
    expect(localStorage.getItem("nativify:theme")).toBeNull();
  });

  it("reloads an edited theme when the window regains focus", async () => {
    localStorage.setItem("nativify:theme", "Glass");
    await boot();
    const link = themeLink();
    list.themes[0].modified = 6;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(themeLink()?.getAttribute("href")).toContain("/themes/6/"));
    expect(themeLink()).toBe(link);
  });

  it("drops a theme whose files were removed", async () => {
    localStorage.setItem("nativify:theme", "Glass");
    await boot();
    list.themes = [];
    await mods.refresh();
    expect(themeLink()).toBeNull();
    expect(mods.theme).toBe("Glass");
  });

  it("a forced reload busts the cache even if the entry didn't change", async () => {
    localStorage.setItem("nativify:theme", "Glass");
    await boot();
    const before = themeLink()?.getAttribute("href");
    await mods.refresh(true);
    expect(themeLink()?.getAttribute("href")).not.toBe(before);
    expect(themeLink()?.getAttribute("href")).toMatch(/^nsmod:\/\/localhost\/themes\/5\d+\/Glass\/theme\.css$/);
  });

  it("isn't applied in safe mode", async () => {
    localStorage.setItem("nativify:theme", "Glass");
    list.safe_mode = true;
    await boot();
    expect(themeLink()).toBeNull();
    expect(mods.safeMode).toBe(true);
  });
});

describe("quick CSS", () => {
  it("applies as typed, after the theme, and persists", async () => {
    localStorage.setItem("nativify:theme", "Glass");
    await boot();
    mods.setQuickCss(":root { --brass: blue; }");
    expect(quickCss()?.textContent).toBe(":root { --brass: blue; }");
    expect(themeLink()?.compareDocumentPosition(quickCss()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(localStorage.getItem("nativify:quickCss")).toBe(":root { --brass: blue; }");

    // A theme picked later still goes before it.
    mods.setTheme("plain.css");
    expect(themeLink()?.compareDocumentPosition(quickCss()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    mods.setQuickCss("  ");
    expect(quickCss()).toBeNull();
    expect(localStorage.getItem("nativify:quickCss")).toBeNull();
  });

  it("isn't applied in safe mode", async () => {
    localStorage.setItem("nativify:quickCss", "* { display: none }");
    list.safe_mode = true;
    await boot();
    expect(quickCss()).toBeNull();
    mods.setQuickCss("body { color: red }");
    expect(quickCss()).toBeNull();
    expect(localStorage.getItem("nativify:quickCss")).toBe("body { color: red }");
  });

  it("still applies when the mods folders can't be listed", async () => {
    localStorage.setItem("nativify:quickCss", "body { color: red }");
    listMods.mockRejectedValue(new Error("io"));
    await boot();
    expect(quickCss()?.textContent).toBe("body { color: red }");
  });

  it("is restored on start", async () => {
    localStorage.setItem("nativify:quickCss", "body { color: red }");
    await boot();
    expect(quickCss()?.textContent).toBe("body { color: red }");
  });
});

describe("extensions", () => {
  /** An extension that registers one of everything and records what happens to it. */
  function recording(log: string[]) {
    return {
      default: vi.fn((ns: ExtensionApi) => {
        log.push(`start ${ns.extension.id}`);
        ns.addStyle(".x { color: red }");
        ns.addPage({ id: "stats", label: "Stats", render: () => {} });
        ns.addTrackMenuItem({ label: "Share", action: () => log.push("share") });
        ns.onUnload(() => log.push("onUnload"));
        return () => log.push("returned cleanup");
      }),
    };
  }

  it("start only when enabled, and only once the app asks", async () => {
    list.extensions = [mod("stats.js"), mod("off.js")];
    localStorage.setItem("nativify:extensions", JSON.stringify(["stats.js", "gone.js"]));
    const log: string[] = [];
    modules["stats.js"] = recording(log);
    modules["off.js"] = recording(log);
    await boot();
    expect(log).toEqual([]);

    await mods.startExtensions();
    expect(log).toEqual(["start stats.js"]);
    expect(imported).toEqual(["nsmod://localhost/extensions/1/stats.js"]);
    expect(mods.states["stats.js"]).toBe("on");
    expect(mods.pages.map((p) => p.key)).toEqual(["stats.js/stats"]);
    expect(document.head.querySelectorAll('style[data-nativify-extension="stats.js"]')).toHaveLength(1);
  });

  it("get the app's objects and their own identity", async () => {
    list.extensions = [mod("a.js")];
    localStorage.setItem("nativify:extensions", '["a.js"]');
    let ns: ExtensionApi | undefined;
    modules["a.js"] = { default: (api: ExtensionApi) => void (ns = api) };
    await boot();
    await mods.startExtensions();
    expect(ns?.appVersion).toBe("9.9.9");
    expect(ns?.extension).toEqual({ id: "a.js", name: "a", url: "nsmod://localhost/extensions/1/a.js" });
    expect(ns?.player).toEqual({ name: "player" });
    expect(ns?.router).toEqual({ name: "router" });
    ns?.toasts.show("hi");
    expect(show).toHaveBeenCalledWith("hi", "info");
  });

  it("undo everything they registered when turned off", async () => {
    list.extensions = [mod("stats.js")];
    const log: string[] = [];
    modules["stats.js"] = recording(log);
    await boot();
    await mods.startExtensions();
    await mods.setEnabled("stats.js", true);
    expect(JSON.parse(localStorage.getItem("nativify:extensions")!)).toEqual(["stats.js"]);
    expect(mods.trackMenuItems).toHaveLength(1);

    await mods.setEnabled("stats.js", false);
    expect(log).toEqual(["start stats.js", "onUnload", "returned cleanup"]);
    expect(mods.states["stats.js"]).toBe("off");
    expect(mods.pages).toEqual([]);
    expect(mods.trackMenuItems).toEqual([]);
    expect(document.querySelector("style[data-nativify-extension]")).toBeNull();
    expect(localStorage.getItem("nativify:extensions")).toBe("[]");
  });

  it("removers returned by the API only run once", async () => {
    list.extensions = [mod("a.js")];
    localStorage.setItem("nativify:extensions", '["a.js"]');
    const removed = vi.fn();
    modules["a.js"] = {
      default: (ns: ExtensionApi) => {
        const remove = ns.addPage({ id: "p", label: "P", render: () => {} });
        ns.onUnload(removed);
        remove();
        remove();
      },
    };
    await boot();
    await mods.startExtensions();
    expect(mods.pages).toEqual([]);
    await mods.setEnabled("a.js", false);
    expect(removed).toHaveBeenCalledOnce();
  });

  it("restart when their file is edited", async () => {
    list.extensions = [mod("stats.js", 1)];
    localStorage.setItem("nativify:extensions", '["stats.js"]');
    const log: string[] = [];
    modules["stats.js"] = recording(log);
    await boot();
    await mods.startExtensions();

    await mods.refresh();
    expect(log).toEqual(["start stats.js"]);

    list.extensions[0].modified = 2;
    await mods.refresh();
    expect(log).toEqual(["start stats.js", "onUnload", "returned cleanup", "start stats.js"]);
    expect(imported.at(-1)).toBe("nsmod://localhost/extensions/2/stats.js");
    expect(mods.pages).toHaveLength(1);
    expect(mods.states["stats.js"]).toBe("on");
  });

  it("stop when their file is removed", async () => {
    list.extensions = [mod("stats.js")];
    localStorage.setItem("nativify:extensions", '["stats.js"]');
    const log: string[] = [];
    modules["stats.js"] = recording(log);
    await boot();
    await mods.startExtensions();
    list.extensions = [];
    await mods.refresh();
    expect(log.at(-1)).toBe("returned cleanup");
    expect(mods.states["stats.js"]).toBe("off");
    expect(mods.isEnabled("stats.js")).toBe(true);
  });

  it("that fail report it once, and retry after an edit", async () => {
    list.extensions = [mod("bad.js", 1)];
    localStorage.setItem("nativify:extensions", '["bad.js"]');
    let calls = 0;
    const cleanup = vi.fn();
    modules["bad.js"] = {
      default: (ns: ExtensionApi) => {
        calls++;
        ns.onUnload(cleanup);
        throw new Error("kaboom");
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await boot();
    await mods.startExtensions();
    expect(mods.states["bad.js"]).toBe("error");
    expect(mods.errors["bad.js"]).toBe("kaboom");
    expect(show).toHaveBeenCalledWith("bad couldn't start: kaboom", "error", 6000);
    expect(cleanup).toHaveBeenCalledOnce();

    await mods.refresh();
    expect(calls).toBe(1);

    list.extensions[0].modified = 2;
    modules["bad.js"] = { default: () => {} };
    await mods.refresh();
    expect(mods.states["bad.js"]).toBe("on");
    expect(mods.errors["bad.js"]).toBeUndefined();
  });

  it("without a default export stay active until the window reloads", async () => {
    list.extensions = [mod("legacy.js")];
    localStorage.setItem("nativify:extensions", '["legacy.js"]');
    modules["legacy.js"] = {};
    await boot();
    await mods.startExtensions();
    expect(mods.states["legacy.js"]).toBe("on");

    await mods.setEnabled("legacy.js", false);
    expect(mods.states["legacy.js"]).toBe("restart");

    // Still loaded, so turning it back on doesn't run it a second time.
    await mods.setEnabled("legacy.js", true);
    expect(mods.states["legacy.js"]).toBe("on");
    expect(imported).toHaveLength(1);

    // An edit can't replace the version that's running.
    list.extensions[0].modified = 2;
    await mods.refresh();
    expect(mods.states["legacy.js"]).toBe("restart");
    expect(imported).toHaveLength(1);
  });

  it("turned off while loading never finish starting", async () => {
    list.extensions = [mod("slow.js")];
    localStorage.setItem("nativify:extensions", '["slow.js"]');
    const main = vi.fn();
    let release!: () => void;
    await boot();
    mods.importer = () => new Promise((r) => (release = () => r({ default: main })));
    const starting = mods.startExtensions();
    await mods.setEnabled("slow.js", false);
    release();
    await starting;
    expect(main).not.toHaveBeenCalled();
    expect(mods.states["slow.js"]).toBe("off");
  });

  it("don't run in safe mode", async () => {
    list.extensions = [mod("a.js")];
    list.safe_mode = true;
    localStorage.setItem("nativify:extensions", '["a.js"]');
    modules["a.js"] = { default: vi.fn() };
    await boot();
    await mods.startExtensions();
    expect(imported).toEqual([]);
  });

  it("keep their storage apart", async () => {
    list.extensions = [mod("a.js"), mod("b.js")];
    localStorage.setItem("nativify:extensions", '["a.js","b.js"]');
    const apis: Record<string, ExtensionApi> = {};
    modules["a.js"] = { default: (ns: ExtensionApi) => void (apis.a = ns) };
    modules["b.js"] = { default: (ns: ExtensionApi) => void (apis.b = ns) };
    await boot();
    await mods.startExtensions();
    apis.a.storage.set("count", { n: 3 });
    expect(apis.a.storage.get("count")).toEqual({ n: 3 });
    expect(apis.b.storage.get("count")).toBeNull();
    expect(localStorage.getItem("nativify:ext:a.js:count")).toBe('{"n":3}');
    apis.a.storage.remove("count");
    expect(apis.a.storage.get("count")).toBeNull();
  });
});

describe("trackMenu", () => {
  it("lists extension entries that apply to the track", async () => {
    list.extensions = [mod("a.js")];
    localStorage.setItem("nativify:extensions", '["a.js"]');
    const shared: string[] = [];
    modules["a.js"] = {
      default: (ns: ExtensionApi) => {
        ns.addTrackMenuItem({ label: (t) => `Share ${t.name}`, action: (t) => shared.push(t.uri) });
        ns.addTrackMenuItem({ label: "Explicit only", action: () => {}, when: (t) => t.explicit });
        ns.addTrackMenuItem({
          label: "Broken filter",
          action: () => {},
          when: () => {
            throw new Error("x");
          },
        });
      },
    };
    await boot();
    await mods.startExtensions();
    const track = { uri: "spotify:track:1", name: "Song", explicit: false } as Parameters<typeof mods.trackMenu>[0];
    const items = mods.trackMenu(track);
    expect(items.map((i) => i.label)).toEqual(["Share Song"]);
    items[0].action();
    expect(shared).toEqual(["spotify:track:1"]);
  });
});
