// The window's side of the DevTools endpoint (devtools.rs), which stands in for the Spotify app's
// debug port so mild-lyrics can follow this player. The backend recognises the scripts mild-lyrics
// sends there and asks here only for what they stand for: the player's state, or one control.
// Nothing sent to the port runs in the window.

import { listen } from "@tauri-apps/api/event";
import { dj } from "./dj.svelte";
import { backend } from "./ipc";
import { player } from "./player.svelte";

/** Mirrors `Ask` in devtools.rs. */
export type DevtoolsAsk =
  | { action: "snapshot" }
  | { action: "seek"; position_ms: number }
  | { action: "volume"; fraction: number }
  | { action: "toggle_play" | "next" | "back" };

/** The player as devtools.rs reads it (`Snapshot`). */
export function snapshot() {
  const t = player.track;
  return {
    track: t && {
      uri: t.uri,
      name: t.name,
      artists: t.artists,
      album: t.album,
      art: t.coverLarge ?? t.cover,
      duration_ms: t.durationMs,
      explicit: t.explicit,
    },
    position_ms: player.positionNow(),
    playing: player.isPlaying,
    volume: player.volume,
  };
}

/** Does what's asked; a control answers once it's done, as Spicetify's promise resolves. */
export async function act(ask: DevtoolsAsk): Promise<unknown> {
  switch (ask.action) {
    case "snapshot":
      return snapshot();
    case "seek":
      // While the DJ talks between songs, the song under it isn't the listener's to move.
      if (!dj.onAir) await player.seek(ask.position_ms);
      break;
    case "volume":
      player.setVolume(ask.fraction * 100);
      break;
    // As the player bar's buttons do, these act on the DJ's talk while it's the item playing.
    case "toggle_play":
      await dj.togglePause();
      break;
    case "next":
      await dj.skipTalk();
      break;
    case "back":
      if (!dj.onAir) await player.prev();
      break;
  }
  return null;
}

/** Answers the backend's asks for as long as the window is open. */
export async function startDevtools() {
  await listen<{ id: number; ask: DevtoolsAsk }>("devtools-ask", async (e) => {
    const { id, ask } = e.payload;
    const value = await act(ask).catch(() => null);
    await backend.devtoolsAnswer(id, value).catch(() => {});
  });
}
