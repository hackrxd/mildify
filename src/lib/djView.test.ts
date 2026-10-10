import { describe, expect, it } from "vitest";
import {
  askBefore,
  choicePatch,
  cloudModelOf,
  cloudOf,
  djLead,
  djNav,
  firstCloudModel,
  modelChoiceOf,
  modelName,
  previewLine,
  offNote,
  providerName,
  songWhy,
  speedWords,
  troubleNotes,
  voiceGroups,
  voiceName,
  VOICE_SPEED,
} from "./djView";
import type { Candidate } from "./djPicks";
import type { DjConfig, DjSongInfo, DjStatus } from "./ipc";

const settings: DjConfig = {
  enabled: true,
  provider: "local",
  model: "qwen2.5-1.5b",
  voice: "michael",
  voice_speed: 1,
  server_url: "",
  server_model: "",
  own_tools: false,
  api_models: {},
  api_keys: [],
  musicbrainz: true,
};

function status(patch: Partial<DjConfig> = {}): DjStatus {
  return {
    supported: true,
    settings: { ...settings, ...patch },
    ready: true,
    setup: null,
    keys: { openai: false, anthropic: false, gemini: false },
    tools: false,
    needed: [],
    install: { running: false, component: null, received: 0, total: null, error: null },
    disk_bytes: 0,
    folder: "/dj",
    models: [
      { id: "qwen2.5-1.5b", label: "Qwen2.5 1.5B", detail: null, bytes: 1, installed: true, group: null },
      { id: "qwen3-4b", label: "Qwen3 4B", detail: null, bytes: 2, installed: false, group: null },
    ],
    voices: [
      { id: "michael", label: "Michael (American)", detail: null, bytes: 103_248_205, installed: true, group: "Kokoro" },
      { id: "lewis", label: "Lewis (British)", detail: null, bytes: 103_248_205, installed: true, group: "Kokoro" },
      { id: "light-male", label: "Light (male, faster)", detail: null, bytes: 26_586_708, installed: false, group: "Light" },
    ],
  };
}

describe("the model picker", () => {
  it("goes between its value and the settings for every kind of model", () => {
    for (const patch of [{ provider: "local", model: "qwen3-4b" }, { provider: "own" }, { provider: "anthropic" }] as Partial<DjConfig>[]) {
      const choice = modelChoiceOf({ ...settings, ...patch });
      expect(choicePatch(choice)).toEqual(patch);
    }
    expect(modelChoiceOf(settings)).toBe("local:qwen2.5-1.5b");
  });

  it("knows the cloud model in use: the one picked, or the provider's default", () => {
    expect(cloudOf(settings)).toBeNull();
    expect(cloudModelOf(settings)).toBe("");
    expect(cloudModelOf({ ...settings, provider: "openai", api_models: { openai: "gpt-5.5" } })).toBe("gpt-5.5");
    expect(cloudModelOf({ ...settings, provider: "anthropic" })).toBe("claude-opus-5-5");
    expect(cloudModelOf({ ...settings, provider: "gemini" })).toBe("");
  });

  it("starts a cloud provider on its newest model, past previews and experiments", () => {
    const list = ["gemini-3-pro-preview", "gemini-3-flash-exp", "gemini-2.5-pro"].map((id) => ({ id, label: id }));
    expect(firstCloudModel(list)?.id).toBe("gemini-2.5-pro");
    expect(firstCloudModel(list.slice(0, 2))?.id).toBe("gemini-3-pro-preview");
    expect(firstCloudModel([])).toBeNull();
  });
});

