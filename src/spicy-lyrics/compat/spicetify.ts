// The small slice of the `Spicetify` global that the verbatim Spicy Lyrics files
// still touch, implemented for a normal webview. Must be imported before any
// vendored module (stores.ts reads LocalStorage at load time).

import { host } from "./host.ts";

const tooltip = (el: Element, props: { content?: string } = {}) => {
  if (props.content && el instanceof HTMLElement) el.title = props.content;
  return {
    destroy() {},
    setContent(text: string) {
      if (el instanceof HTMLElement) el.title = text;
    },
    setProps() {},
    show() {},
    hide() {},
  };
};

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage full or unavailable: settings just won't persist.
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

(globalThis as any).Spicetify = {
  LocalStorage: storage,
  Tippy: tooltip,
  TippyProps: {},
  // The page is always "open" here; there's no Spotify router.
  Platform: { History: { location: { pathname: "/SpicyLyrics" }, listen: () => () => {} } },
  // Private Spotify GraphQL (dynamic colours, artist visuals) isn't available.
  GraphQL: {
    Definitions: {},
    Request: async () => ({ data: null }),
  },
  Player: {
    get data() {
      const t = host.track();
      return t ? { item: { uri: t.uri, type: t.type } } : undefined;
    },
    origin: { seekTo: (ms: number) => host.seek(ms) },
  },
};

// Profile links and the like call window.open; send http(s) links to the system browser.
const originalOpen = window.open.bind(window);
window.open = ((url?: string | URL, target?: string, features?: string) => {
  const href = url?.toString() ?? "";
  if (/^https?:\/\//i.test(href)) {
    host.openUrl(href);
    return null;
  }
  return originalOpen(url, target, features);
}) as typeof window.open;
