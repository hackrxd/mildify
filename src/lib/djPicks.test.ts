import { describe, expect, it } from "vitest";
import {
  buildPool,
  choicesFor,
  cleanTalk,
  facts,
  fallbackPick,
  INSTRUCTIONS_MAX,
  kinship,
  MAX_CHOICES,
  nextInSet,
  nextSegment,
  readAnswer,
  SEGMENTS,
  segmentMessages,
  segmentSchema,
  SET_MAX,
  shuffled,
  SKIPS_TO_MOVE_ON,
  type Candidate,
  type Listening,
  type SetSoFar,
} from "./djPicks";
import type { Track } from "./types";

const NOW = new Date("2026-10-04T20:30:00");

function track(n: number, artist = `Artist ${n}`, extra: Partial<Track> = {}): Track {
  return {
    id: `t${n}`,
    uri: `spotify:track:t${n}`,
    name: `Song ${n}`,
    duration_ms: 200_000,
    explicit: false,
    artists: [{ id: `a${n}`, name: artist, uri: `spotify:artist:a${n}` }],
    track_number: 1,
    disc_number: 1,
    type: "track",
    album: {
      id: `al${n}`,
      name: `Album ${n}`,
      uri: `spotify:album:al${n}`,
      album_type: "album",
      images: [],
      artists: [],
      release_date: "2011-10-18",
      total_tracks: 10,
    },
    ...extra,
  };
}

function listening(over: Partial<Listening> = {}): Listening {
  return { topShort: [], topMedium: [], topLong: [], recent: [], saved: [], ...over };
}

const seg = (id: string) => SEGMENTS.find((s) => s.id === id)!;
const none = { played: new Set<string>(), skippedArtists: new Set<string>() };

describe("buildPool", () => {
  it("merges every reason a song is there", () => {
    const pool = buildPool(
      listening({
        topShort: [track(1)],
        topLong: [track(1), track(2)],
        recent: [{ track: track(1), played_at: "2026-10-03T10:00:00Z", context: null }],
      }),
      NOW,
    );
    expect(pool).toHaveLength(2);
    const one = pool.find((c) => c.uri === "spotify:track:t1")!;
    expect(one.reasons).toEqual(["onRepeat", "allTime", "recent"]);
    expect(one.playedAt?.toISOString()).toBe("2026-10-03T10:00:00.000Z");
    expect(one.year).toBe("2011");
    expect(one.artists).toEqual(["Artist 1"]);
  });

  it("sorts likes by how long ago they were", () => {
    const pool = buildPool(
      listening({
        topMedium: [track(3)],
        saved: [
          { added_at: "2026-09-20T00:00:00Z", track: track(1) },
          { added_at: "2019-03-02T00:00:00Z", track: track(2) },
          // In between: not a segment, but its date is kept for a song that's there anyway.
          { added_at: "2026-02-01T00:00:00Z", track: track(3) },
        ],
      }),
      NOW,
    );
    const by = (n: number) => pool.find((c) => c.uri === `spotify:track:t${n}`)!;
    expect(by(1).reasons).toEqual(["likedLately"]);
    expect(by(2).reasons).toEqual(["likedLongAgo"]);
    expect(by(3).reasons).toEqual(["favorite"]);
    expect(by(3).likedAt?.getFullYear()).toBe(2026);
  });

  it("leaves out episodes, local files and songs that can't play", () => {
    const episode = { ...track(1), uri: "spotify:episode:e1" };
    const local = { ...track(2), uri: "spotify:local:a:b:c:1" };
    const blocked = track(3, "X", { is_playable: false });
    expect(buildPool(listening({ topShort: [episode, local, blocked, track(4)] }), NOW).map((c) => c.uri)).toEqual([
      "spotify:track:t4",
    ]);
  });
});

