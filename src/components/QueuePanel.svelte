<script lang="ts">
  import { dj } from "../lib/dj.svelte";
  import { errorMessage } from "../lib/ipc";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";
  import * as sp from "../lib/spotify";
  import type { Queue, Track } from "../lib/types";
  import { formatDuration, pickImage } from "../lib/util";
  import DjCover from "./DjCover.svelte";
  import Equalizer from "./Equalizer.svelte";
  import Icon from "./Icon.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let queue = $state<Queue | null>(null);
  let error = $state<string | null>(null);

  // Reload whenever the track changes.
  $effect(() => {
    const uri = player.track?.uri;
    const t = setTimeout(async () => {
      try {
        const q = await sp.queue();
        if (uri === player.track?.uri) queue = q;
        error = null;
      } catch (e) {
        error = errorMessage(e);
      }
    }, 400);
    return () => clearTimeout(t);
  });

  const upNext = $derived((queue?.queue ?? []).slice(0, 30));
  // The DJ's next talk is an item of the queue too: before its set's first song, or, before that set is
  // queued, after the last song of the one playing now.
  const djNext = $derived(dj.upNext?.speech && dj.announced !== dj.upNext ? dj.upNext : null);
  const djAt = $derived.by(() => {
    if (!djNext) return -1;
    const first = upNext.findIndex((t) => t.uri === djNext.songs[0].uri);
    if (first >= 0) return first;
    const last = dj.current?.songs[dj.current.songs.length - 1].uri;
    return last ? upNext.findIndex((t) => t.uri === last) + 1 : 0;
  });
</script>

{#snippet djItem(name: string, durationMs: number, current = false)}
  <li class="item" class:current>
    <button class="cover" onclick={() => router.go({ name: "dj" })} tabindex="-1">
      <DjCover size={42} />
      {#if current && !dj.paused}<span class="live"><Equalizer label="Your DJ is talking" /></span>{/if}
    </button>
    <span class="text">
      <span class="name">{name}</span>
      <span class="muted artists">Your DJ</span>
    </span>
    <span class="muted num dur">{formatDuration(durationMs)}</span>
  </li>
{/snippet}

{#snippet item(t: Track, current = false)}
  <li class="item" class:current>
    <button class="cover" onclick={() => t.album && router.go({ name: "album", id: t.album.id })} tabindex="-1">
      {#if pickImage(t.album?.images, 64)}<img src={pickImage(t.album?.images, 64)} alt="" loading="lazy" />{/if}
      {#if current && player.isPlaying}<span class="live"><Equalizer label="Playing" /></span>{/if}
    </button>
    <span class="text">
      <span class="name">{t.name}</span>
      <span class="muted artists">{t.artists?.map((a) => a.name).join(", ")}</span>
    </span>
    <span class="muted num dur">{formatDuration(t.duration_ms)}</span>
  </li>
{/snippet}

<aside class="panel" aria-label="Queue">
  <header>
    <h2>Queue</h2>
    <button class="icon-btn" onclick={onclose} title="Close queue"><Icon name="close" size={18} /></button>
  </header>

  <div class="scroll">
    {#if error}
      <p class="muted note">{error}</p>
    {:else if !queue}
      <p class="muted note">Loading…</p>
    {:else}
      {#if dj.onAir}
        <h3>Now playing</h3>
        <ul>{@render djItem(dj.onAir.name, dj.onAir.durationMs, true)}</ul>
      {:else if queue.currently_playing}
        <h3>Now playing</h3>
        <ul>{@render item(queue.currently_playing, true)}</ul>
      {/if}
      <h3>Next up</h3>
      {#if upNext.length || djNext}
        <ul>
          {#each upNext as t, i (t.uri + i)}
            {#if djNext && i === djAt}{@render djItem(djNext.name, djNext.speech?.durationMs ?? 0)}{/if}
            {@render item(t)}
          {/each}
          {#if djNext && djAt >= upNext.length}{@render djItem(djNext.name, djNext.speech?.durationMs ?? 0)}{/if}
        </ul>
      {:else}
        <p class="muted note">Nothing queued. Right-click a song and choose "Add to queue".</p>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg);
    border-radius: var(--panel-radius);
    animation: panel-in 320ms var(--ease-out) backwards;
  }
  @keyframes panel-in {
    from {
      opacity: 0;
      transform: translateX(16px);
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 10px 6px 18px;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 12px;
  }
  h3 {
    padding: 16px 10px 6px;
    font-size: var(--t-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-radius: 8px;
    transition: background 120ms;
  }
  .item:hover {
    background: color-mix(in srgb, var(--text) 5%, transparent);
  }
  .item.current {
    background: color-mix(in srgb, var(--highlight) 10%, transparent);
  }
  .cover {
    position: relative;
    width: 42px;
    height: 42px;
    flex: none;
    border-radius: 5px;
    overflow: hidden;
    background: var(--surface-raised);
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.3);
  }
  .cover img {
    width: 100%;
    height: 100%;
  }
  .live {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.5);
    color: var(--highlight);
  }
  /* The lists fade in once they load; later reloads update them in place. */
  .scroll > * {
    animation: fade-in 360ms ease-out backwards;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .name,
  .artists {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    font-size: var(--t-md);
  }
  .current .name {
    color: var(--highlight);
  }
  .artists,
  .dur {
    font-size: var(--t-xs);
  }
  .note {
    padding: 8px 10px;
    font-size: var(--t-sm);
  }
</style>
