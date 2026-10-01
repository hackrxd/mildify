// Spicy Lyrics (https://github.com/Spikerko/spicy-lyrics), AGPL-3.0.
// Modified for Native Spotify: rewritten as a stub. Upstream fetches artist header
// images through Spotify's private GraphQL API for the "artist header" static
// background mode; that API isn't available here, so the mode falls back to cover art.

const ArtistVisuals = {
  CacheStore: null,
  ApplyContent: async (_artistId: string, _trackId: string): Promise<string | undefined> => undefined,
};

export default ArtistVisuals;
