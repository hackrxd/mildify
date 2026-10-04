// When the AI DJ talks, worked out from the songs' lyrics: it talks over the end of the song that's
// finishing and the start of the next, but not over anyone singing. A synced lyric's first line is where
// the next song's vocals start; the last line's end is where the finishing song's stop. When a line is
// longer than both gaps, the next song waits while the DJ finishes.
//
// Also turns a spoken line's sentence timings into lyric lines, so the captions use the same lines and
// syllable sweep as the lyrics.

import type { DjSentence } from "./ipc";
import { lyricLines, type LyricLine } from "./lyricLines";

/** Talk stops this long before a singer starts, and starts this long after one stops. */
export const VOCAL_GAP_MS = 700;
/** Without a sync, the DJ assumes the finishing song's last few seconds are free to talk over. */
export const UNKNOWN_OUTRO_MS = 3000;
/** The music under the DJ's voice. */
export const DUCK_LEVEL = 0.22;
export const DUCK_DOWN_MS = 450;
export const DUCK_UP_MS = 1400;

export interface Vocals {
  /** ms from the start of the song */
  first: number;
  last: number;
}

/** Where a song's vocals start and end, from its lyrics; null without a synced lyric. */
export function vocals(lyrics: unknown): Vocals | null {
  const lines = lyricLines(lyrics);
  if (!lines.length) return null;
  return { first: lines[0].start, last: Math.max(...lines.map((l) => l.end)) };
}

export interface TalkPlan {
  /** How long before the finishing song ends the DJ starts talking. */
  overOld: number;
  /** How long the next song waits after the finishing one ends, while the DJ talks on. */
  hold: number;
}

/**
 * Plans the talk between two songs. `oldLeftMs` is how much of the finishing song is left now (0 when
 * nothing is playing); the vocals are null when there's no synced lyric.
 */
export function planTalk(p: { speechMs: number; next: Vocals | null; old: Vocals | null; oldLeftMs: number; oldDurationMs: number }): TalkPlan {
  // Talk that fits over the next song's intro, before its singer comes in.
  const overIntro = p.next ? Math.max(0, p.next.first - VOCAL_GAP_MS) : 0;
  const needBefore = Math.max(0, p.speechMs - overIntro);
  // Room at the end of the finishing song, after its singer is done.
  const outroRoom = p.old ? Math.max(0, p.oldDurationMs - p.old.last - VOCAL_GAP_MS) : UNKNOWN_OUTRO_MS;
  const overOld = Math.round(Math.min(needBefore, outroRoom, Math.max(0, p.oldLeftMs)));
  return { overOld, hold: Math.round(needBefore - overOld) };
}

/** A spoken line's sentences as lyric lines, each word a syllable timed by its share of the letters. */
export function captionLines(sentences: DjSentence[]): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const s of sentences) {
    const words = s.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const span = Math.max(0, s.end_ms - s.start_ms);
    const total = words.reduce((n, w) => n + w.length, 0);
    let at = s.start_ms;
    const syllables = words.map((text) => {
      const start = at;
      at += (span * text.length) / total;
      return { start, end: at, text, partOfWord: false };
    });
    lines.push({ start: s.start_ms, end: s.end_ms, text: s.text, syllables });
  }
  return lines;
}

/** The gain librespot's default volume curve gives a slider position, so the voice sits with the music. */
export function volumeGain(percent: number): number {
  const v = Math.max(0, Math.min(100, percent)) / 100;
  return v === 0 ? 0 : Math.pow(1000, v - 1);
}
