// What the listener showed the DJ this session: the songs they skipped and liked, and which of those the model
// has heard about.
import type { Candidate, Reactions } from "./djPicks";

/** How many recent likes and skips are kept, for the model to go by. */
const KEPT = 10;

export class SessionTaste {
  /** Artists of songs the listener skipped: left out of what's picked. */
  skippedArtists = new Set<string>();
  /** Skipped songs, most recent first. */
  skippedSongs: Candidate[] = [];
  /** Songs liked while the DJ played them, most recent first. */
  liked: Candidate[] = [];
  /** Likes and skips the model has been told about already, so each prompt says only what's new. */
  #told = new Set<string>();
  /** Whether each song was in the listener's library when last looked, to notice a new like. */
  #likeSeen = new Map<string, boolean>();

  /** The listener skipped `song`. False when it's the skip just recorded (the same leave seen twice), so a skip
   * is counted once. */
  skipped(song: Candidate): boolean {
    if (this.skippedSongs[0]?.uri === song.uri) return false;
    for (const a of song.artists) this.skippedArtists.add(a);
    this.skippedSongs = [song, ...this.skippedSongs.filter((s) => s.uri !== song.uri)].slice(0, KEPT);
    return true;
  }

  /** Takes back a skip of `song`; whether there was one. An artist sits out only while a skip of theirs stands. */
  forgive(song: Candidate): boolean {
    if (!this.skippedSongs.some((s) => s.uri === song.uri)) return false;
    this.skippedSongs = this.skippedSongs.filter((s) => s.uri !== song.uri);
    for (const a of song.artists) if (!this.skippedSongs.some((s) => s.artists.includes(a))) this.skippedArtists.delete(a);
    return true;
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
