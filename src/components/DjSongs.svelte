<script lang="ts">
  import { untrack } from "svelte";
  import type { Candidate } from "../lib/djPicks";
  import { liked } from "../lib/liked.svelte";
  import { contextMenu } from "../lib/menu.svelte";
  import { pop } from "../lib/motion";
  import { player } from "../lib/player.svelte";
  import { reveal } from "../lib/reveal";
  import { router } from "../lib/router.svelte";
  import { trackMenu } from "../lib/trackMenu";
  import { pickImage } from "../lib/util";
  import Equalizer from "./Equalizer.svelte";
  import Icon from "./Icon.svelte";
  import Pop from "./Pop.svelte";

  // A DJ set's songs, as on the DJ page: the rows cue up as they arrive, and a brass highlight glides down to
  // the song playing, like a needle finding the next groove. Songs already played fall back behind it. Each has
  // its cover, its artists, a heart and the usual menu, but no Add to queue: a song queued here would play in the
  // middle of the DJ's set, and a set picked as it goes clears the queue.
  let { songs }: { songs: Candidate[] } = $props();

  let list: HTMLOListElement | undefined = $state();
  let needle = $state({ y: 0, h: 0 });
  /** The needle has found its first row: from then on it glides rather than jumps. */
  let placed = $state(false);
  const at = $derived(songs.findIndex((s) => s.uri === player.track?.uri));

  $effect(() => {
    const row = at >= 0 ? (list?.children[at] as HTMLElement | undefined) : undefined;
    if (!row) return;
    needle = { y: row.offsetTop, h: row.offsetHeight };
    if (!untrack(() => placed)) requestAnimationFrame(() => (placed = true));
  });

  $effect(() => {
    liked.ensure(songs.map((s) => s.uri));
  });
</script>

<ol
  class="songs"
  class:lit={at >= 0}
  class:placed
  bind:this={list}
  style:--needle-y="{needle.y}px"
  style:--needle-h="{needle.h}px"
  style:--needle-beat={Math.min(Math.max(at, 0), 10)}
>
  {#each songs as s, i (s.uri)}
    {@const album = s.track?.album}
    {@const cover = pickImage(album?.images, 64)}
    {@const saved = liked.has(s.uri)}
    <li
      class:playing={i === at}
      class:played={at > 0 && i < at}
      {@attach reveal}
      {@attach contextMenu(() => (s.track ? trackMenu(s.track, { queue: false }) : []))}
    >
      <span class="mark">
        {#if i === at && player.isPlaying}<span class="eq" in:pop={{ from: 0.3, duration: 300 }}><Equalizer label="Playing" /></span>{/if}
      </span>
      {#if album}
        <button class="cover" onclick={() => router.go({ name: "album", id: album.id })} title="Go to {album.name}">
          {#if cover}<img src={cover} alt="" loading="lazy" />{/if}
        </button>
      {:else}
        <span class="cover"></span>
      {/if}
      <span class="text">
        <span class="name">{s.name}</span>
        <span class="artists">
          {#if s.track}
            {#each s.track.artists as a, j (a.id + j)}
              {#if j > 0},&nbsp;{/if}<button class="link" onclick={() => router.go({ name: "artist", id: a.id })}>{a.name}</button>
            {/each}
          {:else}
            {s.artists.join(", ")}
          {/if}
        </span>
      </span>
      {#if saved !== undefined}
        <button
          class="icon-btn heart"
          class:on={saved}
          class:hidden={!saved}
          onclick={() => liked.toggle(s.uri)}
          title={saved ? "Remove from Liked Songs" : "Save to Liked Songs"}
        >
          <Pop key={saved}><Icon name="heart" size={17} filled={saved} /></Pop>
        </button>
      {/if}
    </li>
  {/each}
</ol>

<style>
  .songs {
    position: relative;
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* The needle: one row tall, behind the rows. */
  .songs::before {
    content: "";
    position: absolute;
    inset: 0 0 auto;
    height: var(--needle-h);
    transform: translateY(var(--needle-y));
    border-radius: 8px;
    background: color-mix(in srgb, var(--highlight) 10%, transparent);
    opacity: 0;
    pointer-events: none;
    animation: fade-in 300ms ease-out backwards;
    animation-delay: calc(var(--needle-beat) * var(--stagger) + 200ms);
  }
  .songs.placed::before {
    transition:
      transform 380ms var(--ease-out),
      opacity 200ms;
  }
  .songs.lit::before {
    opacity: 1;
  }
  .songs li {
    position: relative;
    display: grid;
    grid-template-columns: 20px 40px minmax(0, 1fr) 32px;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: var(--t-md);
    transition: background 100ms;
  }
  .songs li:hover,
  .songs li:focus-within {
    background: color-mix(in srgb, var(--text) 5%, transparent);
  }
  .cover {
    display: block;
    width: 40px;
    height: 40px;
    overflow: hidden;
    border-radius: 5px;
    background: var(--surface-raised);
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.3);
  }
  .cover img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .text {
    display: grid;
    min-width: 0;
  }
  .name,
  .artists {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .artists {
    color: var(--text-muted);
    font-size: var(--t-sm);
  }
  /* Fades by colour, not opacity, so the artists below it stay readable. */
  .played .name {
    color: var(--text-muted);
  }
  .name {
    transition: color 200ms var(--ease-out);
  }
  .playing .name,
  .mark {
    color: var(--highlight);
  }
  .eq {
    display: inline-flex;
  }
  .heart.hidden {
    opacity: 0;
  }
  li:hover .heart.hidden,
  .heart.hidden:focus-visible {
    opacity: 1;
  }
</style>
