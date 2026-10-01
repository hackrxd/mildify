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
  import type { Playlist } from "../lib/types";
  import { formatRuntime, pickImage, plainText, plural } from "../lib/util";

  let { id }: { id: string } = $props();

  let playlist = $state<Playlist | null>(null);
  let rows = $state<Row[]>([]);
  /** Spotify only returns items for playlists the user owns or collaborates on. */
  let restricted = $state(false);
  let error = $state<string | null>(null);

  async function load(playlistId: string) {
    playlist = null;
    rows = [];
    restricted = false;
    error = null;
    try {
      const p = await sp.playlist(playlistId);
      if (playlistId !== id) return;
      playlist = p;
      liked.ensure([p.uri]);
      const page = p.items ?? p.tracks;
      if (!page || !Array.isArray(page.items)) {
        restricted = true;
        return;
      }
      const toRows = (items: typeof page.items) =>
        items.flatMap((it) => {
          const t = sp.itemTrack(it);
          return t ? [{ track: t, addedAt: it.added_at }] : [];
        });
      rows = toRows(page.items);
      if (page.next) {
        const all = await sp.allPages(page, 2000);
        if (playlistId === id) rows = toRows(all);
      }
    } catch (e) {
      if (playlistId === id) error = errorMessage(e);
    }
  }

  $effect(() => {
    load(id);
  });

  const owned = $derived(!!playlist && playlist.owner.id === session.user?.id);
  const runtime = $derived(rows.reduce((sum, r) => sum + r.track.duration_ms, 0));
  const playingHere = $derived(!!playlist && player.contextUri === playlist.uri && player.isPlaying);
  const saved = $derived(playlist && !owned ? liked.has(playlist.uri) : undefined);

  function playAll() {
    if (!playlist) return;
    if (player.contextUri === playlist.uri && player.track) player.togglePlay();
    else player.playContext(playlist.uri);
  }

  async function toggleFollow() {
    if (!playlist) return;
    await liked.toggle(playlist.uri);
    session.loadPlaylists();
  }
</script>

{#if playlist}
  <ViewHeader image={pickImage(playlist.images, 640)} kind={playlist.public === false ? "Private playlist" : "Playlist"} title={playlist.name}>
    {#snippet meta()}
      {#if playlist!.description}
        <p class="desc">{plainText(playlist!.description)}</p>
      {/if}
      <span class="strong">{playlist!.owner.display_name ?? playlist!.owner.id}</span>
      {#if rows.length}
        <span>{plural(rows.length, "song")}, {formatRuntime(runtime)}</span>
      {/if}
    {/snippet}
    {#snippet actions()}
      <button class="play-fab" onclick={playAll} title={playingHere ? "Pause" : "Play"}>
        <Icon name={playingHere ? "pause" : "play"} size={22} />
      </button>
      {#if saved !== undefined}
        <button class="icon-btn big" class:on={saved} onclick={toggleFollow} title={saved ? "Remove from your library" : "Save to your library"}>
          <Icon name="heart" size={28} filled={saved} />
        </button>
      {/if}
    {/snippet}
  </ViewHeader>

  <div class="body">
    {#if restricted}
      <div class="note">
        <p>Spotify only shares the track list of playlists you own or collaborate on with apps like this one.</p>
        <p class="muted">You can still play it. Each track appears in the player as it comes up, and the queue shows what's next.</p>
      </div>
    {:else if rows.length}
      <TrackList {rows} showAlbum showCover onplay={(i) => player.playContext(playlist!.uri, rows[i].track.uri)} />
    {:else}
      <p class="muted empty">This playlist is empty.</p>
    {/if}
  </div>
{:else}
  <Status {error} onretry={() => load(id)} />
{/if}

<style>
  .body {
    padding: 0 var(--gutter) 40px;
  }
  .desc {
    flex-basis: 100%;
    max-width: 70ch;
    color: color-mix(in srgb, var(--paper) 70%, transparent);
  }
  .strong {
    font-weight: 700;
    color: var(--paper);
  }
  .big {
    width: 44px;
    height: 44px;
  }
  .note {
    display: grid;
    gap: 6px;
    max-width: 62ch;
    padding: 18px 20px;
    border-radius: 8px;
    background: var(--panel);
    font-size: var(--t-md);
  }
  .empty {
    font-size: var(--t-md);
  }
</style>
