<script lang="ts">
  import CoverGrid from "../components/CoverGrid.svelte";
  import Status from "../components/Status.svelte";
  import { albumItem } from "../lib/covers";
  import { errorMessage } from "../lib/ipc";
  import * as sp from "../lib/spotify";
  import type { SimpleAlbum } from "../lib/types";

  let albums = $state<SimpleAlbum[] | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    error = null;
    try {
      const saved = await sp.allPages(await sp.savedAlbums(), 1000);
      albums = saved.map((s) => s.album);
    } catch (e) {
      error = errorMessage(e);
    }
  }

  load();
</script>

<div class="page">
  <h1>Albums</h1>
  {#if albums}
    {#if albums.length}
      <CoverGrid items={albums.map((a) => albumItem(a))} />
    {:else}
      <p class="muted">Albums you save appear here. Open an album and use the heart to save it.</p>
    {/if}
  {:else}
    <Status {error} onretry={load} />
  {/if}
</div>

<style>
  .page {
    display: grid;
    gap: 28px;
    padding: 20px var(--gutter) 48px;
  }
  h1 {
    font-family: var(--font-display);
    font-variation-settings: "wdth" 125;
    font-weight: 800;
    font-size: clamp(2.5rem, 4.6vw, 4rem);
    letter-spacing: -0.03em;
    line-height: 1;
  }
</style>
