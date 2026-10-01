<script lang="ts">
  import { untrack } from "svelte";
  import * as renderer from "spicy-lyrics-renderer";
  import Icon from "../components/Icon.svelte";
  import { lyrics } from "../lib/lyrics.svelte";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";

  let host: HTMLDivElement | undefined = $state();
  let mounted = $state(false);
  let nowBar = $state(renderer.isNowBarOpen());
  let romanAvailable = $state(false);
  let romanized = $state(renderer.isRomanizedView());
  let lastUri: string | undefined;

  let username = $state("");
  let password = $state("");
  let signingIn = $state(false);

  // Mount once per host element. Everything inside is untracked: the renderer reads
  // the player while mounting, and tracking that would remount it on every poll.
  $effect(() => {
    const el = host;
    if (!el) return;
    const { off, ro } = untrack(() => {
      lyrics.install();
      lastUri = player.track?.uri;
      const off = renderer.onLyricsApplied(() => {
        romanAvailable = renderer.romanizationAvailable();
      });
      // Narrow panes pin the active line to the top, like upstream's compact mode.
      const ro = new ResizeObserver(([entry]) => renderer.setCompact(entry.contentRect.width < 720));
      ro.observe(el);
      renderer.mount(el).then(() => (mounted = true));
      return { off, ro };
    });
    return () => {
      off();
      ro.disconnect();
      mounted = false;
      renderer.unmount();
      lyrics.immersive = false;
    };
  });

  // Re-run the renderer's song-change pipeline when the track (by URI) changes.
  $effect(() => {
    const uri = player.track?.uri;
    if (!mounted || !uri || uri === lastUri) return;
    lastUri = uri;
    untrack(() => {
      romanAvailable = false;
      renderer.songChanged();
    });
  });

  // Keep the renderer's fullscreen layout in step with immersive mode.
  $effect(() => {
    const immersive = lyrics.immersive;
    if (mounted) untrack(() => renderer.setFullscreen(immersive));
  });

  function toggleNowBar() {
    nowBar = !nowBar;
    renderer.setNowBar(nowBar);
  }

  function toggleRomanization() {
    renderer.toggleRomanization();
    romanized = renderer.isRomanizedView();
  }

  async function signIn(e: SubmitEvent) {
    e.preventDefault();
    signingIn = true;
    const ok = await lyrics.signIn(username, password);
    signingIn = false;
    password = "";
    if (ok) renderer.songChanged();
  }

  const credit = $derived(lyrics.current);
  // Community syncs credit the maker and uploader (once if they're the same person).
  const people = $derived.by(() => {
    if (!credit?.community) return [];
    const list: { label: string; user: { username: string; url: string | null } }[] = [];
    if (credit.maker) list.push({ label: "Synced by", user: credit.maker });
    if (credit.uploader && credit.uploader.username !== credit.maker?.username) {
      list.push({ label: credit.maker ? "uploaded by" : "Synced by", user: credit.uploader });
    }
    return list;
  });
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && lyrics.immersive && (lyrics.immersive = false)} />

<section class="lyrics-view" aria-label="Lyrics">
  <div class="stage" bind:this={host}></div>

  <div class="controls">
    <button class="ctl" class:on={nowBar} onclick={toggleNowBar} title={nowBar ? "Hide cover" : "Show cover"} aria-pressed={nowBar}>
      <Icon name="cover" size={18} />
    </button>
    {#if romanAvailable}
      <button
        class="ctl"
        class:on={romanized}
        onclick={toggleRomanization}
        title={romanized ? "Show original lyrics" : "Show romanized lyrics"}
        aria-pressed={romanized}
      >
        <Icon name="romanize" size={18} />
      </button>
    {/if}
    <button
      class="ctl"
      onclick={() => (lyrics.immersive = !lyrics.immersive)}
      title={lyrics.immersive ? "Exit full window (Esc)" : "Fill the window"}
    >
      <Icon name={lyrics.immersive ? "collapse" : "expand"} size={18} />
    </button>
    <button class="ctl" onclick={() => router.back()} title="Close lyrics">
      <Icon name="close" size={18} />
    </button>
  </div>

  {#if lyrics.needsSignIn}
    <form class="panel" onsubmit={signIn}>
      <h2>Sign in for lyrics</h2>
      <p>The lyrics service needs your account.</p>
      <input class="field" placeholder="Username" autocomplete="username" bind:value={username} required />
      <input class="field" type="password" placeholder="Password" autocomplete="current-password" bind:value={password} required />
      <button class="btn primary" type="submit" disabled={signingIn}>{signingIn ? "Signing in…" : "Sign in"}</button>
    </form>
  {/if}

  {#if credit}
    <!-- Required by the Spicy Lyrics API terms: visible whenever lyrics are. -->
    <footer class="credit">
      Lyrics from {credit.provider}.
      {#each people as p, i (p.label)}
        {i === 0 ? "" : ", "}{p.label}
        {#if p.user.url}<button class="person" onclick={() => window.open(p.user.url!)}>@{p.user.username}</button>{:else}@{p.user.username}{/if}{i === people.length - 1 ? "." : ""}
      {/each}
    </footer>
  {/if}
</section>

<style>
  .lyrics-view {
    position: relative;
    height: 100%;
    overflow: hidden;
    background: #000;
    /* Spotify theme variables the renderer's CSS reads, mapped to this app. */
    --spice-sidebar: #000;
    --spice-text: #fff;
    --spice-button: var(--brass);
    --spice-rgb-selected-row: 255, 255, 255;
    --background-tinted-base: rgb(255 255 255 / 0.07);
    --encore-graphic-size-decorative-base: 24px;
  }

  .stage {
    position: absolute;
    inset: 0;
  }

  .controls {
    position: absolute;
    top: 14px;
    right: 16px;
    z-index: 5;
    display: flex;
    gap: 6px;
  }
  .ctl {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: rgb(255 255 255 / 0.75);
    background: rgb(0 0 0 / 0.28);
    backdrop-filter: blur(14px);
    transition: color 120ms, background 120ms;
  }
  .ctl:hover {
    color: #fff;
    background: rgb(0 0 0 / 0.45);
  }
  .ctl.on {
    color: var(--brass);
  }

  .panel {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 6;
    display: grid;
    gap: 12px;
    justify-items: start;
    width: min(380px, 86%);
    padding: 24px;
    border-radius: 12px;
    background: rgb(20 21 26 / 0.86);
    backdrop-filter: blur(20px);
    font-size: var(--t-md);
  }
  .panel p {
    color: var(--smoke);
  }
  .panel .field {
    max-width: none;
  }

  .credit {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 5;
    padding: 10px 20px 12px;
    font-size: var(--t-xs);
    color: rgb(255 255 255 / 0.55);
    text-align: center;
    pointer-events: none;
  }
  .person {
    color: rgb(255 255 255 / 0.85);
    pointer-events: auto;
  }
  .person:hover {
    text-decoration: underline;
  }
</style>
