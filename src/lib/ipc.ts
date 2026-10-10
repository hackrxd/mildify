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
  dj: DjConfig;
}

/** The AI DJ's settings (src-tauri/src/dj/mod.rs). */
export interface DjConfig {
  /** Off until turned on; nothing is downloaded before. */
  enabled: boolean;
  /** Who writes the talk: the downloaded model, the user's own server, or a cloud provider. */
  provider: DjProvider;
  /** The downloaded model the "local" provider runs, an id from `DjStatus.models`. */
  model: string;
  voice: string;
  /** How fast the voice speaks, against its own pace: `VOICE_SPEED`'s range. */
  voice_speed: number;
  server_url: string;
  server_model: string;
  /** The own server's model can call tools, so it can look songs up. */
  own_tools: boolean;
  /** The model picked for each cloud provider. */
  api_models: Partial<Record<DjCloud, string>>;
  /** The cloud providers with a key saved; the keys stay in the system keychain. */
  api_keys: DjCloud[];
  /** Song look-ups may ask MusicBrainz for genres. */
  musicbrainz: boolean;
}

export type DjCloud = "openai" | "anthropic" | "gemini";
export type DjProvider = "local" | "own" | DjCloud;

/** A download the DJ's settings need. */
export interface DjNeeded {
  id: string;
  label: string;
  bytes: number;
  installed: boolean;
}

export interface DjInstall {
  running: boolean;
  /** What's downloading now. */
  component: string | null;
  received: number;
  total: number | null;
  error: string | null;
}

export interface DjChoice {
  id: string;
  label: string;
  detail: string | null;
  bytes: number;
}

export interface DjStatus {
  /** Prebuilt runtimes exist for this computer. */
  supported: boolean;
  settings: DjConfig;
  /** Everything the settings need is downloaded, and an own server is set up. */
  ready: boolean;
  /** What the model settings still need, if anything. */
  setup: string | null;
  /** Which cloud providers have a key saved; the keys themselves stay in the backend. */
  keys: Record<DjCloud, boolean>;
  /** The model in use can look songs up. */
  tools: boolean;
  needed: DjNeeded[];
  install: DjInstall;
  disk_bytes: number;
  folder: string;
  models: DjChoice[];
  voices: DjChoice[];
}

export interface DjMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A tool the DJ's model may call, with its arguments as JSON Schema. */
export interface DjTool {
  name: string;
  description: string;
  parameters: object;
}

export interface DjToolCall {
  name: string;
  arguments: unknown;
}

/** The model's answer to a look-up question: the calls it made, or what it said instead. */
export interface DjLookUp {
  calls?: DjToolCall[];
  text?: string;
}

/** A model a cloud provider offers. */
export interface DjModelChoice {
  id: string;
  label: string;
}

/** A song to look up (src-tauri/src/dj/songinfo.rs). */
export interface DjSongRef {
  uri: string;
  name: string;
  artist: string;
  artist_id: string | null;
}

/** What was found about a song. */
export interface DjSongInfo {
  uri: string;
  genres: string[];
  tags: string[];
  released: string | null;
  label: string | null;
  album: string | null;
  album_type: string | null;
  popularity: number | null;
  languages: string[];
  artist_bio: string | null;
  artist_active: string | null;
  related_artists: string[];
}

/** A sentence of a spoken line and when it's said, from the start of the audio. */
export interface DjSentence {
  text: string;
  start_ms: number;
  end_ms: number;
}

export type DjVoiceCommand =
  | { action: "play"; id: number; gain: number }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "gain"; gain: number }
  | { action: "stop" };

/** A `dj-voice` event: the line playing this far in (as it starts, then a few times a second), done, or unplayable. */
export type DjVoiceEvent =
  | { state: "playing"; id: number; position_ms: number }
  | { state: "ended"; id: number }
  | { state: "failed"; id: number; error: string };

/** A line `dj_speak` read aloud; `djVoice` plays it. */
export interface DjSpeech {
  id: number;
  duration_ms: number;
  sentences: DjSentence[];
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
  | { action: "repeat"; mode: RepeatMode }
  /** A song after the one playing, ahead of the rest. */
  | { action: "queue"; uri: string }
  /** Takes out what was queued; the rest of what's playing stays. */
  | { action: "clear_queue" };

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
  djStatus: () => invoke<DjStatus>("dj_status"),
  /** Turning the DJ on starts its downloads; off stops them and unloads the model. */
  djConfigure: (settings: Partial<DjConfig>) => invoke<DjStatus>("dj_configure", { settings }),
  djInstall: () => invoke<void>("dj_install"),
  djCancel: () => invoke<void>("dj_cancel"),
  /** Turns the DJ off and deletes its downloads. */
  djRemove: () => invoke<DjStatus>("dj_remove"),
  /** Loads the model ahead of the first request. */
  djWarm: () => invoke<void>("dj_warm"),
  /** Asks the DJ's model; with a JSON schema, resolves to JSON that fits it. */
  djGenerate: async (messages: DjMessage[], schema?: object, maxTokens?: number) =>
    (await invoke<{ json?: unknown }>("dj_generate", { messages, schema, maxTokens })).json,
  /** Offers the DJ's model tools; resolves to the calls it wants to make before answering. */
  djLookUp: (messages: DjMessage[], tools: DjTool[], maxTokens?: number) =>
    invoke<DjLookUp>("dj_generate", { messages, tools, maxTokens }),
  /** What can be found out about songs the model asked about. */
  djSongInfo: (songs: DjSongRef[]) => invoke<DjSongInfo[]>("dj_song_info", { songs }),
  /** Saves a cloud provider's API key in the system keychain, or removes it with null. */
  djSetKey: (provider: DjCloud, key: string | null) => invoke<DjStatus>("dj_set_key", { provider, key }),
  /** The models a cloud provider offers with the saved key. */
  djModels: (provider: DjCloud) => invoke<DjModelChoice[]>("dj_models", { provider }),
  djSpeak: (text: string) => invoke<DjSpeech>("dj_speak", { text }),
  /** Plays, pauses or stops the DJ's lines on this computer's audio output; `dj-voice` events say how it goes. */
  djVoice: (command: DjVoiceCommand) => invoke<void>("dj_voice", { command }),
  /** Turns the embedded player's music down to `level` (0-1), `delayMs` from now in heard time, or back up. */
  djDuck: (level: number, delayMs = 0, rampMs = 400) => invoke<void>("dj_duck", { level, delayMs, rampMs }),
  /** Unloads the model. */
  djRelease: () => invoke<void>("dj_release"),
};

let authLost: (() => void) | null = null;

/** Registers a handler for when the Web API session is gone (refresh token revoked). */
export function onAuthLost(fn: () => void) {
  authLost = fn;
}

/** Calls the Spotify Web API through the backend, which owns the token. `once`: not sent again after a server error,
 * for a request Spotify may have carried out before failing (adding songs to a playlist would add them twice). */
export function api<T>(method: string, path: string, opts: { query?: Query; body?: unknown; once?: boolean } = {}): Promise<T> {
  const query = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, String(v)] as [string, string])
    : undefined;
  return invoke<T>("api", { method, path, query, body: opts.body, once: opts.once }).catch((e) => {
    if (isAppError(e) && e.kind === "not_signed_in") authLost?.();
    throw e;
  });
}
