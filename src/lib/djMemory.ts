// What the DJ keeps in localStorage: its settings, and the songs it played lately.

export const PLAYED_KEY = "nativify:djPlayed";
/** Songs the DJ played this recently aren't picked again in a new session. */
export const PLAYED_MEMORY_MS = 3 * 24 * 60 * 60 * 1000;
export const PLAYED_KEPT = 400;

export function load<T>(key: string, fallback: T, read: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : read(raw);
  } catch {
    return fallback;
  }
}

export function persist(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applies for this session.
  }
}

/** Songs the DJ played lately, by URI, so a new session doesn't start with the same ones. */
export function playedLately(now = Date.now()): Map<string, number> {
  const raw = load<unknown>(PLAYED_KEY, {}, JSON.parse);
  const out = new Map<string, number>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [uri, at] of Object.entries(raw)) {
      if (typeof at === "number" && now - at < PLAYED_MEMORY_MS) out.set(uri, at);
    }
  }
  return out;
}

export function rememberPlayed(uri: string, now = Date.now()) {
  const played = playedLately(now);
  played.delete(uri);
  played.set(uri, now);
  const kept = [...played].slice(-PLAYED_KEPT);
  persist(PLAYED_KEY, JSON.stringify(Object.fromEntries(kept)));
}
