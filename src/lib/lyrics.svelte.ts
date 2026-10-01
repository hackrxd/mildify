// Connects the Spicy Lyrics renderer to the app: implements its host (playback
// position, track, seeking, fetching) and tracks what the lyrics view must credit.

import { openUrl } from "@tauri-apps/plugin-opener";
import { setHost, type HostTrack } from "spicy-lyrics-renderer";
import { backend, isAppError, type LyricsServerStatus } from "./ipc";
import { player } from "./player.svelte";
import { toasts } from "./toasts.svelte";

export interface Credit {
  username: string;
  url: string | null;
}

/** What the API terms require on screen alongside the lyrics. */
export interface Attribution {
  trackId: string;
  /** "Spicy Lyrics community", "Apple Music" or "Spotify". */
  provider: string;
  community: boolean;
  maker: Credit | null;
  uploader: Credit | null;
}

const PROVIDERS: Record<string, string> = {
  spicy_lyrics: "the Spicy Lyrics community",
  apple_music: "Apple Music",
  spotify: "Spotify",
};

function credit(user: unknown): Credit | null {
  const u = user as { username?: unknown; url?: unknown } | null | undefined;
  if (!u || typeof u.username !== "string") return null;
  return { username: u.username, url: typeof u.url === "string" ? u.url : null };
}

class Lyrics {
  /** Attribution for the most recently fetched track's lyrics. */
  attribution = $state<Attribution | null>(null);
  server = $state<LyricsServerStatus | null>(null);
  /** The lyrics service rejected our token; the view offers sign-in. */
  needsSignIn = $state(false);
  /** Lyrics fill the window (sidebar and top bar hidden). */
  immersive = $state(false);
  #installed = false;

  install() {
    if (this.#installed) return;
    this.#installed = true;
    setHost({
      position: () => player.positionNow(),
      isPlaying: () => player.isPlaying,
      track: (): HostTrack | null => {
        const t = player.track;
        if (!t) return null;
        const [, kind, id] = t.uri.split(":");
        return {
          uri: t.uri,
          id: id ?? "",
          name: t.name,
          album: t.album.name,
          artists: t.artists,
          cover: t.coverLarge ?? t.cover,
          durationMs: t.durationMs,
          type: kind === "track" ? "track" : kind === "episode" ? "episode" : kind === "local" ? "local" : "unknown",
        };
      },
      seek: (ms) => player.seek(ms),
      fetchLyrics: (trackId) => this.#fetch(trackId),
      openUrl: (url) => {
        openUrl(url).catch((e) => toasts.error(e));
      },
    });
  }

  /** Rate limits are usually brief (the API answers Retry-After: 10), so wait one out before giving up. */
  async #lyricsWithRetry(trackId: string): Promise<unknown | null> {
    try {
      return await backend.lyrics(trackId);
    } catch (e) {
      const seconds = isAppError(e) && e.kind === "rate_limited" ? Number(e.message.match(/(\d+)s/)?.[1] ?? 0) : 0;
      if (seconds > 0 && seconds <= 15 && player.track?.uri.endsWith(trackId)) {
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return await backend.lyrics(trackId);
      }
      throw e;
    }
  }

  async #fetch(trackId: string): Promise<unknown | null> {
    try {
      const response = await this.#lyricsWithRetry(trackId);
      this.needsSignIn = false;
      const body = (response as { Body?: Record<string, unknown> } | null)?.Body;
      if (body) {
        const source = String(body.source ?? "");
        const upload = body.UploadAttribution as { Maker?: unknown; Uploader?: unknown } | undefined;
        this.attribution = {
          trackId,
          provider: PROVIDERS[source] ?? (source || "an unknown provider"),
          community: source === "spicy_lyrics",
          maker: credit(upload?.Maker),
          uploader: credit(upload?.Uploader),
        };
      } else if (this.attribution?.trackId === trackId) {
        this.attribution = null;
      }
      return response;
    } catch (e) {
      if (isAppError(e) && e.status === 401) {
        this.needsSignIn = true;
        this.refreshServer();
      }
      throw e;
    }
  }

  /** Attribution for the track that's playing, if its lyrics are loaded. */
  current = $derived.by(() => {
    const id = player.track?.uri.split(":")[2];
    return this.attribution && this.attribution.trackId === id ? this.attribution : null;
  });

  async refreshServer() {
    try {
      this.server = await backend.lyricsServerStatus();
    } catch (e) {
      toasts.error(e);
    }
  }

  async signIn(username: string, password: string): Promise<boolean> {
    try {
      this.server = await backend.lyricsServerLogin(username, password);
      this.needsSignIn = false;
      return true;
    } catch (e) {
      toasts.error(e);
      return false;
    }
  }

  async signOut() {
    try {
      this.server = await backend.lyricsServerLogout();
    } catch (e) {
      toasts.error(e);
    }
  }
}

export const lyrics = new Lyrics();
