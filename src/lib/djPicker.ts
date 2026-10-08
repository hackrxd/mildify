// The model's round for a set: what it looks up first, what it picks, and why there's no pick when there isn't.
import {
  lookUpMessages,
  lookUpsAsked,
  lookUpTool,
  readAnswer,
  segmentMessages,
  segmentSchema,
  songFacts,
  type Pick,
  type SegmentAsk,
} from "./djTalk";
import { vocals, type Vocals } from "./djTiming";
import { backend, errorMessage, type DjSongInfo } from "./ipc";
import { lyrics } from "./lyrics.svelte";
import { idFromUri } from "./util";

/** The DJ stopped waiting for its model: too slow, or the music couldn't wait. Not something to fix. */
export class GaveUp extends Error {}

/** What was found about the songs the model asked after: lines for its prompt, and the facts, by song URI. */
export interface LookedUp {
  lines: string[];
  found: Map<string, DjSongInfo>;
}

/** Lets the model ask about some of the songs before it picks. Nothing found, or no look-up, goes on without. */
export async function lookUp(ask: SegmentAsk): Promise<LookedUp | null> {
  try {
    const answer = await backend.djLookUp(lookUpMessages(ask), [lookUpTool(ask.choices.length)], 300);
    const asked = lookUpsAsked(answer.calls, ask.choices);
    if (!asked.length) return null;
    const infos = await backend.djSongInfo(
      asked.map((c) => ({ uri: c.uri, name: c.name, artist: c.artists[0] ?? "", artist_id: c.artistIds?.[0] ?? null })),
    );
    const byUri = new Map(infos.map((info) => [info.uri, info]));
    const lines: string[] = [];
    const found = new Map<string, DjSongInfo>();
    for (const c of asked) {
      const info = byUri.get(c.uri);
      if (!info) continue;
      lines.push(songFacts(ask.choices.indexOf(c) + 1, c, info));
      found.set(c.uri, info);
    }
    return lines.length ? { lines, found } : null;
  } catch (e) {
    console.warn("DJ: couldn't look songs up, picking without:", e);
    return null;
  }
}

export interface ModelRound {
  pick: Pick | null;
  /** Why there's no pick from the model, when there isn't. */
  why: string | null;
  /** A failure the listener can do something about (a refused key, no credit), to tell them. */
  trouble: string | null;
  /** What the model looked up, by song URI. */
  found: Map<string, DjSongInfo>;
}

/** Asks the model for its pick from `ask`, after any look-ups it wants when it can call tools. `wait` bounds the
 * whole round (a timeout, or the music that can't wait any longer, rejecting with `GaveUp`); `stale` says the
 * set isn't wanted any more, so nothing more is asked once it isn't. */
export async function askModel(
  ask: SegmentAsk,
  opts: { tools: boolean; wait: <T>(round: Promise<T>) => Promise<T>; stale: () => boolean },
): Promise<ModelRound> {
  // Given up on (too slow, or the music can't wait): what's still on its way isn't asked for.
  let gaveUp = false;
  let found = new Map<string, DjSongInfo>();
  try {
    const answer = await opts.wait(
      (async () => {
        // A model that can call tools may look some of the songs up first.
        const looked = opts.tools ? await lookUp(ask) : null;
        if (gaveUp || opts.stale()) throw new GaveUp("given up");
        if (looked) found = looked.found;
        return backend.djGenerate(segmentMessages({ ...ask, lookedUp: looked?.lines }), segmentSchema(ask.choices.length), 300);
      })(),
    );
    const pick = readAnswer(answer, ask.choices, ask.segment, { opening: ask.opening ?? !ask.previous, topUp: ask.topUp });
    if (pick) return { pick, why: null, trouble: null, found };
    console.warn("DJ: the model's answer wasn't usable", answer);
    return { pick: null, why: "the model's answer wasn't usable", trouble: null, found };
  } catch (e) {
    gaveUp = true;
    console.warn("DJ: no answer from the model, talking from a template:", e);
    if (e instanceof GaveUp) return { pick: null, why: "the model didn't answer in time", trouble: null, found };
    // Not wanted any more: its ask was dropped for a newer one, which is nothing for the listener to fix.
    if (opts.stale()) return { pick: null, why: "the set isn't wanted any more", trouble: null, found };
    const why = errorMessage(e);
    return { pick: null, why, trouble: why, found };
  }
}

/** Where a song's singing starts and ends, as heard: with the listener's own timing nudge for it. */
export async function songVocals(uri: string): Promise<Vocals | null> {
  try {
    const id = idFromUri(uri);
    const v = vocals(await backend.lyrics(id));
    const shift = lyrics.songOffsets[id] ?? 0;
    return v && { first: v.first + shift, last: v.last + shift };
  } catch {
    return null;
  }
}
