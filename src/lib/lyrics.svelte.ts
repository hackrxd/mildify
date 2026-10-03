// Connects the Spicy Lyrics renderer to the app: implements its host (playback
// position, track, seeking, fetching) and tracks what the lyrics view must credit.

import { openUrl } from "@tauri-apps/plugin-opener";
import { setHost, type HostTrack } from "spicy-lyrics-renderer";
import { backend, isAppError, type LyricsServerStatus } from "./ipc";
import { player } from "./player.svelte";
import * as sp from "./spotify";
import { toasts } from "./toasts.svelte";
import { lyricsText } from "./lyricLines";
import { copyText, debounce, upcomingTrackIds } from "./util";

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

const OFFSET_KEY = "nativify:lyricsOffsetMs";
const IN_DECK_KEY = "nativify:lyricsInDeck";
const WARMUP_KEY = "nativify:lyricsWarmup";
const SONG_OFFSETS_KEY = "nativify:lyricsSongOffsets";
const TEXT_SCALE_KEY = "nativify:lyricsTextScale";
export const WARMUP_DEFAULT = 20;
/** Spotify's queue endpoint only lists the next 20 songs. */
export const WARMUP_MAX = 20;
/** Wait for the queue to settle after a track change (and for skipping through to stop). */
const WARMUP_DELAY_MS = 200;

/** Per-song nudges fix syncs that are off, which can be by more than headphone delay. */
export const SONG_OFFSET_MAX = 10_000;
/** How many songs' own timings are remembered; the least recently adjusted are dropped first. */
export const SONG_OFFSETS_KEPT = 1000;
export const TEXT_SCALE_MIN = 0.7;
export const TEXT_SCALE_MAX = 1.6;
export const TEXT_SCALE_STEP = 0.1;

function trackIdOf(uri: string | undefined): string | null {
  return uri?.startsWith("spotify:track:") ? uri.split(":")[2] : null;
}

function persist(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applies for this session.
  }
}

function loadSongOffsets(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SONG_OFFSETS_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [id, ms] of Object.entries(raw)) {
      if (typeof ms === "number" && Number.isFinite(ms) && ms !== 0) {
        out[id] = Math.max(-SONG_OFFSET_MAX, Math.min(SONG_OFFSET_MAX, Math.round(ms)));
      }
    }
    return out;
  } catch {
    return {};
  }
}

function clampScale(scale: number): number {
  const stepped = Math.round(scale / TEXT_SCALE_STEP) * TEXT_SCALE_STEP;
  // Rounded to tenths so steps don't drift (0.7 + 0.1 is 0.7999…).
  return Math.round(Math.max(TEXT_SCALE_MIN, Math.min(TEXT_SCALE_MAX, stepped)) * 100) / 100;
}

function loadTextScale(): number {
  try {
    const v = Number(localStorage.getItem(TEXT_SCALE_KEY) ?? 1);
    return Number.isFinite(v) && v > 0 ? clampScale(v) : 1;
  } catch {
    return 1;
  }
}

