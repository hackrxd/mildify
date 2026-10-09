// What the DJ's pages say about it, and how its settings' choices map onto its config: who writes its talk and which
// voice reads it out. Pure, so the wording is tested without a page.
import type { TalkStyle } from "./djTalk";
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

/** `why` as the end of a sentence: a full stop, unless it ends on its own. */
function ended(why: string): string {
  const text = why.trim();
  return /[.!?…]["'”’)]*$/.test(text) ? text : `${text}.`;
}

/** What the DJ says when its model fails in a way the listener can fix, and plays on from templates: as it happens
 * (`playing`), or after. */
export function modelNote(why: string, playing: boolean): string {
  return playing ? `Your DJ is talking from templates: ${ended(why)}` : `When it last played, your DJ talked from templates: ${ended(why)}`;
}

/** What the DJ says when its voice fails, and its lines show as captions instead. */
export function voiceNote(why: string, playing: boolean): string {
  return playing ? `Your DJ lost its voice, so its lines show as captions: ${ended(why)}` : `When it last played, your DJ lost its voice: ${ended(why)}`;
}

/** The DJ page's notes on what's wrong with the DJ's model and voice, until it's fixed. Just play has no voice to
 * lose. */
export function troubleNotes(trouble: { model: string | null; voice: string | null; talk: TalkStyle; playing: boolean }): string[] {
  const notes: string[] = [];
  if (trouble.model) notes.push(modelNote(trouble.model, trouble.playing));
  if (trouble.voice && trouble.talk !== "silent") notes.push(voiceNote(trouble.voice, trouble.playing));
  return notes;
}

/** A change in Settings that can stop the DJ: another model, its key removed, or its files deleted. */
export type DjChange = { kind: "model"; choice: string } | { kind: "key"; provider: DjCloud } | { kind: "files" };

/** What Settings asks under a setting before a change, and its two answers. */
export interface Question {
  text: string;
  confirm: string;
  cancel: string;
}

/** The model picker's value, named: the downloaded model, the own server or the cloud provider. */
function choiceName(choice: string, status: DjStatus): string {
  const settings = { ...status.settings, ...choicePatch(choice) };
  return settings.provider === "local" ? modelName({ ...status, settings }) : providerName(settings);
}

/** What Settings asks before `change`, or null to go ahead: another model or removing the key in use only while the
 * DJ plays, since either stops it; deleting its files always, gigabytes that take a while to download again. */
export function askBefore(change: DjChange, status: DjStatus, playing: boolean): Question | null {
  if (change.kind === "files") {
    return {
      text: `Remove the DJ's files, ${formatBytes(status.disk_bytes)}? ${playing ? "It stops playing and turns off" : "The DJ turns off"}, and they download again when you turn it back on.`,
      confirm: "Remove them",
      cancel: "Keep them",
    };
  }
  if (!playing) return null;
  if (change.kind === "model") {
    if (change.choice === modelChoiceOf(status.settings)) return null;
    return {
      text: `Switch the DJ to ${choiceName(change.choice, status)}? It stops playing to switch. Start it again from the DJ page.`,
      confirm: "Switch and stop",
      cancel: "Keep playing",
    };
  }
  if (change.provider !== status.settings.provider) return null;
  return {
    text: `Remove your ${CLOUD_NAMES[change.provider]} API key? The DJ is using it, so it stops playing.`,
    confirm: "Remove and stop",
    cancel: "Keep playing",
  };
}
