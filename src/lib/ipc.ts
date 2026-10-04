import { invoke } from "@tauri-apps/api/core";

/** Error shape every backend command rejects with. */
export interface AppError {
  kind:
    | "api"
    | "rate_limited"
    | "not_signed_in"
    | "no_client_id"
    | "cancelled"
    | "auth"
    | "device"
    | "network"
    | "io"
    | "other";
  message: string;
  status: number | null;
}

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export type DeviceState = "offline" | "needs_login" | "connecting" | "ready" | "premium_required" | "error";

export interface DeviceStatus {
  state: DeviceState;
  device_id: string;
  name: string;
  error: string | null;
}

export interface Config {
  client_id: string | null;
  device_name: string;
  device_id: string;
  bitrate: number;
  initial_volume: number;
  normalisation: boolean;
  /** Serve the Spotify app's DevTools endpoint for mild-lyrics (devtools.rs). */
  devtools: boolean;
}

/** The DevTools endpoint: the port it's on, or why it isn't. */
export interface DevToolsStatus {
  port: number | null;
  error: string | null;
}

/** The Nativify lyrics service (fixed URL, set in the backend). */
export interface LyricsServerStatus {
  url: string;
  reachable: boolean;
  auth_required: boolean;
  version: string | null;
  username: string | null;
  error: string | null;
}

/** A theme or extension in the mods folders (mods.rs). */
export interface ModInfo {
  /** File or folder name. */
  id: string;
  /** Entry file relative to the kind's folder, `/`-separated. */
  entry: string;
  name: string;
  description: string | null;
  author: string | null;
  version: string | null;
  /** Entry file's mtime in ms; changes on every edit. */
  modified: number;
}

export interface ModList {
  themes_dir: string;
  extensions_dir: string;
  /** Where `themes/<entry>` and `extensions/<entry>` are served from. */
  base_url: string;
  /** Started with `--safe-mode`: load no theme or extension. */
  safe_mode: boolean;
  themes: ModInfo[];
  extensions: ModInfo[];
}

export type ModKind = "themes" | "extensions";

type SettingsInput = Partial<Pick<Config, "client_id" | "device_name" | "bitrate" | "normalisation" | "devtools">>;

export interface AppStatus {
  config: Config;
  redirect_uri: string;
  signed_in: boolean;
  device: DeviceStatus;
  devtools: DevToolsStatus;
}

export type DeviceCommand =
  | { action: "play" | "pause" | "play_pause" | "next" | "prev" }
  | { action: "seek"; position_ms: number }
  | { action: "volume"; percent: number }
  | { action: "shuffle"; on: boolean }
  | { action: "repeat"; mode: RepeatMode };

export type RepeatMode = "off" | "context" | "track";

/** Events the embedded librespot player emits as `local-player`. Positions are what's audible. */
export type LocalEvent =
  | { type: "playing" | "paused" | "loading" | "seeked" | "position"; uri: string; position_ms: number }
  | { type: "stopped" | "end_of_track" | "unavailable"; uri: string }
  | {
      type: "track";
      uri: string;
      name: string;
      artists: { uri: string; name: string }[];
      album: string;
      cover: string | null;
      duration_ms: number;
      explicit: boolean;
    }
  | { type: "volume"; percent: number }
  | { type: "shuffle"; on: boolean }
  | { type: "repeat"; context: boolean; track: boolean }
  | { type: "session_connected" | "session_disconnected" };

/** What the embedded player emits as `audio-level` while the meter is on: RMS, 0-1, as it's heard. */
export interface AudioLevel {
  level: number;
  /** Below about 150 Hz. */
  bass: number;
}

/** What `ui_update` found (src-tauri/src/ui.rs). */
export type UiUpdate =
  | { status: "up_to_date" }
  /** Downloaded: a reload loads it, and playback carries on. */
  | { status: "ready"; version: string }
  /** The release changes the app itself: the full updater, and a restart that stops playback. */
  | { status: "restart"; version: string };

type Query = Record<string, string | number | boolean | undefined | null>;

export const backend = {
  status: () => invoke<AppStatus>("app_status"),
  saveSettings: (settings: SettingsInput) => invoke<AppStatus>("save_settings", { settings }),
  signIn: () => invoke<AppStatus>("sign_in"),
  cancelSignIn: () => invoke<void>("cancel_sign_in"),
  signOut: () => invoke<AppStatus>("sign_out"),
  restartDevice: () => invoke<void>("restart_device"),
  device: (command: DeviceCommand) => invoke<void>("device_command", { command }),
  /** Starts or stops the embedded player's `audio-level` events. */
  audioMeter: (on: boolean) => invoke<void>("audio_meter", { on }),
  /** Spicy Lyrics v1 response for a track, or null when there are no lyrics. */
  lyrics: (trackId: string) => invoke<unknown | null>("spicy_lyrics", { trackId }),
  /** Fetches lyrics for upcoming tracks into the backend's cache. Resolves to how many it fetched. */
  warmLyrics: (trackIds: string[]) => invoke<number>("warm_lyrics", { trackIds }),
  /** Drops a played track's cached lyrics. */
  forgetLyrics: (trackId: string) => invoke<void>("forget_lyrics", { trackId }),
  lyricsServerStatus: () => invoke<LyricsServerStatus>("lyrics_server_status"),
  lyricsServerLogin: (username: string, password: string) =>
    invoke<LyricsServerStatus>("lyrics_server_login", { username, password }),
  lyricsServerLogout: () => invoke<LyricsServerStatus>("lyrics_server_logout"),
  listMods: () => invoke<ModList>("list_mods"),
  openModsFolder: (kind: ModKind) => invoke<void>("open_mods_folder", { kind }),
  /** Checks for a newer interface and downloads it if this build can load it without a restart. */
  uiUpdate: () => invoke<UiUpdate>("ui_update"),
  /** Serves the downloaded interface from the next page load; reload right after. */
  applyUiUpdate: () => invoke<boolean>("apply_ui_update"),
  /** Answers a `devtools-ask` event. */
  devtoolsAnswer: (id: number, value: unknown) => invoke<void>("devtools_answer", { id, value }),
};

let authLost: (() => void) | null = null;

/** Registers a handler for when the Web API session is gone (refresh token revoked). */
export function onAuthLost(fn: () => void) {
  authLost = fn;
}

/** Calls the Spotify Web API through the backend, which owns the token. */
export function api<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
  const query = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, String(v)] as [string, string])
    : undefined;
  return invoke<T>("api", { method, path, query, body: opts.body }).catch((e) => {
    if (isAppError(e) && e.kind === "not_signed_in") authLost?.();
    throw e;
  });
}
