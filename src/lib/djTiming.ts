// When the AI DJ talks, worked out from the songs' lyrics. The DJ's talk is an item of its own between two
// songs, as long as the line takes. At its edges it can overlap the songs: it may start over the last few
// seconds of the finishing song once its singer has stopped, and the next song may come in under its last
// few seconds, early enough that the DJ is done before anyone sings. A synced lyric's first line is where the
// next song's vocals start; the last line's end is where the finishing song's stop. Without a sync, or with
// too short an intro, the next song starts after the DJ. Either overlap can be turned off.
//
// Also turns a spoken line's sentence timings into lyric lines, so the captions use the same lines and
// syllable sweep as the lyrics.

import type { DjSentence } from "./ipc";
import { lyricLines, type LyricLine } from "./lyricLines";

/** Talk stops this long before a singer starts, and starts this long after one stops. */
export const VOCAL_GAP_MS = 700;
/** Without a sync, the DJ assumes the finishing song's last few seconds are free to talk over. */
export const UNKNOWN_OUTRO_MS = 3000;
/** The most the DJ talks over either song: its talk stays an item of its own. */
export const MAX_OVER_INTRO_MS = 5000;
export const MAX_OVER_OUTRO_MS = 5000;
/** The next song only comes in under the voice when at least this much of its intro is free to talk over. */
export const MIN_OVER_INTRO_MS = 1500;
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
  /** How long the DJ talks on its own between the two songs. */
  hold: number;
  /** How far into the line the next song starts. */
  musicAt: number;
  /** How much of the line is said over the next song's intro. */
  overIntro: number;
}

export interface TalkAsk {
  speechMs: number;
  /** The songs' vocals; null without a synced lyric. */
  next: Vocals | null;
  old: Vocals | null;
  /** How much of the finishing song is left now; 0 when nothing is playing. */
  oldLeftMs: number;
  oldDurationMs: number;
  /** Settings → AI DJ: the next song may start under the end of the talk. */
  overStart?: boolean;
  /** Settings → AI DJ: the talk may start over the end of the finishing song. */
  overEnd?: boolean;
}

/** Plans the DJ's talk between two songs. */
export function planTalk(p: TalkAsk): TalkPlan {
  // The end of the line that fits over the next song's intro, before its singer comes in.
  const room = p.overStart !== false && p.next ? p.next.first - VOCAL_GAP_MS : 0;
  const overIntro = room >= MIN_OVER_INTRO_MS ? Math.min(room, p.speechMs, MAX_OVER_INTRO_MS) : 0;
  const musicAt = Math.max(0, p.speechMs - overIntro);
  // Room at the end of the finishing song, after its singer is done.
  const outroRoom =
    p.overEnd === false ? 0 : p.old ? Math.max(0, p.oldDurationMs - p.old.last - VOCAL_GAP_MS) : UNKNOWN_OUTRO_MS;
  const overOld = Math.round(Math.min(musicAt, outroRoom, MAX_OVER_OUTRO_MS, Math.max(0, p.oldLeftMs)));
  return {
    overOld,
    hold: Math.round(musicAt - overOld),
    musicAt: Math.round(musicAt),
    overIntro: Math.round(p.speechMs - musicAt),
  };
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
