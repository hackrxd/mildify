// A set picked as it goes: how the one playing is going, which steers what's lined up next in it.

import type { Candidate } from "./djPicks";

/** How the set playing is going. Each set starts afresh as it comes in, and so does a new session. */
export class SetProgress {
  /** Songs of it the listener skipped: enough of them, and it changes direction. */
  skips = 0;
  /** It ends with the song playing: nothing more is lined up after it, and the next set gets picked. */
  ends = false;
  /** The song lined up next is to be picked again, for a like since. */
  repick = false;
  /** Songs liked while it plays, the latest first: they steer its next picks. Older likes are the model's to weigh. */
  liked: Candidate[] = [];
  /** Where a Next or Previous sent in it is headed, while the player gets there. */
  heading: { uri: string; at: number } | null = null;

  /** The listener liked `song`: what's next leans toward it, and the song lined up next is picked again. */
  like(song: Candidate) {
    this.liked = [song, ...this.liked.filter((l) => l.uri !== song.uri)];
    this.repick = true;
  }

  /** A skip of one of its songs is taken back. */
  unskip() {
    this.skips = Math.max(0, this.skips - 1);
  }
}
