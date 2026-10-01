<script lang="ts">
  import { player } from "../lib/player.svelte";
  import { router, type Route } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { pickImage } from "../lib/util";
  import Icon, { type IconName } from "./Icon.svelte";

  const nav: { route: Route; label: string; icon: IconName }[] = [
    { route: { name: "home" }, label: "Home", icon: "home" },
    { route: { name: "search" }, label: "Search", icon: "search" },
    { route: { name: "liked" }, label: "Liked songs", icon: "heart" },
    { route: { name: "albums" }, label: "Albums", icon: "disc" },
    { route: { name: "artists" }, label: "Artists", icon: "mic" },
  ];

  const current = $derived(router.current);

  function isActive(route: Route) {
    return current.name === route.name;
  }
</script>

<nav class="sidebar" aria-label="Library">
  <ul class="nav">
    {#each nav as item (item.route.name)}
      <li>
        <button class="nav-item" class:active={isActive(item.route)} onclick={() => router.go(item.route)}>
          <Icon name={item.icon} filled={item.icon === "heart" && isActive(item.route)} />
          <span>{item.label}</span>
        </button>
      </li>
    {/each}
  </ul>

  <h2 class="heading">Playlists</h2>
  <ul class="playlists">
    {#each session.playlists as pl (pl.id)}
      {@const active = current.name === "playlist" && current.id === pl.id}
      {@const playing = player.contextUri === pl.uri}
      <li>
        <button class="pl" class:active onclick={() => router.go({ name: "playlist", id: pl.id })} title={pl.name}>
          {#if pickImage(pl.images, 60)}
            <img src={pickImage(pl.images, 60)} alt="" loading="lazy" />
          {:else}
            <span class="ph"></span>
          {/if}
          <span class="name" class:playing>{pl.name}</span>
          {#if playing && player.isPlaying}
            <span class="eq" aria-label="Playing"><Icon name="volume" size={16} /></span>
          {/if}
        </button>
      </li>
    {:else}
      <li class="empty muted">Playlists you create or follow show up here.</li>
    {/each}
  </ul>

  <button class="nav-item settings" class:active={current.name === "settings"} onclick={() => router.go({ name: "settings" })}>
    <Icon name="sliders" />
    <span>Settings</span>
    {#if session.device && session.device.state !== "ready"}
      <span class="dot" title="The built-in player needs attention"></span>
    {/if}
  </button>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel);
    padding: 14px 10px 10px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    height: 38px;
    padding: 0 12px;
    border-radius: 6px;
    color: var(--smoke);
    font-size: var(--t-md);
    font-weight: 600;
    text-align: left;
  }
  .nav-item:hover {
    color: var(--paper);
  }
  .nav-item.active {
    color: var(--paper);
    background: var(--raised);
  }
  .nav-item.active :global(svg) {
    color: var(--brass);
  }

  .heading {
    font-size: var(--t-sm);
    color: var(--smoke);
    font-weight: 600;
    padding: 22px 12px 8px;
  }

  .playlists {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    margin: 0 -4px;
    padding: 0 4px;
  }

  .pl {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 5px 8px;
    border-radius: 6px;
    text-align: left;
    font-size: var(--t-md);
  }
  .pl:hover {
    background: color-mix(in srgb, var(--raised) 60%, transparent);
  }
  .pl.active {
    background: var(--raised);
  }
  .pl img,
  .ph {
    width: 34px;
    height: 34px;
    border-radius: 3px;
    flex: none;
    object-fit: cover;
    background: var(--raised);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.playing,
  .eq {
    color: var(--brass);
  }

  .empty {
    padding: 4px 12px;
    font-size: var(--t-sm);
  }

  .settings {
    margin-top: 8px;
    position: relative;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--brass);
    margin-left: auto;
  }
</style>
