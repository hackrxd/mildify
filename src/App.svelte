<script lang="ts">
  import ContextMenu from "./components/ContextMenu.svelte";
  import NowPlaying from "./components/NowPlaying.svelte";
  import QueuePanel from "./components/QueuePanel.svelte";
  import Setup from "./components/Setup.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Toasts from "./components/Toasts.svelte";
  import TopBar from "./components/TopBar.svelte";
  import { player } from "./lib/player.svelte";
  import { router } from "./lib/router.svelte";
  import { session } from "./lib/session.svelte";
  import { toasts } from "./lib/toasts.svelte";
  import Album from "./views/Album.svelte";
  import Albums from "./views/Albums.svelte";
  import Artist from "./views/Artist.svelte";
  import Artists from "./views/Artists.svelte";
  import Home from "./views/Home.svelte";
  import Liked from "./views/Liked.svelte";
  import Lyrics from "./views/Lyrics.svelte";
  import { lyrics } from "./lib/lyrics.svelte";
  import Playlist from "./views/Playlist.svelte";
  import Search from "./views/Search.svelte";
  import Settings from "./views/Settings.svelte";

  let main: HTMLElement | undefined = $state();
  let topbar: TopBar | undefined = $state();
  let scrolled = $state(false);
  let queueOpen = $state(false);
  let playerStarted = false;

  session.init().catch((e) => toasts.error(e));

  // Start polling playback once the Web API is usable.
  $effect(() => {
    if (session.ready && !playerStarted) {
      playerStarted = true;
      player.start();
    }
  });

  // New page, new scroll position.
  $effect(() => {
    router.version;
    main?.scrollTo({ top: 0 });
  });

  const route = $derived(router.current);
  const lyricsRoute = $derived(route.name === "lyrics");
  const immersive = $derived(lyricsRoute && lyrics.immersive);
  // Search updates its route in place while typing; don't remount it per keystroke.
  const viewKey = $derived(route.name === "search" ? "search" : JSON.stringify(route));

  function isTyping(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    return el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
  }

  function onKey(e: KeyboardEvent) {
    if (!session.ready) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "l" || e.key === "k")) {
      e.preventDefault();
      topbar?.focusSearch();
    } else if (e.altKey && e.key === "ArrowLeft") {
      router.back();
    } else if (e.altKey && e.key === "ArrowRight") {
      router.forward();
    } else if (isTyping(e)) {
      return;
    } else if (e.key === " " && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      player.togglePlay();
    } else if (mod && e.key === "ArrowRight") {
      player.next();
    } else if (mod && e.key === "ArrowLeft") {
      player.prev();
    } else if (mod && e.key === "ArrowUp") {
      e.preventDefault();
      player.setVolume(player.volume + 10);
    } else if (mod && e.key === "ArrowDown") {
      e.preventDefault();
      player.setVolume(player.volume - 10);
    }
  }

  // Mouse back/forward buttons.
  function onMouseUp(e: MouseEvent) {
    if (e.button === 3) router.back();
    if (e.button === 4) router.forward();
  }
</script>

<svelte:window onkeydown={onKey} onmouseup={onMouseUp} oncontextmenu={(e) => e.preventDefault()} />

{#if !session.status}
  <div class="boot"></div>
{:else if !session.ready}
  <Setup />
{:else}
  <div class="shell" class:queue-open={queueOpen} class:immersive>
    {#if !immersive}<Sidebar />{/if}

    <main bind:this={main} class:fill={lyricsRoute} onscroll={() => (scrolled = (main?.scrollTop ?? 0) > 24)}>
      {#if !immersive}
        <div class="bar" class:scrolled={scrolled || lyricsRoute}>
          <TopBar bind:this={topbar} />
        </div>
      {/if}

      {#if session.device?.state === "needs_login"}
        <div class="banner">
          <p>Sign in once more so this computer can play your music.</p>
          <button class="btn primary" onclick={() => session.signIn()} disabled={session.signingIn}>
            {session.signingIn ? "Waiting for your browser…" : "Sign in for playback"}
          </button>
        </div>
      {/if}

      {#key viewKey}
        <div class="view">
          {#if route.name === "home"}
            <Home />
          {:else if route.name === "search"}
            <Search q={route.q} />
          {:else if route.name === "liked"}
            <Liked />
          {:else if route.name === "albums"}
            <Albums />
          {:else if route.name === "artists"}
            <Artists />
          {:else if route.name === "album"}
            <Album id={route.id} />
          {:else if route.name === "artist"}
            <Artist id={route.id} />
          {:else if route.name === "playlist"}
            <Playlist id={route.id} />
          {:else if route.name === "lyrics"}
            <Lyrics />
          {:else if route.name === "settings"}
            <Settings />
          {/if}
        </div>
      {/key}
    </main>

    {#if queueOpen}
      <QueuePanel onclose={() => (queueOpen = false)} />
    {/if}

    <div class="deck-slot">
      <NowPlaying {queueOpen} ontogglequeue={() => (queueOpen = !queueOpen)} />
    </div>
  </div>
{/if}

<ContextMenu />
<Toasts />

<style>
  .boot {
    height: 100%;
    background: var(--graphite);
  }

  .shell {
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) var(--deck-h);
    height: 100%;
  }
  .shell.queue-open {
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr) 320px;
  }
  .shell.immersive {
    grid-template-columns: minmax(0, 1fr);
  }
  .shell.immersive.queue-open {
    grid-template-columns: minmax(0, 1fr) 320px;
  }

  /* The lyrics view fills the pane instead of scrolling with it. */
  main.fill {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  main.fill .view {
    flex: 1;
    min-height: 0;
  }

  main {
    position: relative;
    overflow-y: auto;
    overflow-x: hidden;
    min-width: 0;
  }

  /* Sticky top bar; transparent over headers, solid once content scrolls under it. */
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    transition: background 160ms;
  }
  .bar.scrolled {
    background: color-mix(in srgb, var(--graphite) 92%, transparent);
    backdrop-filter: blur(12px);
  }

  .view {
    position: relative;
  }

  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin: 0 var(--gutter) 16px;
    padding: 12px 12px 12px 18px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--brass) 16%, var(--panel));
    font-size: var(--t-md);
  }

  .deck-slot {
    grid-column: 1 / -1;
  }
</style>
