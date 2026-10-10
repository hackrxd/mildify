// A DJ set's menu on the DJ page, from its "…" button or a right-click on its name: skip it, copy its songs, and
// whatever else is added for sets, such as saving one as a playlist, or an extension's entry.
import { dj, type DjSet } from "./dj.svelte";
import { addedItems, type AddedItem, type MenuItem } from "./menu.svelte";
import { toasts } from "./toasts.svelte";
import { copyText } from "./util";

let added: AddedItem<DjSet>[] = [];

/** Adds an entry to every set's menu, after the DJ's own; returns its remover. Guarded as extensions' track entries
 * are: one whose label or `when` throws is left out, and an action that fails says so. */
export function addSetAction(item: AddedItem<DjSet>): () => void {
  added = [...added, item];
  return () => {
    added = added.filter((i) => i !== item);
  };
}

/** A set's songs as text to paste: its name, then a numbered line per song. */
export function songList(set: DjSet): string {
  return [set.name, ...set.songs.map((s, i) => `${i + 1}. ${s.name} by ${s.artists.join(", ")}`)].join("\n");
}

/** The menu for `set`. Skip is only for the set playing, and greyed out while it can't be skipped. */
export function setMenu(set: DjSet): MenuItem[] {
  const playing = set.id === dj.current?.id;
  return [
    ...(playing ? [{ label: "Skip this set", action: () => void dj.skipSet(), disabled: !dj.canSkipSet(set) }] : []),
    {
      label: "Copy the song list",
      action: () => void copyText(songList(set)).then(() => toasts.show("Copied the song list"), (e) => toasts.error(e)),
    },
    ...addedItems(added, set),
  ];
}
