// What the DJ plans over the end of a set's last song to bring the next set in: cues on that song's clock (turn the
// music down, start the talk, silence the song's end), and whether the next set's first song is to wait at its start
// for its time in the line. It's let go of all at once (`drop`), or handed to the set it brought in (`land`).

import type { Mixer } from "./djMixer";

/** Something to do when a clock (the finishing song's, or the line's) reaches a point. */
export interface Cue {
  at: number;
  fire: () => void;
  fired: boolean;
  armed: boolean;
}

export function cue(at: number, fire: () => void): Cue {
  return { at, fire, fired: false, armed: false };
}

/** A cue this close to its time is due. */
const DUE_MS = 5;

/** Fires the cues due on a clock that's at `now`, and arms a timer (`after`) for those due within `soonMs`, before
 * the clock is looked at again. One armed ahead fires only if it's still `wanted` when its time comes, and its clock
 * got there: a pause stops it. */
export function runCues(
  cues: readonly Cue[],
  now: number,
  clock: () => number,
  soonMs: number,
  wanted: (c: Cue) => boolean,
  after: (ms: number, fn: () => void) => void,
) {
  for (const c of cues) {
    if (c.fired) continue;
    const fire = () => {
      // Dropped since it was armed (a plan let go of, or made anew): not due any more.
      if (c.fired || !wanted(c)) return;
      // Armed ahead, then the clock stopped (a pause): not due after all.
      if (clock() < c.at - DUE_MS) {
        c.armed = false;
        return;
      }
      c.fired = true;
      c.fire();
    };
    if (now >= c.at - DUE_MS) fire();
    else if (!c.armed && c.at - now < soonMs) {
      c.armed = true;
      after(c.at - now, fire);
    }
  }
}

/** The next set's first song held at its start when it comes in, until this far into the line that brings it in. */
export interface Hold<S> {
  set: S;
  musicAt: number;
}

/** The hand-over planned over the end of the song playing, if any. */
export class HandOver<S> {
  readonly #mixer: Mixer;
  #on: string | null = null;
  #cues: Cue[] = [];
  #hold: Hold<S> | null = null;

  /** `mixer` times the silence at the song's end, which goes with the hand-over. */
  constructor(mixer: Mixer) {
    this.#mixer = mixer;
  }

  /** The song it's planned on. */
  get on(): string | null {
    return this.#on;
  }

  /** Its cues, on that song's clock. */
  get cues(): readonly Cue[] {
    return this.#cues;
  }

  /** Plans it over the end of `uri`: `cues` on its clock, and the next set's first song held, or not. */
  plan(uri: string, cues: Cue[], hold: Hold<S> | null) {
    this.#on = uri;
    this.#cues = cues;
    this.#hold = hold;
  }

  /** None of its cues fire any more: the next set is on its way in already. */
  settle() {
    for (const c of this.#cues) c.fired = true;
  }

  /** Lets go of all of it, the silence at the song's end included. Whether one was planned. */
  drop(): boolean {
    const planned = this.#on !== null;
    this.#on = null;
    this.#cues = [];
    this.#hold = null;
    this.#mixer.dropSilence();
    return planned;
  }

  /** `set` came in: its first song's hold, if one was planned for it. The silence at the finishing song's end is
   * heard or about to be, and when stays known, for the talk to wait for it. */
  land(set: S): Hold<S> | null {
    const hold = this.#hold?.set === set ? this.#hold : null;
    this.#on = null;
    this.#cues = [];
    this.#hold = null;
    this.#mixer.songEnded();
    return hold;
  }
}
