<script lang="ts" module>
  export interface CoverItem {
    key: string;
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
  import Icon from "./Icon.svelte";

  let { items, oneRow = false }: { items: CoverItem[]; oneRow?: boolean } = $props();
</script>

<ul class="grid" class:one-row={oneRow}>
  {#each items as item (item.key)}
    <li class="item">
      <div class="art" class:round={item.round}>
        <button class="open" onclick={item.open} aria-label="Open {item.title}">
          {#if item.image}
            <img src={item.image} alt="" loading="lazy" />
          {:else}
            <span class="blank"><Icon name={item.round ? "mic" : "disc"} size={40} /></span>
          {/if}
        </button>
        {#if item.play}
          <button class="play-fab" onclick={item.play} title="Play {item.title}">
            <Icon name="play" size={20} />
          </button>
        {/if}
      </div>
      <button class="title" onclick={item.open} tabindex="-1">{item.title}</button>
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
    grid-template-columns: repeat(auto-fill, minmax(164px, 1fr));
    gap: 28px 22px;
  }
  .grid.one-row {
    grid-auto-rows: 0;
    grid-template-rows: auto;
    row-gap: 0;
    overflow: hidden;
  }

  .item {
    min-width: 0;
  }

  .art {
    position: relative;
    aspect-ratio: 1;
    margin-bottom: 10px;
  }
  .open {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 4px;
    overflow: hidden;
    background: var(--raised);
  }
  .round .open {
    border-radius: 50%;
  }
  .open img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: filter 160ms;
  }
  .item:hover .open img {
    filter: brightness(1.08);
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
    right: 10px;
    bottom: 10px;
    width: 46px;
    height: 46px;
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 140ms, transform 140ms;
  }
  .item:hover .play-fab,
  .play-fab:focus-visible {
    opacity: 1;
    transform: none;
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
  .sub {
    margin-top: 2px;
    font-size: var(--t-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
