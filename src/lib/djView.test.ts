import { describe, expect, it } from "vitest";
import {
  choicePatch,
  cloudModelOf,
  cloudOf,
  djLead,
  djNav,
  firstCloudModel,
  modelChoiceOf,
  modelName,
  offNote,
  providerName,
  voiceName,
} from "./djView";
import type { DjConfig, DjStatus } from "./ipc";

const settings: DjConfig = {
  enabled: true,
  provider: "local",
  model: "qwen2.5-1.5b",
  voice: "michael",
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
    models: [{ id: "qwen2.5-1.5b", label: "Qwen2.5 1.5B", detail: null, bytes: 1 }],
    voices: [{ id: "michael", label: "Michael (American)", detail: null, bytes: 1 }],
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
