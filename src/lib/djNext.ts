// The set after the one playing, on its way: picked one at a time, a newer pick making the one under way stale (a
// request, a skipped set), with the wait for the model cut short when the music can't wait for it.

/** The DJ stopped waiting for its model: too slow, or the music couldn't wait. Not something to fix. */
export class GaveUp extends Error {}

/** The next set being picked, if any, and the wait for the model. */
export class NextSet {
  #gen = 0;
  #picking: Promise<void> | null = null;
  #rush: (() => void) | null = null;

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

  /** Lets go of the pick under way: whatever it comes to is dropped. */
  letGo() {
    this.#gen++;
    this.#picking = null;
  }

  /** Waits for the model's `answer`, up to `timeoutMs`, or until `hurry`: then with `GaveUp`. A newer wait takes the
   * hurry over. */
  wait<T>(answer: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new GaveUp("the model took too long")), timeoutMs);
      const rush = () => reject(new GaveUp("the music can't wait"));
      this.#rush = rush;
      answer.then(resolve, reject).finally(() => {
        clearTimeout(t);
        if (this.#rush === rush) this.#rush = null;
      });
    });
  }

  /** The music can't wait: the model isn't waited for any longer, and the set comes from a template. */
  hurry() {
    this.#rush?.();
  }

  /** A new session: nothing picked or waited for. */
  reset() {
    this.letGo();
    this.#rush = null;
  }
}
