// User mods: a CSS theme, Quick CSS and JavaScript extensions. Themes and extensions are files in
// the app config dir, served by the backend's `nsmod` scheme (mods.rs) so their relative URLs work.

import { getVersion } from "@tauri-apps/api/app";
import type { IconName } from "../components/Icon.svelte";
import { api, backend, errorMessage, type ModInfo, type ModKind, type ModList } from "./ipc";
import { player } from "./player.svelte";
import { router } from "./router.svelte";
import { session } from "./session.svelte";
import { toasts } from "./toasts.svelte";
import type { SimpleTrack, Track } from "./types";

const THEME_KEY = "nativify:theme";
const EXTENSIONS_KEY = "nativify:extensions";
const QUICK_CSS_KEY = "nativify:quickCss";
const STORAGE_PREFIX = "nativify:ext:";

/** A context menu entry an extension adds to every track. */
export interface TrackMenuItem {
  label: string | ((track: SimpleTrack | Track) => string);
  action: (track: SimpleTrack | Track) => void;
  /** Hide the entry for tracks it doesn't apply to. */
  when?: (track: SimpleTrack | Track) => boolean;
}

/** A page an extension adds to the sidebar. */
export interface ExtensionPage {
  /** Unique within the extension. */
  id: string;
  label: string;
  icon?: IconName;
  /** Draws the page into `el`; may return a cleanup for when the page closes. */
  render: (el: HTMLElement) => void | (() => void);
}

export interface RegisteredPage extends ExtensionPage {
  /** `<extension id>/<page id>`, the route's id. */
  key: string;
  extension: string;
}

/** What an extension's default export is called with. */
export interface ExtensionApi {
  appVersion: string;
  extension: { id: string; name: string; url: string };
  player: typeof player;
  router: typeof router;
  session: typeof session;
  /** Calls the Spotify Web API through the backend (see ipc.ts). */
  api: typeof api;
  toasts: { show: (message: string, tone?: "info" | "error") => void };
  /** Runs `fn` now and again whenever app state it read changes. Returns a stop function. */
  watch: (fn: () => void | (() => void)) => () => void;
  /** Adds a stylesheet. Returns a remove function. */
  addStyle: (css: string) => () => void;
  storage: {
    get: <T = unknown>(key: string) => T | null;
    set: (key: string, value: unknown) => void;
    remove: (key: string) => void;
  };
  addTrackMenuItem: (item: TrackMenuItem) => () => void;
  addPage: (page: ExtensionPage) => () => void;
  /** Runs when the extension is turned off or reloaded. */
  onUnload: (fn: () => void) => void;
}

/**
 * off: not enabled. loading/on/error: as named. restart: turned off (or edited), but the
 * extension has no default export to undo, so it stays active until the UI reloads.
 */
export type ExtensionState = "off" | "loading" | "on" | "error" | "restart";

interface Running {
  modified: number;
  /** Cleanups registered through the API, run in reverse. */
  cleanups: (() => void)[];
  /** False for side-effect-only modules: nothing to undo them with. */
  unloadable: boolean;
}

function load<T>(key: string, fallback: T, parse: (s: string) => T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : parse(v);
  } catch {
    return fallback;
  }
}

function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applies for this session.
  }
}

