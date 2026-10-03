<script lang="ts" module>
  export interface CoverItem {
    key: string;
    /** The context `play` starts, so the card can show when it's what's playing. */
    uri?: string;
    title: string;
    subtitle?: string;
    image: string | null;
    /** Artists get round portraits. */
    round?: boolean;
    open: () => void;
    play?: () => void;
  }
</script>

<script lang="ts">
  import { player } from "../lib/player.svelte";
  import { reveal } from "../lib/reveal";
  import Equalizer from "./Equalizer.svelte";
  import Icon from "./Icon.svelte";
  import Pop from "./Pop.svelte";

  let { items, oneRow = false }: { items: CoverItem[]; oneRow?: boolean } = $props();
</script>

<ul class="grid" class:one-row={oneRow}>
  {#each items as item (item.key)}
    {@const here = !!item.uri && player.contextUri === item.uri && !!player.track}
    {@const live = here && player.isPlaying}
    <!-- The card for what's playing keeps its button out, and it pauses instead of restarting. -->
    <li class="item" class:here {@attach reveal}>
      <div class="art" class:round={item.round}>
        <button class="open" onclick={item.open} aria-label="Open {item.title}">
          {#if item.image}
            <img src={item.image} alt="" loading="lazy" />
          {:else}
            <span class="blank"><Icon name={item.round ? "mic" : "disc"} size={40} /></span>
          {/if}
        </button>
        {#if item.play}
          <button
            class="play-fab"
            onclick={() => (here ? player.togglePlay() : item.play?.())}
            title="{live ? 'Pause' : 'Play'} {item.title}"
          >
            <Pop key={live}><Icon name={live ? "pause" : "play"} size={20} /></Pop>
          </button>
        {/if}
      </div>
      <button class="title" onclick={item.open} tabindex="-1">
        {#if live}<span class="eq"><Equalizer size={12} label="Playing" /></span>{/if}{item.title}
      </button>
      {#if item.subtitle}<p class="sub muted">{item.subtitle}</p>{/if}
    </li>
  {/each}
</ul>

<style>
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(184px, 1fr));
    gap: 6px;
    /* Cards carry their own padding; pull the grid out so the art still lines up with the headings. */
    margin: 0 -10px;
  }
  .grid.one-row {
    grid-auto-rows: 0;
    grid-template-rows: auto;
    row-gap: 0;
    overflow: hidden;
  }

  .item {
    /* Grows a little as it pops up on scroll (data-reveal in app.css). */
    --reveal-scale: 0.94;
    min-width: 0;
    padding: 10px 10px 14px;
    border-radius: 10px;
    transition: background 160ms;
  }
  .item:hover,
  .item:focus-within {
    background: color-mix(in srgb, var(--paper) 5%, transparent);
  }

  .art {
    position: relative;
    aspect-ratio: 1;
    margin-bottom: 12px;
  }
  .open {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 6px;
    overflow: hidden;
    background: var(--raised);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
    /* Keeps the rounded clip while the image inside scales. */
    isolation: isolate;
  }
  .round .open {
    border-radius: 50%;
  }
  .open img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: filter 160ms, transform 600ms var(--ease-out);
  }
  .item:hover .open img {
    filter: brightness(1.08);
    transform: scale(1.05);
  }
  .blank {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    color: var(--smoke);
  }

  .play-fab {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 46px;
    height: 46px;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 160ms, transform 160ms, background 120ms;
  }
  .item:hover .play-fab,
  .here .play-fab,
  .play-fab:focus-visible {
    opacity: 1;
    transform: none;
  }
  .item:hover .play-fab:hover {
    transform: scale(1.06);
  }

  .title {
    display: block;
    max-width: 100%;
    font-size: var(--t-md);
    font-weight: 600;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .here .title {
    color: var(--brass);
  }
  .eq {
    display: inline-block;
    margin-right: 7px;
    vertical-align: -1px;
  }
  .sub {
    margin-top: 2px;
    font-size: var(--t-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
