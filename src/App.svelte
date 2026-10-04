<script lang="ts">
  import { untrack } from "svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import Icon from "./components/Icon.svelte";
  import NowPlaying from "./components/NowPlaying.svelte";
  import QueuePanel from "./components/QueuePanel.svelte";
  import Setup from "./components/Setup.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Toasts from "./components/Toasts.svelte";
  import TopBar from "./components/TopBar.svelte";
  import { startDevtools } from "./lib/devtools";
  import { player } from "./lib/player.svelte";
  import { router } from "./lib/router.svelte";
  import { session } from "./lib/session.svelte";
  import { toasts } from "./lib/toasts.svelte";
  import { updater } from "./lib/updater.svelte";
  import { whatsNew } from "./lib/whatsnew.svelte";
  import Album from "./views/Album.svelte";
  import Albums from "./views/Albums.svelte";
  import Artist from "./views/Artist.svelte";
  import Artists from "./views/Artists.svelte";
  import Home from "./views/Home.svelte";
  import Liked from "./views/Liked.svelte";
  import Lyrics from "./views/Lyrics.svelte";
  import { BACKDROP_FADE_MS, lyrics } from "./lib/lyrics.svelte";
  import { mods } from "./lib/mods.svelte";
  import Playlist from "./views/Playlist.svelte";
  import ExtensionPage from "./views/ExtensionPage.svelte";
  import Search from "./views/Search.svelte";
  import Settings from "./views/Settings.svelte";
  import Changelog from "./views/Changelog.svelte";

  let main: HTMLElement | undefined = $state();
  let backdrop: HTMLElement | undefined = $state();
  let topbar: TopBar | undefined = $state();
  let scrolled = $state(false);
  let queueOpen = $state(false);
  let playerStarted = false;

  session.init().catch((e) => toasts.error(e));
  updater.start();
  whatsNew.start();
  mods.init();
  startDevtools();

  // Start polling playback once the Web API is usable.
  $effect(() => {
    if (session.ready && !playerStarted) {
      playerStarted = true;
      player.start();
    }
  });

  // Extensions can add pages and menu items, so they wait for the app shell.
  $effect(() => {
    if (session.ready) untrack(() => mods.startExtensions());
  });

  // Drop played songs' lyrics from the cache and fetch the upcoming ones.
  $effect(() => {
    const uri = player.track?.uri;
    untrack(() => lyrics.trackChanged(uri));
  });

  // New page, new scroll position.
  $effect(() => {
    router.version;
    main?.scrollTo({ top: 0 });
  });

  const route = $derived(router.current);
  const lyricsRoute = $derived(route.name === "lyrics");
  const immersive = $derived(lyricsRoute && lyrics.immersive);
  // The lyrics view's cover background, behind the whole window.
  const backdropOn = $derived(lyricsRoute && lyrics.backdrop);
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
  <div class="backdrop" class:on={backdropOn} style:--backdrop-fade="{BACKDROP_FADE_MS}ms" bind:this={backdrop}></div>
  <div
    class="shell"
    class:queue-open={queueOpen}
    class:immersive
    class:see-through={backdropOn}
    class:dim={lyrics.backdropDim}
    style:--backdrop-fade="{BACKDROP_FADE_MS}ms"
  >
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
      {:else if session.device?.state === "premium_required"}
        <div class="banner">
          <p>Playing music needs Spotify Premium. You can still browse your library and playlists.</p>
          <button class="btn primary" onclick={() => session.restartDevice()}>Check again</button>
        </div>
      {/if}

      {#if whatsNew.banner && route.name !== "changelog"}
        <div class="banner">
          <p>Mildify is now version {whatsNew.current}.</p>
          <div class="actions">
            <button class="btn primary" onclick={() => whatsNew.open()}>See what's new</button>
            <button class="icon-btn" onclick={() => whatsNew.dismiss()} title="Dismiss" aria-label="Dismiss">
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
      {/if}

      {#if updater.state === "ready" || updater.state === "installing"}
        <div class="banner">
          {#if updater.needsRestart}
            <p>
              Version {updater.available} is ready. It updates more than the interface, so Mildify has to restart to
              install it, and your music will stop.
            </p>
            <button class="btn primary" onclick={() => updater.apply()} disabled={updater.state === "installing"}>
              {updater.state === "installing" ? "Installing…" : "Restart and stop music"}
            </button>
          {:else}
            <p>Version {updater.available} is ready. Reload to finish updating; your music keeps playing.</p>
            <button class="btn primary" onclick={() => updater.apply()} disabled={updater.state === "installing"}>
              {updater.state === "installing" ? "Reloading…" : "Reload now"}
            </button>
          {/if}
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
            <Lyrics {backdrop} />
          {:else if route.name === "settings"}
            <Settings />
          {:else if route.name === "changelog"}
            <Changelog />
          {:else if route.name === "extension"}
            <ExtensionPage id={route.id} />
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
    background: var(--bg);
  }

  /* Sidebar, main pane and queue float as rounded panels on a darker frame; the deck sits on the frame. */
  .shell {
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) var(--deck-h);
    gap: 0 var(--seam);
    height: 100%;
    padding: var(--seam) var(--seam) 0;
    background: var(--frame);
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

  /* In the lyrics view, its cover background fills the window and the panels turn see-through,
     or tinted a little so they still read as panels. Both ways, the theme's colours cross-fade
     with it; the renderer keeps the background running until the fade out is done. */
  .backdrop {
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: #000;
    opacity: 0;
    transition: opacity var(--backdrop-fade) var(--ease-out);
  }
  .backdrop.on {
    opacity: 1;
  }
  .shell {
    position: relative;
    --backdrop-tint: transparent;
  }
  .shell.dim {
    --backdrop-tint: color-mix(in srgb, var(--bg) 45%, transparent);
  }
  .shell,
  .shell main,
  .shell > :global(:is(.sidebar, .panel)),
  .shell > :global(.sidebar .heading) {
    transition-property: background-color, border-color;
    transition-duration: var(--backdrop-fade);
    transition-timing-function: var(--ease-out);
  }
  .shell.see-through,
  .shell.see-through main {
    background-color: transparent;
  }
  .shell.see-through > :global(:is(.sidebar, .panel)),
  .shell.see-through .deck-slot > :global(.deck) {
    background-color: var(--backdrop-tint);
  }
  /* The deck fades these itself, alongside its own colour. */
  .shell.see-through .deck-slot > :global(.deck) {
    --deck-glow: 0%;
  }
  .shell.see-through .bar.scrolled {
    background-color: var(--backdrop-tint);
    backdrop-filter: none;
    transition-property: background-color, backdrop-filter;
    transition-duration: var(--backdrop-fade);
  }
  /* A rule across a panel that isn't there any more just floats. */
  .shell.see-through:not(.dim) > :global(.sidebar .heading) {
    border-top-color: transparent;
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
    border-radius: var(--panel-radius);
    background: var(--bg);
  }

  /* Sticky top bar; transparent over headers, solid once content scrolls under it. */
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    transition: background 160ms;
  }
  .bar.scrolled {
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(12px);
  }

  /* Each page settles in as it opens. The lyrics stage only fades: it measures its own layout. */
  .view {
    position: relative;
    animation: view-in 300ms var(--ease-out) backwards;
  }
  main.fill .view {
    animation-name: fade-in;
  }
  @keyframes view-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }

  .banner .actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .banner {
    /* Page headers pull up under the top bar (margin-top: -60px), over the banners; stay above them, below the bar. */
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin: 0 var(--gutter) 16px;
    padding: 12px 12px 12px 18px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--highlight) 16%, var(--surface));
    font-size: var(--t-md);
    animation: drop-in 360ms var(--ease-out) backwards;
  }
  @keyframes drop-in {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
  }

  .deck-slot {
    grid-column: 1 / -1;
    margin: 0 calc(-1 * var(--seam));
  }
</style>
