import type { CoverItem } from "../components/CoverGrid.svelte";
import { player } from "./player.svelte";
import { router } from "./router.svelte";
import type { Artist, SimpleAlbum, SimplePlaylist } from "./types";
import { pickImage, year } from "./util";

const albumKind = { album: "Album", single: "Single", compilation: "Compilation" } as const;

export const albumItem = (a: SimpleAlbum, subtitle: "artist" | "year" = "artist"): CoverItem => ({
  key: a.id,
  title: a.name,
  subtitle:
    subtitle === "artist"
      ? a.artists.map((x) => x.name).join(", ")
      : `${year(a.release_date)} ${albumKind[a.album_type] ?? ""}`.trim(),
  image: pickImage(a.images, 300),
  open: () => router.go({ name: "album", id: a.id }),
  play: () => player.playContext(a.uri),
});

export const artistItem = (a: Artist): CoverItem => ({
  key: a.id,
  title: a.name,
  subtitle: "Artist",
  image: pickImage(a.images, 300),
  round: true,
  open: () => router.go({ name: "artist", id: a.id }),
  play: () => player.playContext(a.uri),
});

export const playlistItem = (p: SimplePlaylist): CoverItem => ({
  key: p.id,
  title: p.name,
  subtitle: `By ${p.owner.display_name ?? p.owner.id}`,
  image: pickImage(p.images, 300),
  open: () => router.go({ name: "playlist", id: p.id }),
  play: () => player.playContext(p.uri),
});
