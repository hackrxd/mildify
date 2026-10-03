// Spicy Lyrics (https://github.com/Spikerko/spicy-lyrics), AGPL-3.0.
// Modified for Mildify: rewritten. Upstream reads the Spicetify player;
// this reads Mildify's player through compat/host.ts. Only the members the
// vendored renderer uses are implemented.

import { host } from "../../../compat/host.ts";

// Upstream points at images.spikerko.org; a transparent pixel avoids a network fetch.
export const COVER_PLACEHOLDER_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export type CoverSizes = "standard" | "small" | "large" | "xlarge";
export type Artist = {
  type: "artist";
  name: string;
  uri: string;
};

/** Express i.scdn.co covers as `spotify:image:` URIs, the form the renderer expects. */
function asSpotifyImage(url: string | null | undefined): string {
  if (!url) return COVER_PLACEHOLDER_URL;
  const m = url.match(/^https:\/\/i\.scdn\.co\/image\/([0-9a-f]+)$/i);
  return m ? `spotify:image:${m[1]}` : url;
}

export const SpotifyPlayer = {
  get IsPlaying(): boolean {
    return host.isPlaying();
  },
  GetPosition: (): number => host.position(),
  GetContentType: (): string => {
    const t = host.track();
    if (!t) return "unknown";
    return t.type === "local" ? "track" : t.type;
  },
  GetMediaType: (): string => "audio",
  GetDuration: (): number => host.track()?.durationMs ?? 0,
  Seek: (position: number): void => host.seek(position),
  GetCover: (_size: CoverSizes): string | undefined => asSpotifyImage(host.track()?.cover),
  GetName: (): string | undefined => host.track()?.name,
  GetAlbumName: (): string | undefined => host.track()?.album,
  GetId: (): string | undefined => host.track()?.id,
  GetArtists: (): Artist[] | undefined =>
    host.track()?.artists.map((a) => ({ type: "artist" as const, name: a.name, uri: a.uri })),
  GetUri: (): string | undefined => host.track()?.uri,
  IsDJ: (): boolean => false,
  LoopType: "none",
  ShuffleType: "none",
};
