// A track's right-click menu, wherever it's listed: queue it, like it, go to its album or artists, and what
// extensions add.
import { liked } from "./liked.svelte";
import type { MenuItem } from "./menu.svelte";
import { mods } from "./mods.svelte";
import { player } from "./player.svelte";
import { router } from "./router.svelte";
import type { SimpleTrack, Track } from "./types";

/** Artists past this many get no entry of their own. */
const ARTISTS_MAX = 3;

/** The menu for `t`. `queue: false` leaves out Add to queue, where queueing would get in the way (the DJ's songs). */
export function trackMenu(t: SimpleTrack | Track, { queue = true } = {}): MenuItem[] {
  const album = "album" in t ? t.album : null;
  const saved = liked.has(t.uri);
  return [
    ...(queue ? [{ label: "Add to queue", action: () => player.addToQueue(t.uri) }] : []),
    {
      label: saved ? "Remove from Liked Songs" : "Save to Liked Songs",
      action: () => liked.toggle(t.uri),
      disabled: saved === undefined,
    },
    ...(album ? [{ label: "Go to album", action: () => router.go({ name: "album", id: album.id }) }] : []),
    ...t.artists.slice(0, ARTISTS_MAX).map((a) => ({
      label: t.artists.length > 1 ? `Go to ${a.name}` : "Go to artist",
      action: () => router.go({ name: "artist", id: a.id }),
    })),
    ...mods.trackMenu(t),
  ];
}