describe("names", () => {
  it("names who answers, the model and the voice, falling back to their ids", () => {
    expect(["local", "own", "openai", "gemini"].map((p) => providerName({ ...settings, provider: p as DjConfig["provider"] }))).toEqual([
      "the model on this computer",
      "your own model server",
      "OpenAI",
      "Google Gemini",
    ]);
    expect([modelName(status()), voiceName(status())]).toEqual(["Qwen2.5 1.5B", "Michael (American)"]);
    expect([modelName(status({ model: "new-model" })), voiceName(status({ voice: "emma" }))]).toEqual(["new-model", "emma"]);
  });

  it("lets a voice introduce itself by its name, or its group's", () => {
    const [michael, , light] = status().voices;
    expect(previewLine(michael)).toBe("Hi, I'm Michael. This is how I'd sound between your songs.");
    expect(previewLine({ ...light, label: "Light (male, faster)" })).toBe("Hi there. This is how I'd sound between your songs.");
  });

  it("lists the voices by the package they download in", () => {
    const groups = voiceGroups(status().voices);
    expect(groups.map((g) => [g.label, g.installed, g.voices.map((v) => v.id)])).toEqual([
      ["Kokoro (downloaded)", true, ["michael", "lewis"]],
      ["Light (27 MB)", false, ["light-male"]],
    ]);
    expect(voiceGroups([{ id: "x", label: "X", detail: null, bytes: 2_000_000, installed: false, group: null }])[0].label).toBe("Voices (2 MB)");
  });

  it("says how fast the voice speaks against its usual pace", () => {
    expect([1, 1.15, 0.85, VOICE_SPEED.max, VOICE_SPEED.min].map(speedWords)).toEqual([
      "At its usual pace",
      "15% faster than usual",
      "15% slower than usual",
      "30% faster than usual",
      "20% slower than usual",
    ]);
    // What a float a step off 1 comes back as from the backend.
    expect(speedWords(1.0000001)).toBe("At its usual pace");
  });
});

describe("djLead", () => {
  it("names who writes what the DJ says, and the voice that reads it, for every model", () => {
    expect(djLead(status())).toBe(
      "Your own radio DJ, running on this computer. It plays songs from your listening and talks between them: Qwen2.5 1.5B " +
        "writes what it says, and Michael (American) reads it out.",
    );
    expect(djLead(status({ provider: "own", server_model: "llama3.2" }))).toContain(
      ": llama3.2, on your own model server, writes what it says, and Michael (American) reads it out on this computer.",
    );
    expect(djLead(status({ provider: "own" }))).toContain(": your own model server writes what it says");
    expect(djLead(status({ provider: "anthropic" }))).toContain(": Anthropic's claude-opus-5-5 writes what it says");
    expect(djLead(status({ provider: "openai" }))).toContain(": OpenAI writes what it says, and Michael (American) reads it out on this computer.");
    for (const provider of ["local", "own", "openai", "anthropic", "gemini"] as const) {
      expect(djLead(status({ provider }))).toContain("Michael (American) reads it out");
    }
    expect(djLead(null)).toBe("Your own radio DJ. It plays songs from your listening and talks between them.");
  });
});

describe("djNav", () => {
  it("shows the DJ wherever it can run: resting while it's off, with the equaliser while it plays", () => {
    expect(djNav(null, "off")).toBe("hidden");
    expect(djNav({ ...status(), supported: false }, "off")).toBe("hidden");
    expect(djNav(status({ enabled: false }), "off")).toBe("off");
    expect(djNav(status(), "off")).toBe("stopped");
    expect(djNav(status(), "starting")).toBe("playing");
    expect(djNav(status(), "on")).toBe("playing");
  });
});

describe("offNote", () => {
  const parts = [
    { id: "llama", label: "Language model runtime (llama.cpp)", bytes: 20_000_000, installed: false },
    { id: "model", label: "Language model (Qwen2.5 1.5B Instruct)", bytes: 1_100_000_000, installed: false },
    { id: "sherpa", label: "Speech runtime (sherpa-onnx)", bytes: 30_000_000, installed: false },
    { id: "voice", label: "Voices (Kokoro)", bytes: 150_000_000, installed: false },
  ];
  const off = (patch: Partial<DjConfig>, needed: typeof parts) => ({ ...status({ enabled: false, ...patch }), needed });

  it("says what turning the DJ on downloads, for the model it's set to use", () => {
    expect(offNote(off({}, parts))).toBe(
      "The DJ is off. Turning it on downloads what it runs on, about 1.3 GB: a language model, a voice and the " +
        "programs for them. Nothing is downloaded until then, and you can remove it all again in Settings.",
    );
    expect(offNote(off({ provider: "openai" }, parts.slice(2)))).toContain("downloads what it runs on, about 180 MB: a voice and the program for it.");
  });

  it("counts only what's left, and says so once it's all downloaded", () => {
    const voiceIn = parts.map((p) => ({ ...p, installed: p.id === "sherpa" || p.id === "voice" }));
    expect(offNote(off({}, voiceIn))).toContain("Turning it on downloads the rest of what it runs on, about 1.1 GB.");
    expect(offNote(off({}, parts.map((p) => ({ ...p, installed: true }))))).toBe(
      "The DJ is off. What it runs on is already downloaded, and you can remove it in Settings.",
    );
  });
});

