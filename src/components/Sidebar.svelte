<script lang="ts">
  import { mods } from "../lib/mods.svelte";
  import { player } from "../lib/player.svelte";
  import { reveal } from "../lib/reveal";
  import { router, type Route } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { pickImage } from "../lib/util";
  import Equalizer from "./Equalizer.svelte";
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
    {#each mods.pages as page (page.key)}
      <li>
        <button
          class="nav-item"
          class:active={current.name === "extension" && current.id === page.key}
          onclick={() => router.go({ name: "extension", id: page.key })}
        >
          <Icon name={page.icon ?? "puzzle"} />
          <span>{page.label}</span>
        </button>
      </li>
    {/each}
  </ul>

  <h2 class="heading">Playlists</h2>
  <ul class="playlists">
    {#each session.playlists as pl (pl.id)}
      {@const active = current.name === "playlist" && current.id === pl.id}
      {@const playing = player.contextUri === pl.uri}
      <li {@attach reveal}>
        <button class="pl" class:active onclick={() => router.go({ name: "playlist", id: pl.id })} title={pl.name}>
          {#if pickImage(pl.images, 60)}
            <img src={pickImage(pl.images, 60)} alt="" loading="lazy" />
          {:else}
            <span class="ph"></span>
          {/if}
          <span class="name" class:playing>{pl.name}</span>
          {#if playing && player.isPlaying}
            <span class="eq"><Equalizer label="Playing" /></span>
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
    border-radius: var(--panel-radius);
    background: var(--graphite);
    padding: 12px 8px 8px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .nav-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border-radius: 8px;
    color: var(--smoke);
    font-size: var(--t-md);
    font-weight: 600;
    text-align: left;
    transition: color 120ms, background 120ms;
  }
  .nav-item:hover {
    color: var(--paper);
    background: color-mix(in srgb, var(--paper) 4%, transparent);
  }
  .nav-item.active {
    color: var(--paper);
    background: var(--raised);
  }
  /* A lit tick on the dial: marks where you are. */
  .nav-item.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 10px;
    bottom: 10px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--brass);
    box-shadow: 0 0 8px color-mix(in srgb, var(--brass) 60%, transparent);
    animation: marker-in 320ms var(--ease-out);
  }
  @keyframes marker-in {
    from {
      opacity: 0;
      transform: scaleY(0);
    }
  }
  .nav-item.active :global(svg) {
    color: var(--brass);
  }

  .heading {
    font-size: var(--t-xs);
    color: var(--smoke);
    font-family: var(--font-ui);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 22px 12px 8px;
    margin-top: 10px;
    border-top: 1px solid var(--line);
  }

  .playlists {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    margin: 0 -4px;
    padding: 0 4px;
    /* Fade the list out where it scrolls under the settings button. */
    mask-image: linear-gradient(180deg, #000 calc(100% - 24px), transparent);
  }

  /* Playlists slide in from the edge rather than rise, when they load and as the list scrolls. */
  .playlists li:global([data-reveal="in"]) {
    animation-name: slide-in;
    animation-duration: 380ms;
    animation-timing-function: var(--ease-out);
  }
  @keyframes slide-in {
    from {
      opacity: 0;
      transform: translateX(-10px);
    }
  }

  .pl {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 5px 8px;
    border-radius: 8px;
    text-align: left;
    font-size: var(--t-md);
    color: color-mix(in srgb, var(--paper) 88%, var(--smoke));
    transition: background 120ms;
  }
  .pl:hover {
    background: color-mix(in srgb, var(--paper) 5%, transparent);
    color: var(--paper);
  }
  .pl.active {
    background: var(--raised);
    color: var(--paper);
  }
  .pl img,
  .ph {
    width: 38px;
    height: 38px;
    border-radius: 5px;
    flex: none;
    object-fit: cover;
    background: var(--raised);
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.3);
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
  .eq {
    display: grid;
    padding-right: 4px;
  }

  .empty {
    padding: 4px 12px;
    font-size: var(--t-sm);
  }

  .settings {
    margin-top: 4px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--brass);
    margin-left: auto;
    animation: attention 2.2s ease-out infinite;
  }
  /* A slow ripple, so the dot is noticed without nagging. */
  @keyframes attention {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--brass) 60%, transparent);
    }
    60%,
    100% {
      box-shadow: 0 0 0 7px transparent;
    }
  }
</style>