function loadOffset(): number {
  try {
    const v = Number(localStorage.getItem(OFFSET_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function loadWarmup(): number {
  try {
    const v = localStorage.getItem(WARMUP_KEY);
    const n = v === null ? WARMUP_DEFAULT : Number(v);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, WARMUP_MAX) : WARMUP_DEFAULT;
  } catch {
    return WARMUP_DEFAULT;
  }
}

function loadInDeck(): boolean {
  try {
    return localStorage.getItem(IN_DECK_KEY) !== "false";
  } catch {
    return true;
  }
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
  /** User timing nudge in ms: positive shows lyrics later, negative earlier. */
  offsetMs = $state(loadOffset());
  /** Show the current line in the player bar. */
  inDeck = $state(loadInDeck());
  /** How many upcoming songs to fetch lyrics for ahead of time; 0 turns it off. */
  warmup = $state(loadWarmup());
  /** Per-song timing nudges in ms by track id, on top of `offsetMs`, for syncs that are off. */
  songOffsets = $state.raw<Record<string, number>>(loadSongOffsets());
  /** Lyrics text size, relative to the renderer's own. */
  textScale = $state(loadTextScale());
  /** The most recently fetched lyrics, so they can be copied as text. */
  #loaded = $state.raw<{ trackId: string; response: unknown } | null>(null);
  #trackId = $derived(trackIdOf(player.track?.uri));
  /** The playing song's own nudge. */
  songOffsetMs = $derived(this.#trackId ? (this.songOffsets[this.#trackId] ?? 0) : 0);
  /** What the lyrics clock is shifted by: the global offset plus the playing song's own. */
  totalOffsetMs = $derived(this.offsetMs + this.songOffsetMs);
  songOffsetCount = $derived(Object.keys(this.songOffsets).length);
  /** Whether the playing song's lyrics are loaded and have text to copy. */
  hasText = $derived(this.#loaded?.trackId === this.#trackId && lyricsText(this.#loaded?.response) !== "");
  /** Track id the backend's cache is following, so its lyrics can be dropped once it's played. */
  #playing: string | null = null;

  setOffset(ms: number) {
    this.offsetMs = Math.round(ms);
    try {
      localStorage.setItem(OFFSET_KEY, String(this.offsetMs));
    } catch {
      // Not persisted; still applies for this session.
    }
  }

  /** Sets the playing song's own nudge; 0 forgets it. */
  setSongOffset(ms: number) {
    const id = this.#trackId;
    if (!id) return;
    const value = Math.max(-SONG_OFFSET_MAX, Math.min(SONG_OFFSET_MAX, Math.round(ms)));
    const { [id]: _, ...next } = this.songOffsets;
    // Re-added at the end, so the oldest adjustments are the ones dropped past the cap.
    if (value !== 0) next[id] = value;
    const ids = Object.keys(next);
    for (const old of ids.slice(0, Math.max(0, ids.length - SONG_OFFSETS_KEPT))) delete next[old];
    this.songOffsets = next;
    persist(SONG_OFFSETS_KEY, JSON.stringify(next));
  }

  nudgeSong(deltaMs: number) {
    this.setSongOffset(this.songOffsetMs + deltaMs);
  }

  forgetSongOffsets() {
    this.songOffsets = {};
    persist(SONG_OFFSETS_KEY, null);
  }

  setTextScale(scale: number) {
    this.textScale = clampScale(scale);
    persist(TEXT_SCALE_KEY, this.textScale === 1 ? null : String(this.textScale));
  }

  /** Copies the playing song's lyrics; the romanization where there is one, when asked. */
  async copy(romanized = false) {
    const loaded = this.#loaded;
    const text = loaded?.trackId === this.#trackId ? lyricsText(loaded?.response, romanized) : "";
    if (!text) return;
    try {
      await copyText(text);
      toasts.show("Lyrics copied");
    } catch (e) {
      toasts.error(e);
    }
  }

  setInDeck(on: boolean) {
    this.inDeck = on;
    try {
      localStorage.setItem(IN_DECK_KEY, String(on));
    } catch {
      // Not persisted; still applies for this session.
    }
  }

  setWarmup(count: number) {
    this.warmup = Math.min(WARMUP_MAX, Math.max(0, Math.round(count)));
    try {
      localStorage.setItem(WARMUP_KEY, String(this.warmup));
    } catch {
      // Not persisted; still applies for this session.
    }
    this.#warmSoon();
  }

  /**
   * Call on every track change. The backend caches lyrics only until their song has played,
   * so the next play gets the latest sync; this drops the finished one and warms up what's next.
   */
  trackChanged(uri: string | undefined) {
    const id = trackIdOf(uri);
    if (id === this.#playing) return;
    const played = this.#playing;
    this.#playing = id;
    if (played) backend.forgetLyrics(played).catch(() => {});
    this.#warmSoon();
  }

  #warmSoon = debounce(() => this.#warm(), WARMUP_DELAY_MS);

  async #warm() {
    if (this.warmup <= 0 || !this.#playing) return;
    try {
      const ids = upcomingTrackIds(await sp.queue(), this.#playing, this.warmup);
      if (ids.length) await backend.warmLyrics(ids);
    } catch {
      // Best effort: the lyrics view fetches anything that wasn't warmed up.
    }
  }

  /** Lyrics for the player bar's line: null instead of an error, which the lyrics view reports. */
  async fetchQuietly(trackId: string): Promise<unknown | null> {
    try {
      return await this.#fetch(trackId);
    } catch {
      return null;
    }
  }

  #installed = false;

  install() {
    if (this.#installed) return;
    this.#installed = true;
    setHost({
      position: () => Math.max(0, player.positionNow() - this.totalOffsetMs),
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
      // Lyric times are on the offset clock; map back to the audio's.
      seek: (ms) => player.seek(Math.max(0, ms + this.totalOffsetMs)),
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
      this.#loaded = { trackId, response };
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