function parseIds(s: string): string[] {
  const v = JSON.parse(s);
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/**
 * URL a mod's file is served at. The version `v` is a path segment, not a query, so the files the
 * entry imports or links relatively get it too: after an edit the webview fetches all of them again
 * instead of reusing cached modules and stylesheets.
 */
export function modUrl(base: string, kind: ModKind, entry: string, v: number | string): string {
  return `${base}${kind}/${encodeURIComponent(String(v))}/${entry.split("/").map(encodeURIComponent).join("/")}`;
}

function runAll(fns: (() => void)[], who: string) {
  for (const fn of fns.reverse()) {
    try {
      fn();
    } catch (e) {
      console.error(`[${who}] cleanup failed`, e);
    }
  }
}

class Mods {
  list = $state<ModList | null>(null);
  /** Active theme id, or null for the built-in look. */
  theme = $state<string | null>(load(THEME_KEY, null, (s) => s || null));
  /** Ids of extensions the user turned on. */
  enabled = $state<string[]>(load(EXTENSIONS_KEY, [], parseIds));
  quickCss = $state(load(QUICK_CSS_KEY, "", (s) => s));
  states = $state<Record<string, ExtensionState>>({});
  errors = $state<Record<string, string>>({});
  // Raw: entries are compared by identity when removed, and arrays are always replaced.
  pages = $state.raw<RegisteredPage[]>([]);
  trackMenuItems = $state.raw<(TrackMenuItem & { extension: string })[]>([]);

  safeMode = $derived(this.list?.safe_mode ?? false);
  activeTheme = $derived(this.list?.themes.find((t) => t.id === this.theme) ?? null);

  /** Loads an extension module. Tests swap it out; the webview can't import from Node. */
  importer: (url: string) => Promise<Record<string, unknown>> = (url) => import(/* @vite-ignore */ url);

  #running = new Map<string, Running>();
  #extensionsStarted = false;
  #themeBust = "";
  #appVersion = "";
  #inited = false;

  /** Applies the theme and Quick CSS, and re-reads the folders whenever the window regains focus. */
  async init() {
    if (this.#inited) return;
    this.#inited = true;
    getVersion()
      .then((v) => (this.#appVersion = v))
      .catch(() => {});
    window.addEventListener("focus", () => this.refresh());
    await this.refresh();
  }

  /** Starts enabled extensions. Call once the app shell is up. */
  async startExtensions() {
    if (this.#extensionsStarted) return;
    this.#extensionsStarted = true;
    await this.#syncExtensions();
  }

  /**
   * Re-reads the mods folders, reapplies an edited theme and restarts edited extensions.
   * `force` reloads them even if no file changed (one outside the mod's folder did).
   */
  async refresh(force = false) {
    try {
      this.list = await backend.listMods();
    } catch (e) {
      if (force) toasts.error(e);
      this.#applyQuickCss();
      return;
    }
    if (force) this.#themeBust = String(Date.now());
    this.#applyTheme();
    this.#applyQuickCss();
    if (this.#extensionsStarted) await this.#syncExtensions(force);
  }

  setTheme(id: string | null) {
    this.theme = id;
    save(THEME_KEY, id);
    this.#applyTheme();
  }

  setQuickCss(css: string) {
    this.quickCss = css;
    save(QUICK_CSS_KEY, css.trim() ? css : null);
    this.#applyQuickCss();
  }

  async setEnabled(id: string, on: boolean) {
    this.enabled = on ? [...new Set([...this.enabled, id])] : this.enabled.filter((x) => x !== id);
    save(EXTENSIONS_KEY, JSON.stringify(this.enabled));
    if (this.#extensionsStarted) await this.#syncExtensions();
  }

  isEnabled(id: string) {
    return this.enabled.includes(id);
  }

  openFolder(kind: ModKind) {
    backend.openModsFolder(kind).catch((e) => toasts.error(e));
  }

  /** The context menu entries extensions add for this track. */
  trackMenu(track: SimpleTrack | Track) {
    return this.trackMenuItems
      .filter((item) => {
        try {
          return item.when?.(track) ?? true;
        } catch {
          return false;
        }
      })
      .map((item) => ({
        label: typeof item.label === "function" ? item.label(track) : item.label,
        action: () => {
          try {
            item.action(track);
          } catch (e) {
            toasts.error(e);
          }
        },
      }));
  }

  page(key: string) {
    return this.pages.find((p) => p.key === key) ?? null;
  }

  #applyTheme() {
    const theme = this.safeMode ? null : this.activeTheme;
    let link = document.querySelector<HTMLLinkElement>("link[data-nativify-theme]");
    if (!theme || !this.list) {
      link?.remove();
      return;
    }
    const href = modUrl(this.list.base_url, "themes", theme.entry, `${theme.modified}${this.#themeBust}`);
    if (link?.getAttribute("href") === href) return;
    if (!link) {
      link = document.createElement("link");
      link.rel = "stylesheet";
      link.dataset.nativifyTheme = "";
    }
    link.href = href;
    // In the body, after every stylesheet in the head, so equal-specificity rules win.
    document.body.insertBefore(link, document.querySelector("style[data-nativify-quick-css]"));
  }

  #applyQuickCss() {
    let style = document.querySelector<HTMLStyleElement>("style[data-nativify-quick-css]");
    // Safe mode is for recovering from a broken look, and Quick CSS can break it as well as a theme.
    if (this.safeMode || !this.quickCss.trim()) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.dataset.nativifyQuickCss = "";
      document.body.append(style);
    }
    style.textContent = this.quickCss;
  }

  /** Brings running extensions in line with what's enabled and installed. */
  async #syncExtensions(force = false) {
    const installed = new Map((this.list?.extensions ?? []).map((m) => [m.id, m]));
    const wanted = new Set(this.safeMode ? [] : this.enabled.filter((id) => installed.has(id)));

    for (const [id, running] of [...this.#running]) {
      const mod = installed.get(id);
      if (!wanted.has(id) || force || mod?.modified !== running.modified) this.#stop(id);
    }
    for (const id of Object.keys(this.states)) {
      if (!wanted.has(id) && !this.#lingering.has(id)) this.states[id] = "off";
    }
    for (const id of wanted) {
      const mod = installed.get(id)!;
      if (this.#running.has(id)) continue;
      const lingering = this.#lingering.get(id);
      if (lingering === mod.modified) {
        // Turned off this session but never unloaded, so it's still active: just take it back.
        this.#lingering.delete(id);
        this.#running.set(id, { modified: mod.modified, cleanups: [], unloadable: false });
        this.states[id] = "on";
      } else if (lingering !== undefined) {
        this.states[id] = "restart";
      } else if (force || this.#failed.get(id) !== mod.modified) {
        await this.#start(mod);
      }
    }
  }

  /** Side-effect-only extensions stopped this session, by the version that's still active. */
  #lingering = new Map<string, number>();
  /** Extensions that threw on start, by the version that did, so they aren't retried on every focus. */
  #failed = new Map<string, number>();

  async #start(mod: ModInfo) {
    if (!this.list) return;
    const url = modUrl(this.list.base_url, "extensions", mod.entry, mod.modified);
    const running: Running = { modified: mod.modified, cleanups: [], unloadable: true };
    this.#running.set(mod.id, running);
    this.states[mod.id] = "loading";
    this.#failed.delete(mod.id);
    delete this.errors[mod.id];
    try {
      const module = await this.importer(url);
      // Turned off or edited while loading.
      if (this.#running.get(mod.id) !== running) return;
      const main = module.default;
      if (typeof main === "function") {
        const cleanup = await main(this.#api(mod, url, running));
        if (typeof cleanup === "function") running.cleanups.unshift(cleanup);
      } else {
        running.unloadable = false;
      }
      if (this.#running.get(mod.id) === running) this.states[mod.id] = "on";
      else runAll(running.cleanups, mod.name);
    } catch (e) {
      console.error(`[${mod.name}] failed to start`, e);
      if (this.#running.get(mod.id) === running) {
        this.#stop(mod.id);
        this.#lingering.delete(mod.id);
        this.#failed.set(mod.id, mod.modified);
        this.states[mod.id] = "error";
        this.errors[mod.id] = errorMessage(e);
        toasts.show(`${mod.name} couldn't start: ${errorMessage(e)}`, "error", 6000);
      }
    }
  }

  /** Undoes everything the extension registered. */
  #stop(id: string) {
    const running = this.#running.get(id);
    if (!running) return;
    this.#running.delete(id);
    runAll(running.cleanups.splice(0), id);
    this.pages = this.pages.filter((p) => p.extension !== id);
    this.trackMenuItems = this.trackMenuItems.filter((i) => i.extension !== id);
    if (running.unloadable) {
      this.states[id] = "off";
    } else {
      this.#lingering.set(id, running.modified);
      this.states[id] = "restart";
    }
  }

  #api(mod: ModInfo, url: string, running: Running): ExtensionApi {
    const track = (fn: () => void) => {
      running.cleanups.push(fn);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        running.cleanups = running.cleanups.filter((f) => f !== fn);
        fn();
      };
    };
    const key = (k: string) => `${STORAGE_PREFIX}${mod.id}:${k}`;
    return {
      appVersion: this.#appVersion,
      extension: { id: mod.id, name: mod.name, url },
      player,
      router,
      session,
      api,
      toasts: { show: (message, tone = "info") => toasts.show(message, tone) },
      watch: (fn) =>
        track(
          $effect.root(() => {
            $effect(fn);
          }),
        ),
      addStyle: (css) => {
        const style = document.createElement("style");
        style.dataset.nativifyExtension = mod.id;
        style.textContent = css;
        document.head.append(style);
        return track(() => style.remove());
      },
      storage: {
        get: <T>(k: string) => load<T | null>(key(k), null, (s) => JSON.parse(s)),
        set: (k, value) => save(key(k), JSON.stringify(value)),
        remove: (k) => save(key(k), null),
      },
      addTrackMenuItem: (item) => {
        const entry = { ...item, extension: mod.id };
        this.trackMenuItems = [...this.trackMenuItems, entry];
        return track(() => (this.trackMenuItems = this.trackMenuItems.filter((i) => i !== entry)));
      },
      addPage: (page) => {
        const registered: RegisteredPage = { ...page, key: `${mod.id}/${page.id}`, extension: mod.id };
        this.pages = [...this.pages.filter((p) => p.key !== registered.key), registered];
        return track(() => (this.pages = this.pages.filter((p) => p !== registered)));
      },
      onUnload: (fn) => void running.cleanups.push(fn),
    };
  }
}

export const mods = new Mods();
