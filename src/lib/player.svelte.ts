// Playback state and controls.
//
// Selection ("play this album from track 3") always goes through the Web API,
// targeting a Spotify Connect device — normally our embedded librespot device.
// When our device is the active one, transport controls go straight to it
// (no network round-trip) and its events keep the UI current in real time;
// otherwise we control whichever device is active through the Web API and poll.

import { listen } from "@tauri-apps/api/event";
import { backend, isAppError, type DeviceCommand, type LocalEvent, type RepeatMode } from "./ipc";
import { session } from "./session.svelte";
import * as sp from "./spotify";
import { toasts } from "./toasts.svelte";
import type { Device, PlaybackState, Track } from "./types";
import { debounce, pickImage } from "./util";

export interface NowPlaying {
  uri: string;
  name: string;
  artists: { name: string; uri: string }[];
  album: { name: string; uri: string | null };
  cover: string | null;
  /** Largest available art (for full-size displays such as the lyrics view). */
  coverLarge: string | null;
  durationMs: number;
  explicit: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Periodic position reports closer than this to our running clock are just jitter. */
const LOCAL_RESYNC_THRESHOLD_MS = 80;

function fromWebTrack(t: Track): NowPlaying {
  const images = t.album?.images ?? (t as unknown as { images?: [] }).images;
  return {
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => ({ name: a.name, uri: a.uri })),
    album: { name: t.album?.name ?? "", uri: t.album?.uri ?? null },
    cover: pickImage(images, 300),
    coverLarge: pickImage(images, 640),
    durationMs: t.duration_ms,
    explicit: t.explicit,
  };
}

class Player {
  track = $state<NowPlaying | null>(null);
  isPlaying = $state(false);
  isLoading = $state(false);
  shuffle = $state(false);
  repeat = $state<RepeatMode>("off");
  volume = $state(50);
  supportsVolume = $state(true);
  deviceId = $state<string | null>(null);
  deviceName = $state<string | null>(null);
  contextUri = $state<string | null>(null);
  devices = $state<Device[]>([]);

  #positionMs = $state(0);
  #positionAt = $state(0);
  #now = $state(performance.now());
  #lastLocalEvent = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #backoffUntil = 0;

  position = $derived.by(() => {
    const p = this.isPlaying ? this.#positionMs + (this.#now - this.#positionAt) : this.#positionMs;
    return Math.max(0, Math.min(p, this.track?.durationMs ?? p));
  });

  /** Position interpolated to this instant (for per-frame consumers like the lyrics renderer). */
  positionNow(): number {
    const p = this.isPlaying ? this.#positionMs + (performance.now() - this.#positionAt) : this.#positionMs;
    return Math.max(0, Math.min(p, this.track?.durationMs ?? p));
  }

  /** Our embedded device is the one currently playing. */
  isLocal = $derived.by(() => {
    const local = session.device;
    if (!this.deviceId || !local) return false;
    return this.deviceId === local.device_id || this.deviceName === local.name;
  });

