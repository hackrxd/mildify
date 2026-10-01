// The subset of Spotify Web API objects this app reads.
// Fields removed in the February 2026 API changes (popularity, followers, ...) are omitted.

export interface Image {
  url: string;
  width: number | null;
  height: number | null;
}

export interface Paging<T> {
  items: T[];
  next: string | null;
  total: number;
  offset: number;
  limit: number;
}

export interface SimpleArtist {
  id: string;
  name: string;
  uri: string;
}

export interface Artist extends SimpleArtist {
  images: Image[];
  genres?: string[];
}

export interface SimpleAlbum {
  id: string;
  name: string;
  uri: string;
  album_type: "album" | "single" | "compilation";
  images: Image[];
  artists: SimpleArtist[];
  release_date: string;
  total_tracks: number;
}

export interface Album extends SimpleAlbum {
  tracks: Paging<SimpleTrack>;
  copyrights?: { text: string; type: string }[];
}

export interface SimpleTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  explicit: boolean;
  artists: SimpleArtist[];
  track_number: number;
  disc_number: number;
  is_playable?: boolean;
  type: "track" | "episode";
}

export interface Track extends SimpleTrack {
  album: SimpleAlbum;
}

export interface User {
  id: string;
  display_name: string | null;
  images?: Image[];
}

export interface PlaylistItem {
  added_at: string | null;
  /** Renamed from `track` in the 2026 API; older responses may still use `track`. */
  item?: Track | null;
  track?: Track | null;
}

export interface SimplePlaylist {
  id: string;
  name: string;
  uri: string;
  description: string | null;
  images: Image[] | null;
  owner: User;
  collaborative: boolean;
  public: boolean | null;
}

export interface Playlist extends SimplePlaylist {
  /** Only present for playlists the user owns or collaborates on. */
  items?: Paging<PlaylistItem>;
  tracks?: Paging<PlaylistItem>;
}

export interface SavedTrack {
  added_at: string;
  track: Track;
}

export interface SavedAlbum {
  added_at: string;
  album: SimpleAlbum;
}

export interface Device {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume?: boolean;
}

export interface PlaybackState {
  device: Device;
  repeat_state: "off" | "context" | "track";
  shuffle_state: boolean;
  context: { uri: string; type: string } | null;
  timestamp: number;
  progress_ms: number | null;
  is_playing: boolean;
  item: Track | null;
  currently_playing_type: string;
}

export interface PlayHistory {
  track: Track;
  played_at: string;
  context: { uri: string; type: string } | null;
}

export interface SearchResults {
  tracks?: Paging<Track>;
  artists?: Paging<Artist>;
  albums?: Paging<SimpleAlbum>;
  playlists?: Paging<SimplePlaylist | null>;
}

export interface Queue {
  currently_playing: Track | null;
  queue: Track[];
}
