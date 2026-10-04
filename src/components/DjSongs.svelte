<script lang="ts">
  import { untrack } from "svelte";
  import type { Candidate } from "../lib/djPicks";
  import { pop } from "../lib/motion";
  import { player } from "../lib/player.svelte";
  import { reveal } from "../lib/reveal";
  import Equalizer from "./Equalizer.svelte";

  // A DJ set's songs, as on the DJ page: the rows cue up as they arrive, and a brass highlight glides down to
  // the song playing, like a needle finding the next groove. Songs already played fall back behind it.
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
    <li class:playing={i === at} class:played={at > 0 && i < at} {@attach reveal}>
      <span class="mark">
        {#if i === at && player.isPlaying}<span class="eq" in:pop={{ from: 0.3, duration: 300 }}><Equalizer label="Playing" /></span>{/if}
      </span>
      <span class="name">{s.name}</span>
      <span class="muted">{s.artists.join(", ")}</span>
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
    grid-template-columns: 20px minmax(0, auto) minmax(0, 1fr);
    align-items: baseline;
    gap: 10px;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: var(--t-md);
  }
  .songs li > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Fades by colour, not opacity, so the artist beside it stays readable. */
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
</style>
