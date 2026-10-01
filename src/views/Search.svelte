<script lang="ts">
  import CoverGrid from "../components/CoverGrid.svelte";
  import Status from "../components/Status.svelte";
  import TrackList from "../components/TrackList.svelte";
  import { albumItem, artistItem, playlistItem } from "../lib/covers";
  import { errorMessage } from "../lib/ipc";
  import { player } from "../lib/player.svelte";
  import * as sp from "../lib/spotify";
  import type { SearchResults, SimplePlaylist } from "../lib/types";

  let { q = "" }: { q?: string } = $props();

  let results = $state<SearchResults | null>(null);
  let error = $state<string | null>(null);
  let searching = $state(false);

  // Debounce typing; drop responses for stale queries.
  $effect(() => {
    const query = q.trim();
    error = null;
    if (!query) {
      results = null;
      return;
    }
    searching = true;
    const t = setTimeout(async () => {
      try {
        const r = await sp.search(query);
        if (query === q.trim()) results = r;
      } catch (e) {
        if (query === q.trim()) error = errorMessage(e);
      } finally {
        if (query === q.trim()) searching = false;
      }
    }, 300);
    return () => clearTimeout(t);
  });

  const tracks = $derived(results?.tracks?.items ?? []);
  const artists = $derived(results?.artists?.items ?? []);
  const albums = $derived(results?.albums?.items ?? []);
  const playlists = $derived((results?.playlists?.items ?? []).filter((p): p is SimplePlaylist => !!p));
  const empty = $derived(!!results && !tracks.length && !artists.length && !albums.length && !playlists.length);
</script>

<div class="search">
  {#if !q.trim()}
    <div class="hint">
      <h1>Search</h1>
      <p class="muted">Find songs, artists, albums and playlists. Type in the box above.</p>
    </div>
  {:else if error}
    <Status {error} />
  {:else if results}
    {#if empty}
      <div class="hint">
        <p>Nothing matches “{q.trim()}”.</p>
        <p class="muted">Check the spelling, or try fewer words.</p>
      </div>
    {/if}
    {#if tracks.length}
      <section>
        <h2>Songs</h2>
        <TrackList
          rows={tracks.map((t) => ({ track: t }))}
          showAlbum
          showCover
          onplay={(i) => player.playUris(tracks.map((t) => t.uri), i)}
        />
      </section>
    {/if}
    {#if artists.length}
      <section>
        <h2>Artists</h2>
        <CoverGrid items={artists.map(artistItem)} />
      </section>
    {/if}
    {#if albums.length}
      <section>
        <h2>Albums</h2>
        <CoverGrid items={albums.map((a) => albumItem(a))} />
      </section>
    {/if}
    {#if playlists.length}
      <section>
        <h2>Playlists</h2>
        <CoverGrid items={playlists.map(playlistItem)} />
      </section>
    {/if}
  {:else if searching}
    <Status />
  {/if}
</div>

<style>
  .search {
    display: grid;
    gap: 40px;
    padding: 12px var(--gutter) 40px;
  }
  section h2 {
    margin-bottom: 14px;
  }
  .hint {
    display: grid;
    gap: 8px;
    padding-top: 24px;
    font-size: var(--t-lg);
  }
  h1 {
    font-family: var(--font-display);
    font-variation-settings: "wdth" 125;
    font-weight: 800;
    font-size: clamp(2.5rem, 5vw, 4rem);
    letter-spacing: -0.03em;
    line-height: 1;
  }
</style>
