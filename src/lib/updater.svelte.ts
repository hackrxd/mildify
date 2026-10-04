import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { backend, errorMessage } from "./ipc";
import { toasts } from "./toasts.svelte";

const RECHECK_MS = 6 * 60 * 60 * 1000;

export type UpdateState = "idle" | "checking" | "up_to_date" | "downloading" | "ready" | "installing" | "error";

/**
 * Checks the GitHub release feed for a newer signed build, downloads it in the background and waits for
 * the user to apply it. A release that only changes the interface is loaded with a window reload, so the
 * music keeps playing (src-tauri/src/ui.rs); any other needs the full updater and a restart, which stops it.
 * Dev builds never check.
 */
class Updater {
  /** The interface's version. A reload-only update moves it ahead of the app's. */
  current = __APP_VERSION__;
  /** The installed app's version. */
  app = $state("");
  state = $state<UpdateState>("idle");
  /** The version waiting to be installed, once one is found. */
  available = $state<string | null>(null);
  /** Installing what's available restarts the app, which stops playback. */
  needsRestart = $state(false);
  /** Download progress, 0 to 1, or null while the size is unknown. */
  progress = $state<number | null>(null);
  error = $state<string | null>(null);
  #update: Update | null = null;
  #started = false;

  start() {
    if (this.#started) return;
    this.#started = true;
    getVersion().then((v) => (this.app = v));
    if (import.meta.env.DEV) return;
    this.check(true);
    setInterval(() => this.check(true), RECHECK_MS);
  }

  /** Quiet checks swallow errors (offline, no release published yet); manual ones report them. */
  async check(quiet = false) {
    if (["checking", "downloading", "ready", "installing"].includes(this.state)) return;
    this.state = "checking";
    this.error = null;
    try {
      // Without an interface update to go by (older releases, safe mode, a bad download), the full
      // updater decides.
      const ui = await backend.uiUpdate().catch((e) => {
        console.warn("Interface update check failed:", errorMessage(e));
        return null;
      });
      if (ui?.status === "up_to_date") {
        this.state = "up_to_date";
        return;
      }
      if (ui?.status === "ready") {
        this.available = ui.version;
        this.needsRestart = false;
        this.state = "ready";
        return;
      }
      const update = await check();
      if (!update) {
        this.state = "up_to_date";
        return;
      }
      this.#update = update;
      this.available = update.version;
      this.needsRestart = true;
      await this.#download(update);
    } catch (e) {
      this.#update = null;
      this.available = null;
      this.state = quiet ? "idle" : "error";
      if (!quiet) this.error = errorMessage(e);
    }
  }

  async #download(update: Update) {
    this.state = "downloading";
    this.progress = null;
    let total = 0;
    let done = 0;
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        done += event.data.chunkLength;
        if (total) this.progress = done / total;
      }
    });
    this.state = "ready";
  }

  /**
   * Reloads into a downloaded interface, or installs the full update and restarts. On Windows the installer
   * closes the app itself.
   */
  async apply() {
    if (this.state !== "ready") return;
    this.state = "installing";
    try {
      if (!this.needsRestart) {
        await backend.applyUiUpdate();
        location.reload();
        return;
      }
      if (!this.#update) throw new Error("The update is no longer available");
      await this.#update.install();
      await relaunch();
    } catch (e) {
      this.state = "ready";
      toasts.error(e);
    }
  }
}

export const updater = new Updater();
