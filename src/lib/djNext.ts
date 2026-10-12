// The set after the one playing, on its way: picked one at a time, a newer pick making the one under way stale (a
// request, a skipped set), with the wait for the model cut short when the music can't wait for it; then put in the
// player's queue after the last song of the set playing.

/** The DJ stopped waiting for its model: too slow, or the music couldn't wait. Not something to fix. `why` says so to
 * the listener when it isn't that the model was too slow. */
export class GaveUp extends Error {
  constructor(
    message: string,
    readonly why?: string,
  ) {
    super(message);
  }
}

/** The next set being picked, if any, and the wait for the model. */
export class NextSet {
  #gen = 0;
  #picking: Promise<void> | null = null;
  #rushing: ((why?: string) => void) | null = null;
  readonly #onWaiting: (waiting: boolean) => void;

  /** `onWaiting` hears whenever a wait for the model can, or no longer can, be cut short. */
  constructor(onWaiting: (waiting: boolean) => void = () => {}) {
    this.#onWaiting = onWaiting;
  }

  get #rush(): ((why?: string) => void) | null {
    return this.#rushing;
  }

  set #rush(rush: ((why?: string) => void) | null) {
    const was = this.#rushing !== null;
    this.#rushing = rush;
    if (was !== (rush !== null)) this.#onWaiting(rush !== null);
  }

  /** A pick under way. */
  get picking(): boolean {
    return this.#picking !== null;
  }

  /** Whether a wait for the model can be cut short. */
  get waiting(): boolean {
    return this.#rush !== null;
  }

  /** Picks the next set: `pick` can ask whether it's still `wanted` as it goes. What it comes to goes to `done` while
   * it's wanted, and to `dropped` once it's been let go of. */
  pick<T>(pick: (wanted: () => boolean) => Promise<T>, done: (picked: T) => void, dropped: (picked: T) => void) {
    const gen = ++this.#gen;
    const wanted = () => gen === this.#gen;
    this.#picking = pick(wanted).then((picked) => {
      if (!wanted()) return dropped(picked);
      this.#picking = null;
      done(picked);
    });
  }

  /** Lets go of the pick under way: whatever it comes to is dropped, and its wait for the model isn't one to cut
   * short any more. */
  letGo() {
    this.#gen++;
    this.#picking = null;
    this.#rush = null;
  }

  /** Waits for the model's `answer`, up to `timeoutMs`, or until `hurry`: then with `GaveUp`. A newer wait takes the
   * hurry over. */
  wait<T>(answer: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Over once given up on, or answered: there's nothing more to cut short.
      const over = () => {
        clearTimeout(t);
        if (this.#rush === rush) this.#rush = null;
      };
      const t = setTimeout(() => (over(), reject(new GaveUp("the model took too long"))), timeoutMs);
      const rush = (why?: string) => (over(), reject(new GaveUp("the music can't wait", why)));
      this.#rush = rush;
      answer.then(resolve, reject).finally(over);
    });
  }

  /** The music can't wait: the model isn't waited for any longer, and the set comes from a template. `why` tells the
   * listener, when it's for them to know (they didn't want to wait). */
  hurry(why?: string) {
    this.#rush?.(why);
  }

  /** The session stopped: nothing picked or waited for, for the next one to start from. */
  reset() {
    this.letGo();
    this.#rush = null;
  }
}

/** How much of a set is in the player's queue: none, its songs on their way, all of them, or none: refused. */
export type Queued = "no" | "pending" | "done" | "failed";

/** The next set's songs in the player's queue, after the last song of the set playing, so it follows without a gap.
 * What it knows is about the set it was given: any other reads as not queued. Its changes to the player's queue go
 * one after another, so what's taken out is out before anything else goes in. */
export class SetQueue<S> {
  #queued: { set: S; state: Exclude<Queued, "no"> } | null = null;
  #adding: S | null = null;
  #changes: Promise<void> = Promise.resolve();

  /** How much of `set` is in the player's queue. */
  of(set: S | null): Queued {
    return this.#queued && this.#queued.set === set ? this.#queued.state : "no";
  }

  /** The set whose songs are on their way into the player's queue. One that comes in before they're all there still
   * gets the rest. */
  get adding(): S | null {
    return this.#adding;
  }

  /** Nothing queued, and nothing on its way. */
  get idle(): boolean {
    return !this.#queued && !this.#adding;
  }

  /** Settles once the changes on their way to the player's queue have landed. */
  get settled(): Promise<void> {
    return this.#changes;
  }

  /** Puts `set`'s songs (`uris`) in the player's queue with `add`, one after another, after the changes on their way. */
  add(set: S, uris: readonly string[], add: (uri: string) => Promise<unknown>) {
    this.#queued = { set, state: "pending" };
    this.#adding = set;
    this.#changes = this.#changes.then(() => this.#add(set, uris, add));
  }

  async #add(set: S, uris: readonly string[], add: (uri: string) => Promise<unknown>) {
    try {
      for (const uri of uris) {
        // Let go of while it waited its turn, or since: the rest of it isn't wanted.
        if (this.#adding !== set) return;
        await add(uri);
      }
      // Taken out, forgotten or queued over meanwhile: then it's not this set's to say.
      if (this.#queued?.set === set) this.#queued.state = "done";
    } catch (e) {
      console.warn("DJ: couldn't queue the next set:", e);
      if (this.#queued?.set === set) this.#queued.state = "failed";
    } finally {
      // Done with it: nothing is on its way into the queue any more.
      if (this.#adding === set) this.#adding = null;
    }
  }

  /** Takes `set` back out: what's on its way stops, and what made it in comes out through `clear` (none when the
   * player is elsewhere), before anything else goes in. */
  remove(set: S | null, clear: (() => Promise<unknown>) | null) {
    if (this.#adding === set) this.#adding = null;
    if (clear && this.of(set) !== "no") this.#changes = this.#changes.then(() => clear().then(() => {}, () => {}));
    this.#queued = null;
  }

  /** Nothing of the set is in the player's queue any more (it was cleared, or the session ended), and none of the
   * rest goes in. */
  forget() {
    this.#queued = null;
    this.#adding = null;
  }
}
