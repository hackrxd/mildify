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

export type DeviceState = "offline" | "needs_login" | "connecting" | "ready" | "error";

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
}

export interface AppStatus {
  config: Config;
  redirect_uri: string;
  signed_in: boolean;
  device: DeviceStatus;
}

export type DeviceCommand =
  | { action: "play" | "pause" | "play_pause" | "next" | "prev" }
  | { action: "seek"; position_ms: number }
  | { action: "volume"; percent: number }
  | { action: "shuffle"; on: boolean }
  | { action: "repeat"; mode: RepeatMode };

export type RepeatMode = "off" | "context" | "track";

/** Events the embedded librespot player emits as `local-player`. */
export type LocalEvent =
  | { type: "playing" | "paused" | "loading" | "seeked"; uri: string; position_ms: number }
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

type Query = Record<string, string | number | boolean | undefined | null>;

export const backend = {
  status: () => invoke<AppStatus>("app_status"),
  saveSettings: (settings: Partial<Pick<Config, "client_id" | "device_name" | "bitrate" | "normalisation">>) =>
    invoke<AppStatus>("save_settings", { settings }),
  signIn: () => invoke<AppStatus>("sign_in"),
  cancelSignIn: () => invoke<void>("cancel_sign_in"),
  signOut: () => invoke<AppStatus>("sign_out"),
  restartDevice: () => invoke<void>("restart_device"),
  device: (command: DeviceCommand) => invoke<void>("device_command", { command }),
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
