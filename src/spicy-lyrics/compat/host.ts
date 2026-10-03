// Bridge between the vendored Spicy Lyrics renderer and Mildify.
// The app installs its implementation with setHost(); the renderer's replacement
// modules (SpotifyPlayer, fetchLyrics, …) read from `host`.

export interface HostTrack {
  uri: string;
  id: string;
  name: string;
  album: string;
  artists: { name: string; uri: string }[];
  cover: string | null;
  durationMs: number;
  type: "track" | "episode" | "local" | "unknown";
}

export interface Host {
  /** Current playback position in ms, interpolated to the frame. */
  position(): number;
  isPlaying(): boolean;
  track(): HostTrack | null;
  seek(ms: number): void;
  /** Spicy Lyrics v1 response for a track, or null when there are none. Rejects with an AppError. */
  fetchLyrics(trackId: string): Promise<any | null>;
  openUrl(url: string): void;
}

export let host: Host = {
  position: () => 0,
  isPlaying: () => false,
  track: () => null,
  seek: () => {},
  fetchLyrics: async () => null,
  openUrl: () => {},
};

export function setHost(impl: Host) {
  host = impl;
}