describe("troubleNotes", () => {
  it("says what's wrong with the model and the voice, while the DJ plays or after, as whole sentences", () => {
    expect(troubleNotes({ model: "OpenAI didn't accept your API key", voice: "No audio output device", talk: "normal", playing: true })).toEqual([
      "Your DJ is talking from templates: OpenAI didn't accept your API key.",
      "Your DJ lost its voice, so its lines show as captions: No audio output device.",
    ]);
    expect(troubleNotes({ model: "Your credit ran out.", voice: "Is a speaker plugged in?", talk: "brief", playing: false })).toEqual([
      "When it last played, your DJ talked from templates: Your credit ran out.",
      "When it last played, your DJ lost its voice: Is a speaker plugged in?",
    ]);
  });

  it("has nothing to say when nothing's wrong, nor about the voice on Just play, which has none", () => {
    expect(troubleNotes({ model: null, voice: null, talk: "normal", playing: true })).toEqual([]);
    expect(troubleNotes({ model: null, voice: "No audio output device", talk: "silent", playing: true })).toEqual([]);
    expect(troubleNotes({ model: "Out of credit", voice: "No audio output device", talk: "silent", playing: true })).toHaveLength(1);
  });
});

describe("askBefore", () => {
  it("asks before another model only while the DJ plays, since switching stops it", () => {
    const qwen3 = { kind: "model", choice: "local:qwen3-4b" } as const;
    expect(askBefore(qwen3, status(), true)).toEqual({
      text: "Switch the DJ to Qwen3 4B? It stops playing to switch. Start it again from the DJ page.",
      confirm: "Switch and stop",
      cancel: "Keep playing",
    });
    expect(askBefore(qwen3, status(), false)).toBeNull();
    expect(askBefore({ kind: "model", choice: "own" }, status(), true)?.text).toMatch(/^Switch the DJ to your own model server\? /);
    expect(askBefore({ kind: "model", choice: "anthropic" }, status(), true)?.text).toMatch(/^Switch the DJ to Anthropic\? /);
    expect(askBefore({ kind: "model", choice: "local:qwen2.5-1.5b" }, status(), true)).toBeNull();
  });

  it("asks before a voice that has to download, while the DJ plays, since it stops until it's in", () => {
    expect(askBefore({ kind: "voice", choice: "light-male" }, status(), true)).toEqual({
      text: "Switch the DJ's voice to Light (male, faster)? Light voices download first, 27 MB, and the DJ stops until they're in.",
      confirm: "Switch and stop",
      cancel: "Keep playing",
    });
    expect(askBefore({ kind: "voice", choice: "light-male" }, status(), false)).toBeNull();
    // Downloaded with the voice in use, or the one in use.
    expect(askBefore({ kind: "voice", choice: "lewis" }, status(), true)).toBeNull();
    expect(askBefore({ kind: "voice", choice: "light-male" }, status({ voice: "light-male" }), true)).toBeNull();
    expect(askBefore({ kind: "voice", choice: "nobody" }, status(), true)).toBeNull();
  });

  it("asks before removing the key the DJ is using, while it plays", () => {
    const openai = status({ provider: "openai" });
    expect(askBefore({ kind: "key", provider: "openai" }, openai, true)).toEqual({
      text: "Remove your OpenAI API key? The DJ is using it, so it stops playing.",
      confirm: "Remove and stop",
      cancel: "Keep playing",
    });
    expect(askBefore({ kind: "key", provider: "openai" }, openai, false)).toBeNull();
    expect(askBefore({ kind: "key", provider: "gemini" }, openai, true)).toBeNull();
  });

  it("always asks before forgetting what the DJ remembers", () => {
    for (const playing of [true, false]) {
      expect(askBefore({ kind: "forget" }, status(), playing)).toMatchObject({ confirm: "Forget it", cancel: "Keep it" });
    }
    expect(askBefore({ kind: "forget" }, status(), false)?.text).toMatch(/^Forget what your DJ remembers\? /);
  });

  it("always asks before removing the DJ's files", () => {
    const files = { ...status(), disk_bytes: 1_300_000_000 };
    expect(askBefore({ kind: "files" }, files, false)).toEqual({
      text: "Remove the DJ's files, 1.3 GB? The DJ turns off, and they download again when you turn it back on.",
      confirm: "Remove them",
      cancel: "Keep them",
    });
    expect(askBefore({ kind: "files" }, files, true)?.text).toBe(
      "Remove the DJ's files, 1.3 GB? It stops playing and turns off, and they download again when you turn it back on.",
    );
  });
});

