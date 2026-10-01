<script lang="ts">
  import CoverGrid from "../components/CoverGrid.svelte";
  import Icon from "../components/Icon.svelte";
  import Status from "../components/Status.svelte";
  import ViewHeader from "../components/ViewHeader.svelte";
  import { albumItem } from "../lib/covers";
  import { errorMessage } from "../lib/ipc";
  import { player } from "../lib/player.svelte";
  import * as sp from "../lib/spotify";
  import type { Artist, SimpleAlbum } from "../lib/types";
  import { pickImage } from "../lib/util";

  let { id }: { id: string } = $props();

  let artist = $state<Artist | null>(null);
  let albums = $state<SimpleAlbum[]>([]);
  let error = $state<string | null>(null);

  async function load(artistId: string) {
    artist = null;
    albums = [];
    error = null;
    try {
      const [a, firstPage] = await Promise.all([sp.artist(artistId), sp.artistAlbums(artistId)]);
      if (artistId !== id) return;
      artist = a;
      albums = firstPage.items;
      if (firstPage.next) {
        const all = await sp.allPages(firstPage, 300);
        if (artistId === id) albums = all;
      }
    } catch (e) {
      if (artistId === id) error = errorMessage(e);
    }
  }

  $effect(() => {
    load(id);
  });

  const byNewest = (list: SimpleAlbum[]) => [...list].sort((a, b) => b.release_date.localeCompare(a.release_date));
  const sections = $derived([
    { title: "Albums", items: byNewest(albums.filter((a) => a.album_type === "album")) },
    { title: "Singles and EPs", items: byNewest(albums.filter((a) => a.album_type === "single")) },
    { title: "Compilations", items: byNewest(albums.filter((a) => a.album_type === "compilation")) },
  ].filter((s) => s.items.length));

  const playingHere = $derived(!!artist && player.contextUri === artist.uri && player.isPlaying);

  function playAll() {
    if (!artist) return;
    if (player.contextUri === artist.uri && player.track) player.togglePlay();
    else player.playContext(artist.uri);
  }
</script>

{#if artist}
  <ViewHeader image={pickImage(artist.images, 640)} kind="Artist" title={artist.name} round>
    {#snippet meta()}
      {#if artist!.genres?.length}<span class="genres">{artist!.genres.slice(0, 4).join(", ")}</span>{/if}
    {/snippet}
    {#snippet actions()}
      <button class="play-fab" onclick={playAll} title={playingHere ? "Pause" : "Play"}>
        <Icon name={playingHere ? "pause" : "play"} size={22} />
      </button>
    {/snippet}
  </ViewHeader>

  <div class="body">
    {#each sections as s (s.title)}
      <section>
        <h2>{s.title}</h2>
        <CoverGrid items={s.items.map((a) => albumItem(a, "year"))} />
      </section>
    {:else}
      <p class="muted">No releases found.</p>
    {/each}
  </div>
{:else}
  <Status {error} onretry={() => load(id)} />
{/if}

<style>
  .body {
    display: grid;
    gap: 40px;
    padding: 4px var(--gutter) 40px;
  }
  section h2 {
    margin-bottom: 16px;
  }
  .genres {
    text-transform: capitalize;
  }
</style>
