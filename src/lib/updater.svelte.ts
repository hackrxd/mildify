import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { errorMessage } from "./ipc";
import { toasts } from "./toasts.svelte";

const RECHECK_MS = 6 * 60 * 60 * 1000;

export type UpdateState = "idle" | "checking" | "up_to_date" | "downloading" | "ready" | "installing" | "error";

/**
 * Checks the GitHub release feed for a newer signed build, downloads it in the background and
 * waits for the user to restart into it. Dev builds never check.
 */
class Updater {
  current = $state("");
  state = $state<UpdateState>("idle");
  /** The version waiting to be installed, once one is found. */
  available = $state<string | null>(null);
  /** Download progress, 0 to 1, or null while the size is unknown. */
  progress = $state<number | null>(null);
  error = $state<string | null>(null);
  #update: Update | null = null;
  #started = false;

  start() {
    if (this.#started) return;
    this.#started = true;
    getVersion().then((v) => (this.current = v));
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
      const update = await check();
      if (!update) {
        this.state = "up_to_date";
        return;
      }
      this.#update = update;
      this.available = update.version;
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

  /** Installs the downloaded update and restarts. On Windows the installer closes the app itself. */
  async restart() {
    if (!this.#update || this.state !== "ready") return;
    this.state = "installing";
    try {
      await this.#update.install();
      await relaunch();
    } catch (e) {
      this.state = "ready";
      toasts.error(e);
    }
  }
}

export const updater = new Updater();
