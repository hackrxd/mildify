<script lang="ts">
  import CoverGrid from "../components/CoverGrid.svelte";
  import TrackList from "../components/TrackList.svelte";
  import { albumItem, artistItem } from "../lib/covers";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import * as sp from "../lib/spotify";
  import type { Artist, SimpleAlbum, Track } from "../lib/types";

  let recentAlbums = $state<SimpleAlbum[]>([]);
  let topArtists = $state<Artist[]>([]);
  let topTracks = $state<Track[]>([]);
  let savedAlbums = $state<SimpleAlbum[]>([]);
  let loaded = $state(false);

  async function load() {
    const [recent, artists, tracks, saved] = await Promise.allSettled([
      sp.recentlyPlayed(),
      sp.topArtists(),
      sp.topTracks(),
      sp.savedAlbums(),
    ]);
    if (recent.status === "fulfilled") {
      const seen = new Set<string>();
      recentAlbums = recent.value.items
        .map((h) => h.track.album)
        .filter((a) => a && !seen.has(a.id) && seen.add(a.id))
        .slice(0, 12);
    }
    if (artists.status === "fulfilled") topArtists = artists.value.items.slice(0, 12);
    if (tracks.status === "fulfilled") topTracks = tracks.value.items.slice(0, 10);
    if (saved.status === "fulfilled") savedAlbums = saved.value.items.map((s) => s.album).slice(0, 12);
    loaded = true;
  }

  load();

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = $derived(session.user?.display_name?.split(" ")[0]);
  const nothing = $derived(loaded && !recentAlbums.length && !topArtists.length && !topTracks.length && !savedAlbums.length);
</script>

<div class="home">
  <h1>{greeting}{firstName ? `, ${firstName}` : ""}.</h1>

  {#if recentAlbums.length}
    <section>
      <h2>Recently played</h2>
      <CoverGrid items={recentAlbums.map((a) => albumItem(a))} />
    </section>
  {/if}

  {#if topTracks.length}
    <section>
      <h2>On repeat this month</h2>
      <TrackList
        rows={topTracks.map((t) => ({ track: t }))}
        showAlbum
        showCover
        onplay={(i) => player.playUris(topTracks.map((t) => t.uri), i)}
      />
    </section>
  {/if}

  {#if topArtists.length}
    <section>
      <h2>Your top artists</h2>
      <CoverGrid items={topArtists.map(artistItem)} />
    </section>
  {/if}

  {#if savedAlbums.length}
    <section>
      <div class="section-head">
        <h2>Saved albums</h2>
        <button class="link muted" onclick={() => router.go({ name: "albums" })}>Show all</button>
      </div>
      <CoverGrid items={savedAlbums.map((a) => albumItem(a))} />
    </section>
  {/if}

  {#if nothing}
    <p class="muted">Play something and it'll show up here. Try searching for an artist you like.</p>
  {/if}
</div>

<style>
  /* Slides under the transparent top bar so the dial's glow reaches the top of the pane. */
  .home {
    display: grid;
    gap: 44px;
    margin-top: -60px;
    padding: 80px var(--gutter) 48px;
    background: radial-gradient(70% 520px at 0% 0%, color-mix(in srgb, var(--brass) 11%, transparent), transparent);
  }
  h1 {
    font-family: var(--font-display);
    font-variation-settings: "wdth" 125;
    font-weight: 800;
    font-size: clamp(2.5rem, 4.6vw, 4rem);
    letter-spacing: -0.03em;
    line-height: 1;
  }
  section h2 {
    margin-bottom: 16px;
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .section-head h2 {
    margin: 0;
  }
  .section-head button {
    font-size: var(--t-sm);
    font-weight: 600;
  }
</style>
