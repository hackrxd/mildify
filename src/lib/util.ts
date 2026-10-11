import type { Image, Queue } from "./types";

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Longer runtimes read better as words: "1 hr 12 min". */
export function formatRuntime(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

/** Picks the smallest image at least `min` px wide, falling back to the largest. */
export function pickImage(images: Image[] | null | undefined, min = 300): string | null {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= min) ?? sorted[sorted.length - 1]).url;
}

export function idFromUri(uri: string): string {
  return uri.split(":").pop() ?? uri;
}

/** Ids of the next `count` distinct Spotify tracks in a queue, leaving out `currentId`. */
export function upcomingTrackIds(queue: Queue | null, currentId: string | null, count: number): string[] {
  const ids: string[] = [];
  for (const t of queue?.queue ?? []) {
    if (ids.length >= count) break;
    if (!t?.uri?.startsWith("spotify:track:")) continue;
    const id = idFromUri(t.uri);
    if (id !== currentId && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function year(releaseDate: string | undefined): string {
  return releaseDate?.slice(0, 4) ?? "";
}

/** For a label used mid-sentence: "Voices (Kokoro)" → "voices (Kokoro)". */
export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Download and disk sizes: "1.1 GB", "103 MB". */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${Math.max(0, Math.round(n))} B`;
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** Strips the HTML Spotify sometimes puts in playlist descriptions. */
export function plainText(html: string | null | undefined): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent ?? "";
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Puts text on the clipboard, falling back to a hidden textarea where the async API is refused. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Older WebKitGTK builds reject the async clipboard; execCommand still works there.
  }
  // Selecting it takes the focus, which goes back where it was after.
  const focused = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
  if (!ok) throw new Error("Couldn't copy to the clipboard");
}