  async start() {
    await listen<LocalEvent>("local-player", (e) => this.#onLocal(e.payload));
    setInterval(() => {
      if (this.isPlaying) this.#now = performance.now();
    }, 250);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.refreshSoon(0);
    });
    this.refreshSoon(0);
  }

  #setPosition(ms: number) {
    this.#positionMs = ms;
    this.#positionAt = performance.now();
    this.#now = this.#positionAt;
  }

  refreshSoon(ms = 600) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#refresh(), ms);
  }

  async #refresh() {
    let next = document.hidden ? 15000 : this.isLocal ? 5000 : 3000;
    if (session.ready && Date.now() >= this.#backoffUntil) {
      try {
        this.#apply(await sp.playbackState());
      } catch (e) {
        if (isAppError(e) && e.kind === "rate_limited") {
          const seconds = Number(e.message.match(/(\d+)s/)?.[1] ?? 30);
          this.#backoffUntil = Date.now() + seconds * 1000;
        }
        next = Math.max(next, 10000);
      }
    }
    this.refreshSoon(next);
  }

  #apply(s: PlaybackState | null) {
    if (!s || !s.device) {
      this.deviceId = null;
      this.deviceName = null;
      this.isPlaying = false;
      return;
    }
    this.deviceId = s.device.id;
    this.deviceName = s.device.name;
    this.supportsVolume = s.device.supports_volume ?? s.device.volume_percent !== null;
    this.shuffle = s.shuffle_state;
    this.repeat = s.repeat_state;
    this.contextUri = s.context?.uri ?? null;

    // Local events are fresher than a poll that may have been in flight.
    const localFresh = this.isLocal && performance.now() - this.#lastLocalEvent < 2500;
    if (s.device.volume_percent !== null && !localFresh) this.volume = s.device.volume_percent;
    if (s.item) {
      // Keep the same object while nothing visible changed, so views keyed on the
      // track don't re-render on every poll.
      const next = fromWebTrack(s.item);
      const cur = this.track;
      if (!cur || cur.uri !== next.uri || cur.album.uri !== next.album.uri || cur.cover !== next.cover) {
        this.track = next;
      }
    }
    if (!localFresh) this.isPlaying = s.is_playing;
    // Our own device reports its position directly; the Web API's figure is the
    // server extrapolating those same reports, plus request latency.
    if (!this.isLocal) this.#setPosition(s.progress_ms ?? 0);
  }

  #onLocal(ev: LocalEvent) {
    this.#lastLocalEvent = performance.now();
    const local = session.device;
    switch (ev.type) {
      case "playing":
        this.isPlaying = true;
        this.isLoading = false;
        this.#setPosition(ev.position_ms);
        if (local) {
          this.deviceId = local.device_id;
          this.deviceName = local.name;
        }
        break;
      case "paused":
        this.isPlaying = false;
        this.isLoading = false;
        this.#setPosition(ev.position_ms);
        break;
      case "loading":
        this.isLoading = true;
        this.#setPosition(ev.position_ms);
        break;
      case "seeked":
        this.#setPosition(ev.position_ms);
        break;
      case "position":
        if (Math.abs(this.positionNow() - ev.position_ms) > LOCAL_RESYNC_THRESHOLD_MS) this.#setPosition(ev.position_ms);
        break;
      case "stopped":
        // Usually means playback was transferred away from us.
        this.isPlaying = false;
        this.isLoading = false;
        this.refreshSoon(800);
        break;
      case "unavailable":
        toasts.show("That track isn't available to play, skipping it", "error");
        break;
      case "track": {
        const sameTrack = this.track?.uri === ev.uri;
        this.track = {
          uri: ev.uri,
          name: ev.name,
          artists: ev.artists,
          album: { name: ev.album, uri: sameTrack ? this.track!.album.uri : null },
          cover: ev.cover ?? (sameTrack ? this.track!.cover : null),
          // librespot reports the largest cover it has.
          coverLarge: ev.cover ?? (sameTrack ? this.track!.coverLarge : null),
          durationMs: ev.duration_ms,
          explicit: ev.explicit,
        };
        // Fetch the album link and context the local event doesn't carry.
        this.refreshSoon(1200);
        break;
      }
      case "volume":
        if (this.isLocal) this.volume = ev.percent;
        break;
      case "shuffle":
        this.shuffle = ev.on;
        break;
      case "repeat":
        this.repeat = ev.track ? "track" : ev.context ? "context" : "off";
        break;
    }
  }

  /** Runs a transport command locally when we're the active device, else via the Web API. */
  async #control(local: DeviceCommand, remote: () => Promise<unknown>, optimistic?: () => void) {
    optimistic?.();
    try {
      if (this.isLocal && session.deviceReady) await backend.device(local);
      else await remote();
    } catch (e) {
      toasts.error(e);
    }
    this.refreshSoon(this.isLocal ? 1500 : 700);
  }

  async togglePlay() {
    if (!this.deviceId) {
      // Nothing is active anywhere: wake our own device and resume there.
      if (session.deviceReady && session.device) return this.transferTo(session.device.device_id, true);
      return toasts.show("Nothing is playing. Pick something to play first.");
    }
    const playing = this.isPlaying;
    const dev = this.deviceId;
    await this.#control(
      { action: playing ? "pause" : "play" },
      () => (playing ? sp.pause(dev) : sp.play(dev)),
      () => {
        this.#setPosition(this.position);
        this.isPlaying = !playing;
      },
    );
  }

  next() {
    const dev = this.deviceId ?? undefined;
    return this.#control({ action: "next" }, () => sp.skipNext(dev));
  }

  prev() {
    const dev = this.deviceId ?? undefined;
    return this.#control({ action: "prev" }, () => sp.skipPrevious(dev));
  }

  seek(ms: number) {
    const dev = this.deviceId ?? undefined;
    return this.#control({ action: "seek", position_ms: Math.round(ms) }, () => sp.seek(ms, dev), () =>
      this.#setPosition(ms),
    );
  }

  #remoteVolume = debounce((percent: number, dev?: string) => {
    sp.setVolume(percent, dev).catch((e) => toasts.error(e));
  }, 250);

  setVolume(percent: number) {
    const p = Math.round(Math.max(0, Math.min(100, percent)));
    this.volume = p;
    if (this.isLocal && session.deviceReady) {
      backend.device({ action: "volume", percent: p }).catch((e) => toasts.error(e));
    } else if (this.deviceId) {
      this.#remoteVolume(p, this.deviceId);
    }
  }

  toggleShuffle() {
    const on = !this.shuffle;
    const dev = this.deviceId ?? undefined;
    return this.#control({ action: "shuffle", on }, () => sp.setShuffle(on, dev), () => (this.shuffle = on));
  }

  cycleRepeat() {
    const mode: RepeatMode = this.repeat === "off" ? "context" : this.repeat === "context" ? "track" : "off";
    const dev = this.deviceId ?? undefined;
    return this.#control({ action: "repeat", mode }, () => sp.setRepeat(mode, dev), () => (this.repeat = mode));
  }

  /** Plays an album/playlist/artist, optionally starting at a given track. */
  playContext(contextUri: string, startUri?: string) {
    return this.#play({ context_uri: contextUri, offset: startUri ? { uri: startUri } : undefined });
  }

  /** Plays an explicit list of tracks starting at `index`. */
  playUris(uris: string[], index = 0) {
    return this.#play({ uris, offset: { position: index } });
  }

  async #play(body: sp.PlayRequest) {
    const local = session.deviceReady ? session.device : null;
    const target = this.deviceId ?? local?.device_id;
    if (!target) {
      toasts.show("No playback device is available. Check the built-in player in Settings.", "error");
      return;
    }
    try {
      await sp.play(target, body);
    } catch (e) {
      // A freshly started Connect device may not be targetable until it's been activated once.
      if (isAppError(e) && e.status === 404 && local && target === local.device_id) {
        try {
          await sp.transfer(local.device_id, false);
          await sleep(500);
          await sp.play(local.device_id, body);
        } catch (e2) {
          toasts.error(e2);
        }
      } else {
        toasts.error(e);
      }
    }
    this.refreshSoon(800);
  }

  async transferTo(deviceId: string, play = true) {
    try {
      await sp.transfer(deviceId, play);
      this.deviceId = deviceId;
      this.deviceName = this.devices.find((d) => d.id === deviceId)?.name ?? this.deviceName;
    } catch (e) {
      toasts.error(e);
    }
    this.refreshSoon(900);
  }

  async loadDevices() {
    try {
      this.devices = await sp.devices();
    } catch (e) {
      toasts.error(e);
    }
  }

  async addToQueue(uri: string) {
    try {
      await sp.addToQueue(uri, this.deviceId ?? undefined);
      toasts.show("Added to queue");
    } catch (e) {
      toasts.error(e);
    }
  }
}

export const player = new Player();