function candidates(n: number, reasons: Candidate["reasons"], artist?: (i: number) => string): Candidate[] {
  return Array.from({ length: n }, (_, i) => ({
    uri: `spotify:track:c${i}`,
    name: `Song ${i}`,
    artists: [artist ? artist(i) : `Artist ${i}`],
    album: "",
    year: null,
    durationMs: 1,
    explicit: false,
    reasons: [...reasons],
    likedAt: null,
    playedAt: null,
  }));
}

describe("choicesFor", () => {
  it("leaves out what's been played and artists the listener skipped", () => {
    const pool = candidates(6, ["onRepeat"]);
    const choices = choicesFor(seg("onRepeat"), pool, {
      played: new Set(["spotify:track:c0"]),
      skippedArtists: new Set(["Artist 1"]),
    });
    expect(choices.map((c) => c.uri).sort()).toEqual(["spotify:track:c2", "spotify:track:c3", "spotify:track:c4", "spotify:track:c5"]);
  });

  it("spreads choices across artists and caps them", () => {
    // 30 songs by 3 artists: the first three choices are one by each.
    const pool = candidates(30, ["onRepeat"], (i) => `Artist ${i % 3}`);
    const choices = choicesFor(seg("onRepeat"), pool, none);
    expect(choices).toHaveLength(MAX_CHOICES);
    expect(new Set(choices.slice(0, 3).map((c) => c.artists[0])).size).toBe(3);
  });
});

describe("picking as it goes", () => {
  const song = (id: string, artist: string, over: Partial<Candidate> = {}): Candidate => ({
    ...candidates(1, ["favorite"])[0],
    uri: `spotify:track:${id}`,
    name: id,
    artists: [artist],
    ...over,
  });
  const a = song("a", "Ann");
  const b = song("b", "Bo");
  const c = song("c", "Cy");
  const d = song("d", "Di");
  const ann2 = song("ann2", "Ann", { album: "Ann's album" });
  const ask = (over: Partial<SetSoFar> = {}): SetSoFar => ({
    plan: [a, b, c],
    choices: [d],
    pool: [a, b, c, d, ann2],
    sofar: [a],
    played: new Set([a.uri]),
    skippedArtists: new Set(),
    reactions: { liked: [], skipped: [] },
    skips: 0,
    ...over,
  });

  it("follows the plan when the listener says nothing", () => {
    expect(nextInSet(ask())).toBe(b);
    expect(nextInSet(ask({ sofar: [a, b], played: new Set([a.uri, b.uri]) }))).toBe(c);
  });

  it("ends the set once it's as long as the plan", () => {
    expect(nextInSet(ask({ sofar: [a, b, c] }))).toBeNull();
  });

  it("brings more of a song the listener liked, from anywhere in their listening", () => {
    expect(nextInSet(ask({ reactions: { liked: [a], skipped: [] } }))).toBe(ann2);
  });

  it("leaves out artists the listener skipped, and changes direction after a couple of skips", () => {
    expect(nextInSet(ask({ skippedArtists: new Set(["Bo"]) }))).toBe(c);
    expect(nextInSet(ask({ skips: SKIPS_TO_MOVE_ON }))).toBeNull();
  });

  it("doesn't play the same artist twice running unless asked", () => {
    const bo2 = song("bo2", "Bo");
    expect(nextInSet(ask({ plan: [b, bo2, c], sofar: [b], played: new Set([b.uri]) }))).toBe(c);
  });

  it("ends the set when nothing's left to pick", () => {
    expect(nextInSet(ask({ choices: [], pool: [], played: new Set([a.uri, b.uri, c.uri]) }))).toBeNull();
  });

  it("weighs a song by how close it is to one liked", () => {
    const liked = song("x", "Ann", { album: "Ann's album", year: "2011" });
    expect(kinship(ann2, liked)).toBe(3 + 2 + 1);
    expect(kinship(song("y", "Zed", { year: "2013" }), liked)).toBe(1 + 1);
    expect(kinship(song("z", "Zed", { reasons: ["allTime"] }), liked)).toBe(0);
  });

  it("doesn't take another artist's album of the same name for the same album", () => {
    const hits = song("x", "Ann", { album: "Greatest Hits", year: "2011" });
    const other = song("q", "Queen", { album: "Greatest Hits", year: "2011" });
    expect(kinship(other, hits)).toBe(1 + 1);
    expect(nextInSet(ask({ pool: [other], reactions: { liked: [hits], skipped: [] } }))).not.toBe(other);
  });
});

