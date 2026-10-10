// The DJ's voice: its lines play in the backend (src-tauri/src/dj/speaker.rs), and their clock runs here.
import { listen } from "@tauri-apps/api/event";
import { backend, errorMessage, type DjVoiceEvent } from "./ipc";
import type { LyricLine } from "./lyricLines";

export interface Spoken {
  /** The line's id in the backend, which plays it. */
  id: number;
  durationMs: number;
  lines: LyricLine[];
}

/** The line's clock and the backend's drift apart by this much before the backend's wins. */
const VOICE_RESYNC_MS = 80;

/** Plays the DJ's lines on this computer's audio output, as the music plays (src-tauri/src/dj/speaker.rs), at
 * the music's volume. Not through the window's own audio: on Linux that needs GStreamer plugins that may not be
 * there. The line's clock runs here, set right by the backend's reports a few times a second. */
export class Voice {
  #id: number | null = null;
  #onEnd: ((error?: string) => void) | null = null;
  /** ms into the line at `#since`, running from there unless paused. */
  #at = 0;
  #since = 0;
  #running = false;
  #gain = -1;
  #listening = false;

  #listen() {
    if (this.#listening) return;
    this.#listening = true;
    listen<DjVoiceEvent>("dj-voice", (e) => this.#heard(e.payload)).catch(() => (this.#listening = false));
  }

  #heard(ev: DjVoiceEvent) {
    if (ev.id !== this.#id) return;
    if (ev.state === "playing") {
      if (this.#running && Math.abs(this.now() - ev.position_ms) > VOICE_RESYNC_MS) this.#anchor(ev.position_ms);
    } else {
      this.#finish(ev.state === "failed" ? ev.error : undefined);
    }
  }

  #anchor(at: number) {
    this.#at = at;
    this.#since = performance.now();
  }

  #finish(error?: string) {
    const onEnd = this.#onEnd;
    this.#clear();
    onEnd?.(error);
  }

  #clear() {
    this.#id = null;
    this.#onEnd = null;
    this.#running = false;
    this.#at = 0;
  }

  /** Plays the line `dj_speak` made as `id`, in place of any line playing; `onEnd` gets why when it couldn't. */
  play(id: number, gain: number, onEnd: (error?: string) => void) {
    this.#listen();
    this.#id = id;
    this.#onEnd = onEnd;
    this.#gain = gain;
    this.#running = true;
    this.#anchor(0);
    backend.djVoice({ action: "play", id, gain }).catch((e) => {
      if (this.#id === id) this.#finish(errorMessage(e));
    });
  }

  /** Holds the line where it is: `now()` stands still until `resume()`. */
  pause() {
    if (this.#id === null || !this.#running) return;
    this.#anchor(this.now());
    this.#running = false;
    backend.djVoice({ action: "pause" }).catch(() => {});
  }

  resume() {
    if (this.#id === null || this.#running) return;
    this.#anchor(this.#at);
    this.#running = true;
    backend.djVoice({ action: "resume" }).catch(() => {});
  }

  setGain(gain: number) {
    if (this.#id === null || Math.abs(gain - this.#gain) < 0.001) return;
    this.#gain = gain;
    backend.djVoice({ action: "gain", gain }).catch(() => {});
  }

  /** ms into the line playing now. */
  now(): number {
    if (this.#id === null) return 0;
    return this.#running ? this.#at + performance.now() - this.#since : this.#at;
  }

  /** Lets go of the line without stopping it: another took its place on the output. Its `onEnd` isn't called. */
  forget() {
    this.#clear();
  }

  /** Stops the line; its `onEnd` isn't called. */
  stop() {
    if (this.#id === null) return;
    this.#clear();
    backend.djVoice({ action: "stop" }).catch(() => {});
  }
}
