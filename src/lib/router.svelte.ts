// In-memory navigation with back/forward history, like a native app.

export type Route =
  | { name: "home" }
  | { name: "search"; q?: string }
  | { name: "liked" }
  | { name: "albums" }
  | { name: "artists" }
  | { name: "album"; id: string }
  | { name: "artist"; id: string }
  | { name: "playlist"; id: string }
  | { name: "lyrics" }
  /** A page an extension added; `id` is `<extension id>/<page id>`. */
  | { name: "extension"; id: string }
  | { name: "settings" };

class Router {
  #stack = $state<Route[]>([{ name: "home" }]);
  #index = $state(0);
  /** Bumped on every navigation so views can reset scroll. */
  version = $state(0);

  current = $derived(this.#stack[this.#index]);
  canBack = $derived(this.#index > 0);
  canForward = $derived(this.#index < this.#stack.length - 1);

  go(route: Route) {
    if (JSON.stringify(route) === JSON.stringify(this.current)) return;
    this.#stack = [...this.#stack.slice(0, this.#index + 1), route];
    this.#index = this.#stack.length - 1;
    this.version++;
  }

  /** Updates the current entry without adding history (e.g. typing a search). */
  replace(route: Route) {
    this.#stack[this.#index] = route;
  }

  back() {
    if (this.canBack) {
      this.#index--;
      this.version++;
    }
  }

  forward() {
    if (this.canForward) {
      this.#index++;
      this.version++;
    }
  }

  /** Navigates to whatever a Spotify URI points at, if we have a view for it. */
  openUri(uri: string) {
    const [, type, id] = uri.split(":");
    if (type === "album" || type === "artist" || type === "playlist") this.go({ name: type, id });
    else if (uri.endsWith(":collection")) this.go({ name: "liked" });
  }
}

export const router = new Router();
