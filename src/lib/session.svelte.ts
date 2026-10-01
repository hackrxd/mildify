import { listen } from "@tauri-apps/api/event";
import { backend, isAppError, onAuthLost, type AppStatus, type Config, type DeviceStatus } from "./ipc";
import { allPages, me, myPlaylists } from "./spotify";
import { toasts } from "./toasts.svelte";
import type { SimplePlaylist, User } from "./types";

class Session {
  status = $state<AppStatus | null>(null);
  user = $state<User | null>(null);
  playlists = $state<SimplePlaylist[]>([]);
  signingIn = $state(false);

  /** Web API is usable: a client ID is set and we hold a token for it. */
  ready = $derived(!!this.status?.config.client_id && !!this.status?.signed_in);
  device = $derived(this.status?.device ?? null);
  deviceReady = $derived(this.status?.device.state === "ready");

  async init() {
    await listen<DeviceStatus>("device-status", (e) => {
      if (this.status) this.status.device = e.payload;
    });
    onAuthLost(() => {
      if (this.status) this.status.signed_in = false;
    });
    this.status = await backend.status();
    if (this.ready) await this.loadUser();
  }

  async loadUser() {
    try {
      this.user = await me();
      await this.loadPlaylists();
    } catch (e) {
      toasts.error(e);
    }
  }

  async loadPlaylists() {
    this.playlists = await allPages(await myPlaylists(), 500);
  }

  /** Signs in to whatever is missing (Web API, playback device) via the browser. */
  async signIn() {
    this.signingIn = true;
    try {
      this.status = await backend.signIn();
      if (!this.user) await this.loadUser();
    } catch (e) {
      if (!(isAppError(e) && e.kind === "cancelled")) toasts.error(e);
      this.status = await backend.status();
    } finally {
      this.signingIn = false;
    }
  }

  async cancelSignIn() {
    await backend.cancelSignIn();
  }

  async signOut() {
    this.status = await backend.signOut();
    this.user = null;
    this.playlists = [];
  }

  async saveSettings(settings: Partial<Pick<Config, "client_id" | "device_name" | "bitrate" | "normalisation">>) {
    try {
      this.status = await backend.saveSettings(settings);
    } catch (e) {
      toasts.error(e);
    }
  }

  async restartDevice() {
    await backend.restartDevice();
  }
}

export const session = new Session();