describe("songWhy", () => {
  const NOW = new Date("2026-10-09T12:00:00Z");
  const song = (patch: Partial<Candidate> = {}): Candidate => ({
    uri: "spotify:track:1",
    name: "Midnight City",
    artists: ["M83"],
    album: "Hurry Up, We're Dreaming",
    year: "2011",
    durationMs: 1,
    explicit: false,
    reasons: [],
    likedAt: null,
    playedAt: null,
    ...patch,
  });
  const found = (patch: Partial<DjSongInfo> = {}): DjSongInfo => ({
    uri: "spotify:track:1",
    genres: [],
    tags: [],
    released: null,
    label: null,
    album: null,
    album_type: null,
    popularity: null,
    languages: [],
    artist_bio: null,
    artist_active: null,
    related_artists: [],
    ...patch,
  });

  it("says what the listener's own listening shows, in their words", () => {
    const listened = song({
      reasons: ["onRepeat", "favorite", "allTime"],
      playedAt: new Date("2026-10-08T09:00:00Z"),
      likedAt: new Date("2019-03-02T00:00:00Z"),
    });
    expect(songWhy(listened, undefined, NOW)).toEqual({
      yours: ["On repeat lately", "One of your most played ever", "Played yesterday", "Liked in March 2019"],
      found: [],
      bio: null,
    });
    expect(songWhy(song({ reasons: ["favorite"], playedAt: NOW }), undefined, NOW).yours).toEqual(["A favorite these past months", "Played today"]);
    expect(songWhy(song({ playedAt: new Date("2026-10-04T12:00:00Z") }), undefined, NOW).yours).toEqual(["Played 5 days ago"]);
  });

  it("adds what was looked up: genres, the release, how well known it is, its language, artists like it, the bio", () => {
    const why = songWhy(
      song(),
      found({
        genres: ["synth-pop", "Indie Pop"],
        tags: ["indie pop", "electronic", "dream pop"],
        released: "2011-10-18",
        label: "Mute",
        popularity: 15,
        languages: ["es"],
        related_artists: ["Washed Out", "Chromatics", "Neon Indian"],
        artist_bio: "  A French band.  ",
      }),
      NOW,
    );
    expect(why.found).toEqual([
      "synth-pop",
      "indie pop",
      "electronic",
      "Released in 2011 on Mute",
      "A deep cut",
      "Sung in Spanish",
      "For fans of Washed Out and Chromatics",
    ]);
    expect(why.bio).toBe("A French band.");
  });

  it("says what it can of a release, and nothing of a language that goes without saying", () => {
    expect(songWhy(song(), found({ released: "2011" }), NOW).found).toEqual(["Released in 2011"]);
    expect(songWhy(song(), found({ label: "Mute" }), NOW).found).toEqual(["Released on Mute"]);
    expect(songWhy(song(), found({ languages: ["en", "und", "en-GB"] }), NOW).found).toEqual([]);
    expect(songWhy(song(), found({ languages: ["zxx"] }), NOW).found).toEqual(["Instrumental"]);
    expect(songWhy(song(), found({ languages: ["en", "ja", "xx"] }), NOW).found).toEqual(["Sung in Japanese"]);
    expect(songWhy(song(), found({ artist_bio: "   " }), NOW).bio).toBeNull();
  });
});
