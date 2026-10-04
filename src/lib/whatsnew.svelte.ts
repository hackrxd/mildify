import changelog from "../../CHANGELOG.md?raw";
import { isNewer, parseChangelog, UNRELEASED, type Release } from "./changelog";
import { router } from "./router.svelte";

const SEEN_KEY = "nativify:seenVersion";

function load(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function save(version: string) {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // The banner may show again next launch.
  }
}

/** Whether this window has run Mildify before: it keeps its settings under `nativify:` keys. */
function usedBefore(): boolean {
  try {
    return Object.keys(localStorage).some((k) => k.startsWith("nativify:"));
  } catch {
    return false;
  }
}

/**
 * The What's new page and the banner offering it after an update. The interface's version is what counts,
 * so a reload-only update shows it too.
 */
class WhatsNew {
  readonly current = __APP_VERSION__;
  /** Releases up to this one, newest first; development builds also show what's unreleased. */
  readonly releases: Release[] = parseChangelog(changelog).filter((r) =>
    r.version === UNRELEASED ? import.meta.env.DEV : !isNewer(r.version, __APP_VERSION__),
  );
  /** The version updated from, while this launch is the first since an update. */
  since = $state<string | null>(null);
  banner = $state(false);
  #started = false;

  start() {
    if (this.#started) return;
    this.#started = true;
    let seen = load();
    // Updated from a version from before this page: count it as the release before this one.
    if (!seen && usedBefore()) seen = this.releases.find((r) => isNewer(this.current, r.version))?.version ?? null;
    save(this.current);
    if (seen && isNewer(this.current, seen) && this.releases.some((r) => this.isNew(r, seen))) {
      this.since = seen;
      this.banner = true;
    }
  }

  /** Whether a release came with the update this launch follows. */
  isNew(release: Release, since = this.since): boolean {
    return since !== null && release.version !== UNRELEASED && isNewer(release.version, since);
  }

  open() {
    this.banner = false;
    router.go({ name: "changelog" });
  }

  dismiss() {
    this.banner = false;
  }
}

export const whatsNew = new WhatsNew();
