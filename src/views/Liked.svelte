<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import Status from "../components/Status.svelte";
  import TrackList, { type Row } from "../components/TrackList.svelte";
  import ViewHeader from "../components/ViewHeader.svelte";
  import { errorMessage } from "../lib/ipc";
  import { liked } from "../lib/liked.svelte";
  import { player } from "../lib/player.svelte";
  import { session } from "../lib/session.svelte";
  import * as sp from "../lib/spotify";
  import type { Paging, SavedTrack } from "../lib/types";
  import { plural } from "../lib/util";

  let rows = $state<Row[]>([]);
  let total = $state(0);
  let next = $state<string | null>(null);
  let loaded = $state(false);
  let loadingMore = false;
  let error = $state<string | null>(null);
  let sentinel: HTMLDivElement | undefined = $state();

  function add(page: Paging<SavedTrack>) {
    rows = [...rows, ...page.items.map((s) => ({ track: s.track, addedAt: s.added_at }))];
    liked.mark(page.items.map((s) => s.track.uri), true);
    total = page.total;
    next = page.next;
  }

  async function load() {
    error = null;
    rows = [];
    try {
      add(await sp.savedTracks());
      loaded = true;
    } catch (e) {
      error = errorMessage(e);
    }
  }

  async function loadMore() {
    if (!next || loadingMore) return;
    loadingMore = true;
    try {
      add(await sp.nextPage<SavedTrack>(next));
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loadingMore = false;
    }
  }

  load();

  // Fetch the next page when the end of the list scrolls into view.
  $effect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { rootMargin: "800px" });
    io.observe(sentinel);
    return () => io.disconnect();
  });

  const collection = $derived(session.user ? `spotify:user:${session.user.id}:collection` : null);
  const playingHere = $derived(!!collection && player.contextUri === collection && player.isPlaying);

  function play(i?: number) {
    if (!collection) return;
    if (i === undefined && player.contextUri === collection && player.track) return player.togglePlay();
    player.playContext(collection, i === undefined ? undefined : rows[i].track.uri);
  }
</script>

{#if loaded}
  <ViewHeader image={null} kind="Playlist" title="Liked songs" tint="color-mix(in srgb, var(--brass) 55%, var(--graphite))">
    {#snippet art()}
      <div class="tile"><Icon name="heart" size={72} filled /></div>
    {/snippet}
    {#snippet meta()}
      <span class="strong">{session.user?.display_name ?? ""}</span>
      <span>{plural(total, "song")}</span>
    {/snippet}
    {#snippet actions()}
      <button class="play-fab" onclick={() => play()} title={playingHere ? "Pause" : "Play"} disabled={!rows.length}>
        <Icon name={playingHere ? "pause" : "play"} size={22} />
      </button>
    {/snippet}
  </ViewHeader>

  <div class="body">
    {#if rows.length}
      <TrackList {rows} showAlbum showCover onplay={(i) => play(i)} />
      <div bind:this={sentinel} class="sentinel"></div>
    {:else}
      <p class="muted">Songs you like will appear here. Use the heart next to any song to save it.</p>
    {/if}
    {#if error}<p class="muted">{error}</p>{/if}
  </div>
{:else}
  <Status {error} onretry={load} />
{/if}

<style>
  .body {
    padding: 0 var(--gutter) 40px;
    font-size: var(--t-md);
  }
  .tile {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    background: linear-gradient(135deg, var(--brass), color-mix(in srgb, var(--brass) 45%, #5a2a14));
    color: var(--brass-ink);
  }
  .strong {
    font-weight: 700;
    color: var(--paper);
  }
  .sentinel {
    height: 1px;
  }
</style>
