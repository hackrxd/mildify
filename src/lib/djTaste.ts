// What the listener showed the DJ this session: the songs they skipped and liked, and which of those the model
// has heard about.
import type { Candidate, Reactions } from "./djPicks";

/** How many recent likes and skips are kept, for the model to go by. */
const KEPT = 10;
/** A skipped song's artist sits out this many of the sets picked after the skip. */
export const SIT_OUT_SETS = 2;
/** Skipped this many times in a session, an artist sits out the rest of it. */
export const SKIPS_TO_SIT_OUT = 2;

export class SessionTaste {
  /** Skipped songs, most recent first. */
  skippedSongs: Candidate[] = [];
  /** Songs liked while the DJ played them, most recent first. */
  liked: Candidate[] = [];
  /** Likes and skips the model has been told about already, so each prompt says only what's new. */
  #told = new Set<string>();
  /** Whether each song was in the listener's library when last looked, to notice a new like. */
  #likeSeen = new Map<string, boolean>();
  /** Each skipped song's main artist, with how many sets had been picked at each of their skips. */
  #skipsOf = new Map<string, number[]>();

  /** The listener skipped `song` when `sets` sets had been picked, or were being picked. False when it's the skip
   * just recorded (the same leave seen twice), so a skip is counted once. */
  skipped(song: Candidate, sets = 0): boolean {
    if (this.skippedSongs[0]?.uri === song.uri) return false;
    const main = song.artists[0];
    if (main) this.#skipsOf.set(main, [...(this.#skipsOf.get(main) ?? []), sets]);
    this.skippedSongs = [song, ...this.skippedSongs.filter((s) => s.uri !== song.uri)].slice(0, KEPT);
    return true;
  }

  /** Takes back a skip of `song`, and its artist's latest skip; whether there was one. */
  forgive(song: Candidate): boolean {
    if (!this.skippedSongs.some((s) => s.uri === song.uri)) return false;
    this.skippedSongs = this.skippedSongs.filter((s) => s.uri !== song.uri);
    const main = song.artists[0];
    const left = this.#skipsOf.get(main)?.slice(0, -1) ?? [];
    if (left.length) this.#skipsOf.set(main, left);
    else this.#skipsOf.delete(main);
    return true;
  }

  /** Only `sets` sets count as picked now, some let go of unheard: a skip counted among the sets picked before it
   * no more than there are. */
  recount(sets: number) {
    for (const [artist, skips] of this.#skipsOf) this.#skipsOf.set(artist, skips.map((n) => Math.min(n, sets)));
  }

  /** The artists sitting out when `sets` sets have been picked: a skipped song's main artist for the next
   * SIT_OUT_SETS sets after the skip, and for the rest of the session once they're skipped SKIPS_TO_SIT_OUT times.
   * A featured artist doesn't sit out: the DJ's memory weighs their skips lightly instead. */
  sittingOut(sets: number): Set<string> {
    const out = new Set<string>();
    for (const [artist, skips] of this.#skipsOf) {
      if (skips.length >= SKIPS_TO_SIT_OUT || sets < skips[skips.length - 1] + SIT_OUT_SETS) out.add(artist);
    }
    return out;
  }

  /** Looks at whether each song is liked now (`has`: undefined while unknown); the ones newly liked. A song
   * liked already when first seen isn't new. */
  noticeLikes(songs: Candidate[], has: (uri: string) => boolean | undefined): Candidate[] {
    const fresh: Candidate[] = [];
    for (const s of songs) {
      const now = has(s.uri);
      if (now === undefined) continue;
      const was = this.#likeSeen.get(s.uri);
      this.#likeSeen.set(s.uri, now);
      if (was === false && now) {
        this.liked = [s, ...this.liked.filter((l) => l.uri !== s.uri)].slice(0, KEPT);
        fresh.push(s);
      }
    }
    return fresh;
  }

  /** Likes and skips no answer from the model has gone by yet. */
  news(): Reactions {
    const fresh = (kind: string, songs: Candidate[]) => songs.filter((s) => !this.#told.has(kind + s.uri));
    return { liked: fresh("liked:", this.liked), skipped: fresh("skipped:", this.skippedSongs) };
  }

  /** The model answered with these in mind: later prompts leave them out. */
  toldOf(news: Reactions) {
    for (const s of news.liked) this.#told.add("liked:" + s.uri);
    for (const s of news.skipped) this.#told.add("skipped:" + s.uri);
  }
}
