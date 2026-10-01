<script lang="ts">
  import CoverGrid from "../components/CoverGrid.svelte";
  import Status from "../components/Status.svelte";
  import { artistItem } from "../lib/covers";
  import { errorMessage } from "../lib/ipc";
  import * as sp from "../lib/spotify";
  import type { Artist } from "../lib/types";

  let artists = $state<Artist[] | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    error = null;
    try {
      // /me/following pages with a cursor, so its `next` link works the same way.
      artists = await sp.allPages(await sp.followedArtists(), 1000);
    } catch (e) {
      error = errorMessage(e);
    }
  }

  load();
</script>

<div class="page">
  <h1>Artists</h1>
  {#if artists}
    {#if artists.length}
      <CoverGrid items={artists.map(artistItem)} />
    {:else}
      <p class="muted">Artists you follow in Spotify appear here.</p>
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
