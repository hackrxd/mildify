// Tracks whether items are saved in the user's library, batching lookups
// through the unified /me/library/contains endpoint (max 40 URIs per call).

import { SvelteMap } from "svelte/reactivity";
import { libraryContains, removeFromLibrary, saveToLibrary } from "./spotify";
import { toasts } from "./toasts.svelte";

const BATCH = 40;

class Liked {
  #saved = new SvelteMap<string, boolean>();
  #queued = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** `undefined` while unknown. */
  has(uri: string): boolean | undefined {
    return this.#saved.get(uri);
  }

  /** Schedules a lookup for any URIs we don't know about yet. */
  ensure(uris: string[]) {
    for (const uri of uris) {
      if (uri && !this.#saved.has(uri)) this.#queued.add(uri);
    }
    if (this.#queued.size && !this.#timer) {
      this.#timer = setTimeout(() => this.#flush(), 60);
    }
  }

  mark(uris: string[], saved: boolean) {
    for (const uri of uris) this.#saved.set(uri, saved);
  }

  async #flush() {
    this.#timer = undefined;
    const uris = [...this.#queued];
    this.#queued.clear();
    for (let i = 0; i < uris.length; i += BATCH) {
      const chunk = uris.slice(i, i + BATCH);
      try {
        const result = await libraryContains(chunk);
        chunk.forEach((uri, j) => this.#saved.set(uri, !!result[j]));
      } catch {
        // Leave unknown; hearts just stay hidden.
      }
    }
  }

  async toggle(uri: string) {
    const next = !this.#saved.get(uri);
    this.#saved.set(uri, next);
    try {
      await (next ? saveToLibrary([uri]) : removeFromLibrary([uri]));
      toasts.show(next ? "Saved to your library" : "Removed from your library");
    } catch (e) {
      this.#saved.set(uri, !next);
      toasts.error(e);
    }
  }
}

export const liked = new Liked();
