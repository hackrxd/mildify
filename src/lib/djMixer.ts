// The music's level under the DJ: turned down while it talks and back up after, and silent from the end of a song it
// talks on after, so whatever Spotify starts next isn't heard before its time. Each change is asked of the player as
// heard: it takes effect after the music already in its output (`dj_duck`, src-tauri/src/dj/duck.rs).

import { DUCK_DOWN_MS, DUCK_LEVEL, DUCK_UP_MS } from "./djTiming";

/** The silence at a song's end comes in over this long. */
export const MUTE_RAMP_MS = 120;
/** The song drifting this far from when its end's silence was timed (a pause, a small seek) times it again. */
const RETIME_MS = 250;
/** The player lifts a duck on its own after 90 s, in case the window went away; the DJ renews its own sooner. */
const GAIN_REFRESH_MS = 30_000;

/** What the mixer needs from the player and the DJ. */
export interface MixerHost {
  /** Asks the player for gain `level`, `delayMs` from now as heard, over `rampMs`. */
  gain(level: number, delayMs: number, rampMs: number): void;
  /** The clock it times things on: performance.now()'s. */
  now(): number;
  /** The song playing, and how far into it the player is. */
  track(): string | null;
  position(): number;
  /** Whether the DJ is talking: music brought back while it does stays under the voice. */
  speaking(): boolean;
}

/** The music's gain, as the DJ last asked the player for it. */
export class Mixer {
  readonly #host: MixerHost;
  #level = 1;
  #sentAt = -Infinity;
  /** The music goes silent when this song reaches this position. */
  #silence: { uri: string; at: number } | null = null;
  /** When that silence is heard, on the host's clock. Kept once the song is gone, for what follows it. */
  #silentAt = 0;

  constructor(host: MixerHost) {
    this.#host = host;
  }

  /** The gain last asked for. */
  get level(): number {
    return this.#level;
  }

  /** Whether the music is down under the voice. */
  get ducked(): boolean {
    return this.#level === DUCK_LEVEL;
  }

  /** Whether the music goes silent at the end of the song playing. */
  get silencing(): boolean {
    return this.#silence !== null;
  }

  /** How long until the silence at the song's end is heard; none or negative once it has been. */
  silentIn(): number {
    return this.#silentAt - this.#host.now();
  }

  /** Brings the music's gain to `level`, `delayMs` from now as heard, over `rampMs`. Any sound at all is no silence at
   * the song's end. */
  to(level: number, delayMs: number, rampMs: number) {
    this.#level = level;
    if (level > 0) this.#silence = null;
    this.#sentAt = this.#host.now();
    this.#host.gain(level, Math.round(Math.max(0, delayMs)), Math.round(rampMs));
  }

  /** Starts turning the music down under the voice `delayMs` from now, as heard: it's down `DUCK_DOWN_MS` later. */
  duck(delayMs: number) {
    this.to(DUCK_LEVEL, delayMs, DUCK_DOWN_MS);
  }

  /** Brings music that's down back up. */
  unduck() {
    if (this.#level < 1) this.to(1, 0, DUCK_UP_MS);
  }

  /** Brings the music to where it belongs now, over `rampMs`: under the voice while the DJ talks, up otherwise. */
  restore(rampMs = 0) {
    this.to(this.#host.speaking() ? DUCK_LEVEL : 1, 0, rampMs);
  }

  /** Silences the music as `uri` reaches `at` (its end), so whatever Spotify starts next isn't heard. */
  silenceAt(uri: string, at: number) {
    const left = at - this.#host.position();
    this.to(0, left - MUTE_RAMP_MS, MUTE_RAMP_MS);
    this.#silence = { uri, at };
    this.#silentAt = this.#host.now() + left;
  }

  /** Says the gain again: after a pause, the silence at a song's end has to be timed anew, and the player would lift
   * music that's down on its own after a while. */
  refresh() {
    const silence = this.#silence;
    if (silence && this.#host.track() === silence.uri && this.#host.position() < silence.at) {
      this.restore();
      this.silenceAt(silence.uri, silence.at);
    } else if (this.#level < 1) {
      this.to(this.#level, 0, 0);
    }
  }

  /** At `now`, renews music that's down before the player lifts it on its own. */
  renew(now: number) {
    if (this.#level < 1 && now - this.#sentAt > GAIN_REFRESH_MS) this.refresh();
  }

  /** At `now`, with `uri` at `pos`: times the silence at its end anew when the song has drifted from when it was timed
   * (a pause, or a step too small to plan the talk again). */
  retime(now: number, uri: string | null, pos: number, playing: boolean) {
    const silence = this.#silence;
    if (silence?.uri === uri && playing && Math.abs(silence.at - pos - (this.#silentAt - now)) > RETIME_MS) this.refresh();
  }

  /** The song the silence was timed for is gone: when it's heard stays known, for whatever follows the song. */
  songEnded() {
    this.#silence = null;
  }

  /** No silence at the song's end, nor one to wait for. */
  dropSilence() {
    this.#silence = null;
    this.#silentAt = 0;
  }
}
