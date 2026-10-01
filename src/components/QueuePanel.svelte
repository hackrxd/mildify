<script lang="ts">
  import { errorMessage } from "../lib/ipc";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";
  import * as sp from "../lib/spotify";
  import type { Queue, Track } from "../lib/types";
  import { formatDuration, pickImage } from "../lib/util";
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
</script>

{#snippet item(t: Track, current = false)}
  <li class="item" class:current>
    <button class="cover" onclick={() => t.album && router.go({ name: "album", id: t.album.id })} tabindex="-1">
      {#if pickImage(t.album?.images, 64)}<img src={pickImage(t.album?.images, 64)} alt="" loading="lazy" />{/if}
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
      {#if queue.currently_playing}
        <h3>Now playing</h3>
        <ul>{@render item(queue.currently_playing, true)}</ul>
      {/if}
      <h3>Next up</h3>
      {#if upNext.length}
        <ul>
          {#each upNext as t, i (t.uri + i)}{@render item(t)}{/each}
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
    background: var(--panel);
    border-radius: 8px;
    margin: 8px 8px 8px 0;
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
    padding: 14px 10px 6px;
    font-size: var(--t-sm);
    font-weight: 600;
    color: var(--smoke);
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
    border-radius: 6px;
  }
  .item:hover {
    background: color-mix(in srgb, var(--paper) 5%, transparent);
  }
  .cover {
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 3px;
    overflow: hidden;
    background: var(--raised);
  }
  .cover img {
    width: 100%;
    height: 100%;
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
    color: var(--brass);
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