describe("nextSegment", () => {
  const pool = [
    ...candidates(5, ["onRepeat"]),
    ...candidates(5, ["allTime"]).map((c, i) => ({ ...c, uri: `spotify:track:old${i}` })),
    ...candidates(5, ["likedLately"]).map((c, i) => ({ ...c, uri: `spotify:track:new${i}` })),
  ];

  it("opens with what's on repeat", () => {
    expect(nextSegment([], pool, none)?.id).toBe("onRepeat");
  });

  it("doesn't come back to the last two segments while others are left", () => {
    for (let i = 0; i < 20; i++) {
      const next = nextSegment(["onRepeat", "throwbacks"], pool, none, Math.random);
      expect(["fresh", "rediscover"]).toContain(next?.id);
    }
  });

  it("gives up when nothing has enough songs", () => {
    expect(nextSegment([], candidates(2, ["onRepeat"]), none)).toBeNull();
  });
});

describe("facts", () => {
  it("states only what the listening shows", () => {
    const c: Candidate = {
      ...candidates(1, ["onRepeat", "allTime"])[0],
      likedAt: new Date("2019-03-02T12:00:00"),
      playedAt: new Date("2026-10-02T12:00:00"),
      explicit: true,
    };
    expect(facts(c, NOW)).toEqual([
      "on repeat the last few weeks",
      "one of their most played of all time",
      "last played 2 days ago",
      "liked in March 2019",
      "explicit",
    ]);
  });
});

describe("segmentMessages", () => {
  const choices = candidates(4, ["onRepeat"]);

  it("greets at the start, and numbers the songs with their facts", () => {
    const [system, user] = segmentMessages({ segment: seg("onRepeat"), choices, listener: "Sam", previous: null, instructions: "", now: NOW });
    expect(system.role).toBe("system");
    expect(system.content).not.toContain('"""');
    expect(user.content).toContain("It's Sunday evening. The listener's name is Sam.");
    expect(user.content).toContain("greet the listener first");
    expect(user.content).toContain("1. Song 0 by Artist 0: on repeat the last few weeks");
    expect(user.content).toContain("4. Song 3 by Artist 3");
  });

  it("follows on from the song that's finishing", () => {
    const [, user] = segmentMessages({
      segment: seg("throwbacks"),
      choices,
      listener: null,
      previous: { name: "Midnight City", artists: ["M83"] },
      instructions: "",
      now: NOW,
    });
    expect(user.content).toContain('coming out of "Midnight City" by M83');
    expect(user.content).toContain("a throwback set");
    expect(user.content).not.toContain("name is");
  });

  it("tells the model what the listener just liked and skipped, and to name only the first song when picking as it goes", () => {
    const [, user] = segmentMessages({
      segment: seg("onRepeat"),
      choices,
      listener: null,
      previous: null,
      instructions: "",
      live: true,
      reactions: { liked: [choices[1]], skipped: [choices[2], choices[3]] },
      now: NOW,
    });
    expect(user.content).toContain('the listener liked "Song 1" by Artist 1.');
    expect(user.content).toContain('They skipped "Song 2" by Artist 2; "Song 3" by Artist 3.');
    expect(user.content).toContain("Name only the first song");
    const [, plain] = segmentMessages({ segment: seg("onRepeat"), choices, listener: null, previous: null, instructions: "", now: NOW });
    expect(plain.content).not.toContain("liked \"");
    expect(plain.content).not.toContain("Name only the first song");
  });

  it("passes on the listener's instructions, fenced and capped", () => {
    const long = "Talk like a pirate. " + "x".repeat(INSTRUCTIONS_MAX * 2);
    const [system] = segmentMessages({ segment: seg("onRepeat"), choices, listener: null, previous: null, instructions: `  ${long}  `, now: NOW });
    expect(system.content).toContain('"""\nTalk like a pirate.');
    expect(system.content.length).toBeLessThan(3000);
  });
});

