// Synced lines (and syllables, when the sync has them) from a lyrics service response, for
// the one-line lyric in the player bar. The full renderer has its own pipeline; this only
// needs text and times.

export interface Syllable {
  /** ms */
  start: number;
  /** ms */
  end: number;
  text: string;
  /** Joined to the next syllable without a space. */
  partOfWord: boolean;
}

export interface LyricLine {
  /** ms */
  start: number;
  /** ms */
  end: number;
  text: string;
  /** Present when the lyrics are synced per syllable. */
  syllables?: Syllable[];
}

/** A gap between lines shorter than this keeps the previous line up, rather than blinking out. */
export const HOLD_GAP_MS = 3000;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

function clean(text: unknown): string {
  return typeof text === "string" ? text.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim() : "";
}

function syllables(raw: unknown): Syllable[] {
  if (!Array.isArray(raw)) return [];
  const out: Syllable[] = [];
  for (const s of raw as { Text?: unknown; StartTime?: unknown; EndTime?: unknown; IsPartOfWord?: unknown }[]) {
    const text = clean(s?.Text);
    if (!text || typeof s?.StartTime !== "number" || typeof s?.EndTime !== "number") continue;
    out.push({
      start: s.StartTime * 1000,
      end: Math.max(s.StartTime, s.EndTime) * 1000,
      text,
      partOfWord: !!s.IsPartOfWord,
    });
  }
  return out;
}

function joined(syllables: Syllable[]): string {
  return clean(syllables.map((s) => s.text + (s.partOfWord ? "" : " ")).join(""));
}

/**
 * Lead-vocal lines of a Spicy Lyrics v1 response (`{ Body: … }` or the body itself),
 * sorted by start time. Static (unsynced) lyrics and unknown shapes give none.
 */
export function lyricLines(response: unknown): LyricLine[] {
  const r = response as { Body?: unknown } | null | undefined;
  const body = (r?.Body ?? r) as { Type?: unknown; Content?: unknown } | null | undefined;
  if (!body || !Array.isArray(body.Content)) return [];
  const lines: LyricLine[] = [];
  for (const item of body.Content as Record<string, any>[]) {
    let start: unknown, end: unknown, text: string;
    let syls: Syllable[] | undefined;
    if (body.Type === "Syllable") {
      start = item?.Lead?.StartTime;
      end = item?.Lead?.EndTime;
      syls = syllables(item?.Lead?.Syllables);
      text = joined(syls);
    } else if (body.Type === "Line") {
      start = item?.StartTime;
      end = item?.EndTime;
      text = clean(item?.Text);
    } else {
      return [];
    }
    if (!text || typeof start !== "number" || typeof end !== "number") continue;
    const line: LyricLine = { start: start * 1000, end: Math.max(start, end) * 1000, text };
    if (syls?.length) line.syllables = syls;
    lines.push(line);
  }
  return lines.sort((a, b) => a.start - b.start);
}

/**
 * Index of the line showing at `ms`, or -1 between lines. A line stays up until the
 * next one starts when the gap is short, and goes away at its end before a long one.
 */
export function lineAt(lines: LyricLine[], ms: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= ms) {
      i = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (i < 0) return -1;
  return ms < shownUntil(lines, i) ? i : -1;
}

/** When the line at `i` stops showing. */
export function shownUntil(lines: LyricLine[], i: number): number {
  const { end } = lines[i];
  const next = lines[i + 1]?.start;
  return next !== undefined && next - end < HOLD_GAP_MS ? Math.max(end, next) : end;
}

/** How much of a syllable has been sung at `ms`, from 0 to 1. */
export function sung(s: Syllable, ms: number): number {
  if (ms >= s.end) return 1;
  if (ms <= s.start) return 0;
  return (ms - s.start) / (s.end - s.start);
}

/** The next time at or after `ms` when `lineAt` can change, or Infinity after the last line. */
export function nextChange(lines: LyricLine[], ms: number): number {
  const i = lineAt(lines, ms);
  if (i >= 0) return shownUntil(lines, i);
  return lines.find((l) => l.start > ms)?.start ?? Infinity;
}

/** A pause at least this long between synced lines starts a new verse in `lyricsText`. */
export const VERSE_GAP_MS = 4000;

/** Like the renderer's PickDisplayText: the romanization when asked for and present. */
function display(entry: { Text?: unknown; TransliteratedText?: unknown } | null | undefined, romanized: boolean): string {
  const roman = clean(entry?.TransliteratedText);
  if (romanized && roman) return roman;
  return clean(entry?.Text) || roman;
}

function groupText(group: { Syllables?: unknown } | null | undefined, romanized: boolean): string {
  if (!Array.isArray(group?.Syllables)) return "";
  const syls = group.Syllables as { Text?: unknown; TransliteratedText?: unknown; IsPartOfWord?: unknown }[];
  return clean(syls.map((s) => display(s, romanized) + (s?.IsPartOfWord ? "" : " ")).join(""));
}

/**
 * The lyrics of a Spicy Lyrics v1 response as plain text, one line per row and a blank row
 * between verses. Background vocals follow their line in parentheses. Empty for unknown shapes.
 */
export function lyricsText(response: unknown, romanized = false): string {
  const r = response as { Body?: unknown } | null | undefined;
  const body = (r?.Body ?? r) as { Type?: unknown; Content?: unknown; Lines?: unknown } | null | undefined;
  const rows: string[] = [];
  const verse = () => rows.length && rows[rows.length - 1] !== "" && rows.push("");

  if (body?.Type === "Static" && Array.isArray(body.Lines)) {
    // Static lyrics mark verses with empty lines.
    for (const line of body.Lines as { Text?: unknown; TransliteratedText?: unknown }[]) {
      const text = display(line, romanized);
      if (text) rows.push(text);
      else verse();
    }
  } else if ((body?.Type === "Line" || body?.Type === "Syllable") && Array.isArray(body.Content)) {
    const lines: { start: number; end: number; text: string }[] = [];
    for (const item of body.Content as Record<string, any>[]) {
      const timed = body.Type === "Syllable" ? item?.Lead : item;
      let text = body.Type === "Syllable" ? groupText(item?.Lead, romanized) : display(item, romanized);
      if (body.Type === "Syllable" && Array.isArray(item?.Background)) {
        const bg = (item.Background as unknown[])
          .map((g) => groupText(g as { Syllables?: unknown }, romanized))
          .filter(Boolean)
          .join(" ");
        if (bg) text = text ? `${text} (${bg})` : `(${bg})`;
      }
      if (!text || typeof timed?.StartTime !== "number") continue;
      const start = timed.StartTime * 1000;
      const end = typeof timed.EndTime === "number" ? Math.max(timed.StartTime, timed.EndTime) * 1000 : start;
      lines.push({ start, end, text });
    }
    lines.sort((a, b) => a.start - b.start);
    lines.forEach((line, i) => {
      if (i > 0 && line.start - lines[i - 1].end >= VERSE_GAP_MS) verse();
      rows.push(line.text);
    });
  }

  if (rows[rows.length - 1] === "") rows.pop();
  return rows.join("\n");
}
