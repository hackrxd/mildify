<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import Status from "../components/Status.svelte";
  import TrackList from "../components/TrackList.svelte";
  import ViewHeader from "../components/ViewHeader.svelte";
  import { errorMessage } from "../lib/ipc";
  import { liked } from "../lib/liked.svelte";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";
  import * as sp from "../lib/spotify";
  import type { Album, SimpleTrack } from "../lib/types";
  import { formatRuntime, pickImage, plural, year } from "../lib/util";

  let { id }: { id: string } = $props();

  let album = $state<Album | null>(null);
  let tracks = $state<SimpleTrack[]>([]);
  let error = $state<string | null>(null);

  async function load(albumId: string) {
    album = null;
    tracks = [];
    error = null;
    try {
      const a = await sp.album(albumId);
      if (albumId !== id) return;
      album = a;
      tracks = a.tracks.items;
      if (a.tracks.next) tracks = await sp.allPages(a.tracks);
      liked.ensure([a.uri]);
    } catch (e) {
      if (albumId === id) error = errorMessage(e);
    }
  }

  $effect(() => {
    load(id);
  });

  const kind = $derived(album ? { album: "Album", single: "Single", compilation: "Compilation" }[album.album_type] : "");
  const runtime = $derived(tracks.reduce((sum, t) => sum + t.duration_ms, 0));
  const playingHere = $derived(!!album && player.contextUri === album.uri && player.isPlaying);
  const saved = $derived(album ? liked.has(album.uri) : undefined);

  function playAll() {
    if (!album) return;
    if (player.contextUri === album.uri && player.track) player.togglePlay();
    else player.playContext(album.uri);
  }
</script>

{#if album}
  <ViewHeader image={pickImage(album.images, 640)} {kind} title={album.name}>
    {#snippet meta()}
      <span>
        {#each album!.artists as a, i (a.id)}
          {#if i > 0},&nbsp;{/if}<button class="link strong" onclick={() => router.go({ name: "artist", id: a.id })}>{a.name}</button>
        {/each}
      </span>
      <span>{year(album!.release_date)}</span>
      <span>{plural(tracks.length || album!.total_tracks, "song")}, {formatRuntime(runtime)}</span>
    {/snippet}
    {#snippet actions()}
      <button class="play-fab" onclick={playAll} title={playingHere ? "Pause" : "Play"}>
        <Icon name={playingHere ? "pause" : "play"} size={22} />
      </button>
      {#if saved !== undefined}
        <button class="icon-btn big" class:on={saved} onclick={() => liked.toggle(album!.uri)} title={saved ? "Remove from your library" : "Save to your library"}>
          <Icon name="heart" size={28} filled={saved} />
        </button>
      {/if}
    {/snippet}
  </ViewHeader>

  <div class="body">
    <TrackList
      rows={tracks.map((t) => ({ track: t }))}
      numbering="track"
      discs
      onplay={(i) => player.playContext(album!.uri, tracks[i].uri)}
    />
    {#if album.copyrights?.length}
      <footer class="muted">
        {#each album.copyrights as c (c.type + c.text)}<p>{c.text}</p>{/each}
      </footer>
    {/if}
  </div>
{:else}
  <Status {error} onretry={() => load(id)} />
{/if}

<style>
  .body {
    padding: 0 var(--gutter) 40px;
  }
  .strong {
    font-weight: 700;
    color: var(--paper);
  }
  .big {
    width: 44px;
    height: 44px;
  }
  footer {
    margin-top: 28px;
    font-size: var(--t-xs);
    display: grid;
    gap: 2px;
  }
</style>
