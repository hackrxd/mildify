// Thin, typed wrappers over the Spotify Web API endpoints still available
// to development-mode apps after the February 2026 changes.

import { api } from "./ipc";
import type {
  Album,
  Artist,
  Device,
  Paging,
  PlayHistory,
  PlaybackState,
  Playlist,
  PlaylistItem,
  Queue,
  SavedAlbum,
  SavedTrack,
  SearchResults,
  SimpleAlbum,
  SimplePlaylist,
  SimpleTrack,
  Track,
  User,
} from "./types";

const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
  api<T>("GET", path, { query });

/** Follows a paging `next` link (an absolute api.spotify.com URL). */
export const nextPage = <T>(next: string) => api<Paging<T>>("GET", next);

export const me = () => get<User>("/me");

// Library
export const myPlaylists = (offset = 0) => get<Paging<SimplePlaylist>>("/me/playlists", { limit: 50, offset });
export const savedTracks = (offset = 0) => get<Paging<SavedTrack>>("/me/tracks", { limit: 50, offset });
export const savedAlbums = (offset = 0) => get<Paging<SavedAlbum>>("/me/albums", { limit: 50, offset });
export const followedArtists = () =>
  get<{ artists: Paging<Artist> }>("/me/following", { type: "artist", limit: 50 }).then((r) => r.artists);
export const recentlyPlayed = () => get<Paging<PlayHistory>>("/me/player/recently-played", { limit: 50 });
export const topArtists = () => get<Paging<Artist>>("/me/top/artists", { limit: 20, time_range: "short_term" });
export const topTracks = () => get<Paging<Track>>("/me/top/tracks", { limit: 20, time_range: "short_term" });

/** Unified library endpoints (2026): take full Spotify URIs, max 40 per call. */
export const libraryContains = (uris: string[]) => get<boolean[]>("/me/library/contains", { uris: uris.join(",") });
export const saveToLibrary = (uris: string[]) => api<null>("PUT", "/me/library", { query: { uris: uris.join(",") } });
export const removeFromLibrary = (uris: string[]) =>
  api<null>("DELETE", "/me/library", { query: { uris: uris.join(",") } });

// Catalog
export const album = (id: string) => get<Album>(`/albums/${id}`);
export const artist = (id: string) => get<Artist>(`/artists/${id}`);
export const artistAlbums = (id: string, offset = 0) =>
  get<Paging<SimpleAlbum>>(`/artists/${id}/albums`, { include_groups: "album,single,compilation", limit: 50, offset });
export const playlist = (id: string) => get<Playlist>(`/playlists/${id}`);
export const playlistItems = (id: string, offset = 0) =>
  get<Paging<PlaylistItem>>(`/playlists/${id}/items`, { limit: 100, offset });

/** Search is capped at 10 results per type for development-mode apps. */
export const search = (q: string, offset = 0) =>
  get<SearchResults>("/search", { q, type: "track,artist,album,playlist", limit: 10, offset });

// Player
export const playbackState = () => get<PlaybackState | null>("/me/player", { additional_types: "episode" });
export const devices = () => get<{ devices: Device[] }>("/me/player/devices").then((r) => r.devices);
export const queue = () => get<Queue>("/me/player/queue");

export const transfer = (deviceId: string, play: boolean) =>
  api<null>("PUT", "/me/player", { body: { device_ids: [deviceId], play } });

export interface PlayRequest {
  context_uri?: string;
  uris?: string[];
  offset?: { position: number } | { uri: string };
  position_ms?: number;
}
export const play = (deviceId: string | undefined, body?: PlayRequest) =>
  api<null>("PUT", "/me/player/play", { query: { device_id: deviceId }, body });
export const pause = (deviceId?: string) => api<null>("PUT", "/me/player/pause", { query: { device_id: deviceId } });
export const skipNext = (deviceId?: string) => api<null>("POST", "/me/player/next", { query: { device_id: deviceId } });
export const skipPrevious = (deviceId?: string) =>
  api<null>("POST", "/me/player/previous", { query: { device_id: deviceId } });
export const seek = (positionMs: number, deviceId?: string) =>
  api<null>("PUT", "/me/player/seek", { query: { position_ms: Math.round(positionMs), device_id: deviceId } });
export const setVolume = (percent: number, deviceId?: string) =>
  api<null>("PUT", "/me/player/volume", { query: { volume_percent: Math.round(percent), device_id: deviceId } });
export const setShuffle = (on: boolean, deviceId?: string) =>
  api<null>("PUT", "/me/player/shuffle", { query: { state: on, device_id: deviceId } });
export const setRepeat = (mode: "off" | "context" | "track", deviceId?: string) =>
  api<null>("PUT", "/me/player/repeat", { query: { state: mode, device_id: deviceId } });
export const addToQueue = (uri: string, deviceId?: string) =>
  api<null>("POST", "/me/player/queue", { query: { uri, device_id: deviceId } });

/** Playlist items moved from `track` to `item` in 2026; accept either. */
export const itemTrack = (it: PlaylistItem): Track | null => it.item ?? it.track ?? null;

/** Loads every page of a paged list (bounded, to stay friendly with rate limits). */
export async function allPages<T>(first: Paging<T>, maxItems = 1000): Promise<T[]> {
  const items = [...first.items];
  let next = first.next;
  while (next && items.length < maxItems) {
    const page = await nextPage<T>(next);
    items.push(...page.items);
    next = page.next;
  }
  return items;
}

export type { SimpleTrack };
