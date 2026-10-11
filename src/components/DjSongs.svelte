<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { DjSet } from "../lib/dj.svelte";
  import { songWhy } from "../lib/djView";
  import { liked } from "../lib/liked.svelte";
  import { contextMenu } from "../lib/menu.svelte";
  import { pop, rise } from "../lib/motion";
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
  // middle of the DJ's set, and a set picked as it goes clears the queue. Its info button says why it's here.
  let { set }: { set: DjSet } = $props();

  const songs = $derived(set.songs);
  /** The songs whose "why" is open, by URI. */
  const open = new SvelteSet<string>();

  let list: HTMLOListElement | undefined = $state();
  let needle = $state({ y: 0, h: 0 });
  /** The needle has found its first row: from then on it glides rather than jumps. */
  let placed = $state(false);
  const at = $derived(songs.findIndex((s) => s.uri === player.track?.uri));

  /** Bumped when the list changes size, as a song's "why" opens or closes: the needle measures again. */
  let resized = $state(0);
  $effect(() => {
    if (!list || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => resized++);
    watch.observe(list);
    return () => watch.disconnect();
  });

  $effect(() => {
    void resized;
    const row = at >= 0 ? (list?.children[at] as HTMLElement | undefined) : undefined;
    if (!row) return;
    needle = { y: row.offsetTop, h: row.offsetHeight };
    if (!untrack(() => placed)) requestAnimationFrame(() => (placed = true));
  });

  function toggleWhy(uri: string) {
    if (open.has(uri)) open.delete(uri);
    else open.add(uri);
  }

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
    {@const showing = open.has(s.uri)}
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
      <button
        class="icon-btn why-btn"
        class:on={showing}
        aria-expanded={showing}
        aria-controls="why-{set.id}-{i}"
        onclick={() => toggleWhy(s.uri)}
        title="Why it's here"
      >
        <Icon name="info" size={17} />
      </button>
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
      {:else}
        <span></span>
      {/if}
      {#if showing}
        {@const why = songWhy(s, set.lookedUp.get(s.uri))}
        <div class="why" id="why-{set.id}-{i}" in:rise={{ y: -4, duration: 220 }}>
          <ul class="pills" aria-label="Why it's here">
            {#each why.yours as reason (reason)}<li>{reason}</li>{/each}
            {#each why.found as fact (fact)}<li class="found">{fact}</li>{/each}
          </ul>
          {#if why.bio}<p class="bio">{why.bio}</p>{/if}
          {#if !why.yours.length && !why.found.length && !why.bio}<p class="bio">It's from your listening.</p>{/if}
        </div>
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
  .songs > li {
    position: relative;
    display: grid;
    grid-template-columns: 20px 40px minmax(0, 1fr) 32px 32px;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: var(--t-md);
    transition: background 100ms;
  }
  .songs > li:hover,
  .songs > li:focus-within {
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
  .heart.hidden,
  .why-btn:not(.on) {
    opacity: 0;
  }
  .songs > li:hover > :is(.heart.hidden, .why-btn),
  :is(.heart.hidden, .why-btn):focus-visible {
    opacity: 1;
  }
  /* Why it's here: under the song's name, quiet. */
  .why {
    grid-column: 3 / -1;
    display: grid;
    gap: 8px;
    padding-bottom: 4px;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pills li {
    display: block;
    padding: 3px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--highlight) 12%, transparent);
    color: color-mix(in srgb, var(--highlight) 75%, var(--text));
    font-size: var(--t-xs);
    font-weight: 600;
  }
  .pills li.found {
    background: color-mix(in srgb, var(--text) 7%, transparent);
    color: var(--text-muted);
  }
  .bio {
    display: -webkit-box;
    max-width: 66ch;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    color: var(--text-muted);
    font-size: var(--t-sm);
    line-height: 1.45;
  }
</style>