describe("segmentSchema", () => {
  it("lists properties in the order llama.cpp writes them: name, songs, talk", () => {
    const schema = segmentSchema(12) as { properties: Record<string, { maximum?: number; items?: { maximum: number } }> };
    expect(Object.keys(schema.properties)).toEqual(["name", "songs", "talk"]);
    expect(Object.keys(schema.properties).slice().sort()).toEqual(Object.keys(schema.properties));
    expect(schema.properties.songs.items?.maximum).toBe(12);
  });
});

describe("readAnswer", () => {
  const choices = candidates(6, ["onRepeat"]);

  it("maps numbers to songs, dropping repeats and ones out of range", () => {
    const pick = readAnswer({ name: "Late night", songs: [3, 3, 9, 1, 0, 2.5, 6], talk: "Here's Song 2 by Artist 2." }, choices, seg("onRepeat"));
    expect(pick?.songs.map((c) => c.name)).toEqual(["Song 2", "Song 0", "Song 5"]);
    expect(pick?.name).toBe("Late night");
  });

  it("keeps a set to its length", () => {
    const pick = readAnswer({ name: "x", songs: [1, 2, 3, 4, 5, 6], talk: "Plenty of songs now." }, choices, seg("onRepeat"));
    expect(pick?.songs).toHaveLength(SET_MAX);
  });

  it("refuses answers it can't use", () => {
    expect(readAnswer(null, choices, seg("onRepeat"))).toBeNull();
    expect(readAnswer({ songs: [1], talk: "Only one song here." }, choices, seg("onRepeat"))).toBeNull();
    expect(readAnswer({ songs: [1, 2], talk: "Hi" }, choices, seg("onRepeat"))).toBeNull();
    expect(readAnswer({ songs: "1,2", talk: "Not a list of songs." }, choices, seg("onRepeat"))).toBeNull();
  });

  it("names the segment itself when the model doesn't", () => {
    expect(readAnswer({ songs: [1, 2], talk: "Two songs coming up." }, choices, seg("onRepeat"))?.name).toBe("On repeat");
  });
});

describe("cleanTalk", () => {
  it("makes a line fit to read aloud", () => {
    expect(cleanTalk('"Hey there! 🎶 Here\'s **Song 1**\n by Artist."')).toBe("Hey there! Here's Song 1 by Artist.");
    expect(cleanTalk("#1 `hit`, [remastered]")).toBe("1 hit, remastered");
    // Quotes inside a line stay.
    expect(cleanTalk('Here\'s "Song 1", then "Song 2".')).toBe('Here\'s "Song 1", then "Song 2".');
  });
});

describe("fallbackPick", () => {
  const choices = candidates(6, ["onRepeat"]);

  it("greets by name at the start", () => {
    const pick = fallbackPick(seg("onRepeat"), choices, "Sam", null);
    expect(pick.talk).toBe("Hey Sam, it's your DJ. Let's start with some songs you've had on repeat, starting with Song 0 by Artist 0.");
    expect(pick.songs).toHaveLength(4);
  });

  it("follows on from the last song", () => {
    const pick = fallbackPick(seg("throwbacks"), choices, null, { name: "Midnight City", artists: ["M83"] });
    expect(pick.talk).toBe("That was Midnight City by M83. Up next, some throwbacks, starting with Song 0 by Artist 0.");
    expect(pick.name).toBe("Throwbacks");
  });
});

describe("shuffled", () => {
  it("keeps every item", () => {
    const items = [1, 2, 3, 4, 5];
    expect(shuffled(items).sort()).toEqual(items);
    expect(shuffled(items, () => 0)).toEqual([2, 3, 4, 5, 1]);
  });
});
