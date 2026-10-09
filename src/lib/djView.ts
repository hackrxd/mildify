// What the DJ's pages say about it, and how its settings' choices map onto its config: who writes its talk and which
// voice reads it out. Pure, so the wording is tested without a page.
import type { DjCloud, DjConfig, DjModelChoice, DjStatus } from "./ipc";
import { formatBytes } from "./util";

export const CLOUD_NAMES: Record<DjCloud, string> = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Google Gemini" };
/** A cloud provider's model before one is picked: the backend's own default (src-tauri/src/dj/mod.rs). */
export const DEFAULT_CLOUD_MODEL: Partial<Record<DjCloud, string>> = { anthropic: "claude-opus-5-5" };

export function isCloud(provider: string): provider is DjCloud {
  return Object.hasOwn(CLOUD_NAMES, provider);
}

/** The cloud provider in use, if one is. */
export function cloudOf(settings: DjConfig): DjCloud | null {
  return isCloud(settings.provider) ? settings.provider : null;
}

/** The cloud model in use: the one picked, or the provider's default; none before either. */
export function cloudModelOf(settings: DjConfig): string {
  const cloud = cloudOf(settings);
  return cloud ? (settings.api_models[cloud] ?? DEFAULT_CLOUD_MODEL[cloud] ?? "") : "";
}

/** The model picker's value: a downloaded model (`local:<id>`), the own server (`own`), or a cloud provider. */
export function modelChoiceOf(settings: DjConfig): string {
  return settings.provider === "local" ? `local:${settings.model}` : settings.provider;
}

/** The settings a model picker's value stands for. */
export function choicePatch(choice: string): Partial<DjConfig> {
  if (choice.startsWith("local:")) return { provider: "local", model: choice.slice("local:".length) };
  return { provider: choice as DjCloud | "own" };
}

/** The model a cloud provider starts on when none is picked: the newest the key can use, past previews and
 * experiments, which come and go. */
export function firstCloudModel(list: DjModelChoice[]): DjModelChoice | null {
  return list.find((m) => !/preview|exp/i.test(m.id)) ?? list[0] ?? null;
}

/** Who answers the DJ's questions: a cloud provider, the own server, or the model on this computer. */
export function providerName(settings: DjConfig): string {
  const cloud = cloudOf(settings);
  if (cloud) return CLOUD_NAMES[cloud];
  return settings.provider === "own" ? "your own model server" : "the model on this computer";
}

/** The downloaded model's name. */
export function modelName(status: DjStatus): string {
  return status.models.find((m) => m.id === status.settings.model)?.label ?? status.settings.model;
}

export function voiceName(status: DjStatus): string {
  return status.voices.find((v) => v.id === status.settings.voice)?.label ?? status.settings.voice;
}

/** Who writes what the DJ says, as the subject of a sentence. */
function writer(status: DjStatus): string {
  const s = status.settings;
  if (s.provider === "local") return modelName(status);
  if (s.provider === "own") return s.server_model.trim() ? `${s.server_model.trim()}, on your own model server,` : "your own model server";
  const model = cloudModelOf(s);
  return model ? `${providerName(s)}'s ${model}` : providerName(s);
}

/** The DJ page's lead: what the DJ is, which model writes what it says, and which voice reads it out. */
export function djLead(status: DjStatus | null): string {
  const plays = "It plays songs from your listening and talks between them";
  if (!status) return `Your own radio DJ. ${plays}.`;
  const voice = voiceName(status);
  if (status.settings.provider === "local") {
    return `Your own radio DJ, running on this computer. ${plays}: ${writer(status)} writes what it says, and ${voice} reads it out.`;
  }
  return `Your own radio DJ. ${plays}: ${writer(status)} writes what it says, and ${voice} reads it out on this computer.`;
}

/** How the sidebar shows the DJ: not at all on a computer it can't run on, resting while it's turned off, and with
 * the equaliser while it plays. */
export type DjNav = "hidden" | "off" | "stopped" | "playing";

export function djNav(status: DjStatus | null, phase: "off" | "starting" | "on"): DjNav {
  if (!status?.supported) return "hidden";
  if (phase !== "off") return "playing";
  return status.settings.enabled ? "stopped" : "off";
}

/** What the DJ page says while the DJ is turned off: what turning it on downloads, if anything is left to. */
export function offNote(status: DjStatus): string {
  const missing = status.needed.filter((n) => !n.installed);
  if (!missing.length) return "The DJ is off. What it runs on is already downloaded, and you can remove it in Settings.";
  const size = formatBytes(missing.reduce((n, c) => n + c.bytes, 0));
  const what = status.needed.some((n) => n.installed)
    ? `the rest of what it runs on, about ${size}`
    : status.settings.provider === "local"
      ? `what it runs on, about ${size}: a language model, a voice and the programs for them`
      : `what it runs on, about ${size}: a voice and the program for it`;
  return `The DJ is off. Turning it on downloads ${what}. Nothing is downloaded until then, and you can remove it all again in Settings.`;
}
