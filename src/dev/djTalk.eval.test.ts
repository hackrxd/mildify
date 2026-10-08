// @vitest-environment node
// How the DJ's talk comes out of a real model, for comparing prompt changes. Skipped unless DJ_EVAL_URL names an
// OpenAI-compatible server: llama-server running the downloaded model, Ollama's, or the like.
//   DJ_EVAL_URL=http://127.0.0.1:8080 npx vitest run src/dev/djTalk.eval.test.ts --silent=false
// DJ_EVAL_MODEL names the model (default "dj", as the app's own server calls it), DJ_EVAL_KEY its key if it has one.
// Run it before and after a change and compare what it prints.
import { describe, expect, it } from "vitest";
import { SEGMENTS, type Candidate } from "../lib/djPicks";
import { readAnswer, segmentMessages, segmentSchema, type Pick, type SegmentAsk } from "../lib/djTalk";

// The app's types leave Node out; this file runs in it.
declare const process: { env: Record<string, string | undefined> };

const URL = process.env.DJ_EVAL_URL?.replace(/\/+$/, "");
const SETS = 8;

const ARTISTS = ["M83", "Phoenix", "Beach House", "Röyksopp", "Air", "Justice", "Tame Impala", "Caribou", "Washed Out", "Chvrches"];
const TITLES = ["Midnight City", "Lisztomania", "Space Song", "Eple", "La Femme d'Argent", "D.A.N.C.E.", "Let It Happen", "Odessa"];

/** A dozen songs for a set to choose from, with the facts the DJ goes by. */
function choices(set: number): Candidate[] {
  return Array.from({ length: 12 }, (_, i) => ({
    uri: `spotify:track:s${set}c${i}`,
    name: `${TITLES[(set + i) % TITLES.length]}${i >= TITLES.length ? " (Remix)" : ""}`,
    artists: [ARTISTS[(set * 3 + i) % ARTISTS.length]],
    album: "",
    year: String(2005 + ((set + i) % 18)),
    durationMs: 210_000,
    explicit: false,
    reasons: [i % 3 === 0 ? "onRepeat" : i % 3 === 1 ? "favorite" : "allTime"],
    likedAt: i % 2 ? new Date(2021, i % 12, 3) : null,
    playedAt: new Date(Date.now() - (i + 1) * 86_400_000),
  }));
}

/** The model's answer to a set's question, as the app asks it (chat.rs `openai_body`). */
async function ask(a: SegmentAsk): Promise<unknown> {
  const res = await fetch(`${URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.DJ_EVAL_KEY ? { authorization: `Bearer ${process.env.DJ_EVAL_KEY}` } : {}) },
    body: JSON.stringify({
      model: process.env.DJ_EVAL_MODEL ?? "dj",
      messages: segmentMessages(a),
      stream: false,
      temperature: 0.8,
      max_tokens: 300,
      response_format: { type: "json_schema", json_schema: { name: "dj_segment", strict: true, schema: segmentSchema(a.choices.length) } },
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(body.choices[0].message.content);
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const opening = (t: string) => t.toLowerCase().split(/\s+/).slice(0, 3).join(" ");
const GREETING = /\b(welcome|hello|hey there|good (morning|afternoon|evening))\b/i;

describe.skipIf(!URL)("the DJ's talk, from a model server", () => {
  it("plays out a show, and says how its talk went", async () => {
    const said: { set: number; pick: Pick | null; raw: unknown }[] = [];
    let previous: Candidate | null = null;
    for (let set = 1; set <= SETS; set++) {
      const a: SegmentAsk = {
        segment: SEGMENTS[(set - 1) % SEGMENTS.length],
        choices: choices(set),
        listener: "Sam",
        previous: previous && { name: previous.name, artists: previous.artists },
        instructions: "",
        opening: set === 1,
        setNumber: set,
        earlier: said.map((s) => s.pick?.talk ?? "").filter(Boolean),
      };
      const raw = await ask(a);
      const pick = readAnswer(raw, a.choices, a.segment);
      said.push({ set, pick, raw });
      previous = pick?.songs.at(-1) ?? null;
    }
    const talks = said.flatMap((s) => (s.pick ? [s.pick] : []));
    const counts = talks.map((p) => words(p.talk));
    const report = {
      usable: `${talks.length} of ${SETS}`,
      "words per talk": counts.length ? `${Math.min(...counts)}–${Math.max(...counts)}, ${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)} on average` : "-",
      "over 50 words": counts.filter((n) => n > 50).length,
      "name the first song": talks.filter((p) => p.talk.toLowerCase().includes(p.songs[0].name.toLowerCase())).length,
      "different openings": new Set(talks.map((p) => opening(p.talk))).size,
      "greet after the opening": said.filter((s) => s.set > 1 && s.pick && GREETING.test(s.pick.talk)).length,
    };
    console.table(report);
    for (const s of said) console.log(`${s.set}. ${s.pick ? `${s.pick.name}: ${s.pick.talk}` : `unusable: ${JSON.stringify(s.raw)}`}`);
    expect(talks.length).toBeGreaterThan(0);
  }, 600_000);
});
