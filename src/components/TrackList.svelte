<script lang="ts">
  import { liked } from "../lib/liked.svelte";
  import { menu } from "../lib/menu.svelte";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";
  import type { SimpleTrack, Track } from "../lib/types";
  import { formatDuration, pickImage } from "../lib/util";
  import Icon from "./Icon.svelte";

  export interface Row {
    track: SimpleTrack | Track;
    addedAt?: string | null;
  }

  let {
    rows,
    onplay,
    showAlbum = false,
    showCover = false,
    numbering = "index",
    discs = false,
  }: {
    rows: Row[];
    onplay: (index: number) => void;
    showAlbum?: boolean;
    showCover?: boolean;
    /** "track" uses the album track number (album view). */
    numbering?: "index" | "track";
    /** Insert "Disc N" separators when the album has several discs. */
    discs?: boolean;
  } = $props();

  const multiDisc = $derived(discs && rows.some((r) => r.track.disc_number > 1));

  $effect(() => {
    liked.ensure(rows.map((r) => r.track.uri).filter((u) => u.startsWith("spotify:track:")));
  });

  const albumOf = (t: SimpleTrack | Track) => ("album" in t ? t.album : null);

  function openMenu(e: MouseEvent, t: SimpleTrack | Track) {
    const album = albumOf(t);
    const saved = liked.has(t.uri);
    menu.show(e, [
      { label: "Add to queue", action: () => player.addToQueue(t.uri) },
      {
        label: saved ? "Remove from Liked Songs" : "Save to Liked Songs",
        action: () => liked.toggle(t.uri),
        disabled: saved === undefined,
      },
      ...(album ? [{ label: "Go to album", action: () => router.go({ name: "album", id: album.id }) }] : []),
      ...t.artists.slice(0, 3).map((a) => ({
        label: t.artists.length > 1 ? `Go to ${a.name}` : "Go to artist",
        action: () => router.go({ name: "artist", id: a.id }),
      })),
    ]);
  }
</script>

<div class="list" class:with-album={showAlbum} role="table" aria-label="Tracks">
  <div class="row head" role="row">
    <span class="n" role="columnheader">#</span>
    <span role="columnheader">Title</span>
    {#if showAlbum}<span role="columnheader">Album</span>{/if}
    <span role="columnheader"><span class="visually-hidden">Saved</span></span>
    <span class="dur" role="columnheader">Time</span>
  </div>

  {#each rows as row, i (row.track.uri + i)}
    {@const t = row.track}
    {@const current = player.track?.uri === t.uri}
    {@const album = albumOf(t)}
    {@const saved = liked.has(t.uri)}
    {@const unplayable = t.is_playable === false}
    {#if multiDisc && (i === 0 || rows[i - 1].track.disc_number !== t.disc_number)}
      <div class="disc" role="row"><Icon name="disc" size={16} /> Disc {t.disc_number}</div>
    {/if}
    <div
      class="row"
      class:current
      class:unplayable
      role="row"
      tabindex="-1"
      ondblclick={() => !unplayable && onplay(i)}
      oncontextmenu={(e) => openMenu(e, t)}
    >
      <span class="n num" role="cell">
        <span class="idx">
          {#if current && player.isPlaying}
            <Icon name="volume" size={16} label="Playing" />
          {:else}
            {numbering === "track" ? t.track_number : i + 1}
          {/if}
        </span>
        <button class="play" onclick={() => onplay(i)} disabled={unplayable} title="Play {t.name}">
          <Icon name={current && player.isPlaying ? "pause" : "play"} size={14} />
        </button>
      </span>

      <span class="title" role="cell">
        {#if showCover && album}
          <img src={pickImage(album.images, 64)} alt="" loading="lazy" />
        {/if}
        <span class="title-text">
          <span class="name">{t.name}</span>
          <span class="artists">
            {#if t.explicit}<span class="explicit" title="Explicit">E</span>{/if}
            <span class="artist-links">
              {#each t.artists as a, j (a.id + j)}
                {#if j > 0},&nbsp;{/if}<button class="link" onclick={() => router.go({ name: "artist", id: a.id })}>{a.name}</button>
              {/each}
            </span>
          </span>
        </span>
      </span>

      {#if showAlbum}
        <span class="album" role="cell">
          {#if album}
            <button class="link" onclick={() => router.go({ name: "album", id: album.id })}>{album.name}</button>
          {/if}
        </span>
      {/if}

      <span class="heart" role="cell">
        {#if saved !== undefined}
          <button class="icon-btn" class:on={saved} class:hidden={!saved} onclick={() => liked.toggle(t.uri)} title={saved ? "Remove from Liked Songs" : "Save to Liked Songs"}>
            <Icon name="heart" size={17} filled={saved} />
          </button>
        {/if}
      </span>

      <span class="dur num muted" role="cell">{formatDuration(t.duration_ms)}</span>
    </div>
  {/each}
</div>

<style>
  .list {
    --cols: 44px minmax(0, 1fr) 40px 64px;
    font-size: var(--t-md);
  }
  .list.with-album {
    --cols: 44px minmax(0, 1.4fr) minmax(0, 1fr) 40px 64px;
  }

  .row {
    display: grid;
    grid-template-columns: var(--cols);
    align-items: center;
    gap: 12px;
    min-height: 54px;
    padding: 0 12px;
    border-radius: 6px;
    content-visibility: auto;
    contain-intrinsic-size: auto 54px;
  }
  .row:not(.head):hover,
  .row:focus-within {
    background: color-mix(in srgb, var(--paper) 6%, transparent);
  }

  .head {
    min-height: 36px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--line);
    border-radius: 0;
    color: var(--smoke);
    font-size: var(--t-sm);
  }

  .disc {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 12px 6px;
    color: var(--smoke);
    font-size: var(--t-sm);
    font-weight: 600;
  }

  .n {
    position: relative;
    display: grid;
    place-items: center;
    color: var(--smoke);
  }
  .n .play {
    position: absolute;
    inset: 0;
    display: none;
    place-items: center;
    color: var(--paper);
  }
  .row:hover .n .play,
  .n .play:focus-visible {
    display: grid;
  }
  .row:hover .n .idx {
    visibility: hidden;
  }
  .current .n,
  .current .name {
    color: var(--brass);
  }

  .title {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .title img {
    width: 40px;
    height: 40px;
    border-radius: 3px;
    flex: none;
    background: var(--raised);
  }
  .title-text {
    display: grid;
    min-width: 0;
  }
  .name,
  .artist-links,
  .album {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    font-size: var(--t-lg);
    line-height: 1.3;
  }
  .artists {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--smoke);
    font-size: var(--t-sm);
  }
  .album {
    color: var(--smoke);
    font-size: var(--t-sm);
  }

  .heart .hidden {
    opacity: 0;
  }
  .row:hover .heart .hidden,
  .heart .hidden:focus-visible {
    opacity: 1;
  }

  .dur {
    text-align: right;
    font-size: var(--t-sm);
  }

  .unplayable {
    opacity: 0.45;
  }
</style>
