<script lang="ts">
  import { untrack } from "svelte";
  import { fade } from "svelte/transition";
  import * as renderer from "spicy-lyrics-renderer";
  import Icon from "../components/Icon.svelte";
  import { BACKDROP_FADE_MS, lyrics, TEXT_SCALE_MAX, TEXT_SCALE_MIN, TEXT_SCALE_STEP } from "../lib/lyrics.svelte";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";

  /** The app's full-window layer the cover background moves to, when that's turned on. */
  let { backdrop }: { backdrop?: HTMLElement } = $props();

  let host: HTMLDivElement | undefined = $state();
  let mounted = $state(false);
  let nowBar = $state(renderer.isNowBarOpen());
  let romanAvailable = $state(false);
  let romanized = $state(renderer.isRomanizedView());
  let lastUri: string | undefined;

  let optionsOpen = $state(false);
  let optionsEl: HTMLElement | undefined = $state();
  /** A short note after a change made from the keyboard, where the options panel isn't showing it. */
  let readout = $state<string | null>(null);
  let readoutTimer: ReturnType<typeof setTimeout> | undefined;

  /** One nudge; Shift makes it ten. */
  const NUDGE_MS = 50;

  let username = $state("");
  let password = $state("");
  let signingIn = $state(false);

  // Mount once per host element (and background target). Everything inside is untracked: the
  // renderer reads the player while mounting, and tracking that would remount it on every poll.
  $effect(() => {
    const el = host;
    const bg = lyrics.backdrop ? backdrop : null;
    if (!el || bg === undefined) return;
    const { off, ro } = untrack(() => {
      lyrics.install();
      lastUri = player.track?.uri;
      const off = renderer.onLyricsApplied(() => {
        romanAvailable = renderer.romanizationAvailable();
      });
      // Narrow panes pin the active line to the top, like upstream's compact mode.
      const ro = new ResizeObserver(([entry]) => renderer.setCompact(entry.contentRect.width < 720));
      ro.observe(el);
      renderer.mount(el, bg).then(() => (mounted = true));
      return { off, ro };
    });
    return () => {
      off();
      ro.disconnect();
      mounted = false;
      // The app fades the backdrop out; its background has to last that long.
      renderer.unmount(bg ? BACKDROP_FADE_MS : 0);
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

  // Line heights follow the text size; have the renderer re-read them once it applies.
  $effect(() => {
    void lyrics.textScale;
    if (mounted) untrack(() => requestAnimationFrame(() => renderer.remeasure()));
  });

  function timing(ms: number): string {
    return ms === 0 ? "In step with the audio" : `${Math.abs(ms)} ms ${ms > 0 ? "later" : "earlier"}`;
  }

  function note(text: string) {
    if (optionsOpen) return;
    readout = text;
    clearTimeout(readoutTimer);
    readoutTimer = setTimeout(() => (readout = null), 1600);
  }

  function nudge(ms: number) {
    lyrics.nudgeSong(ms);
    note(`This song: ${timing(lyrics.songOffsetMs).toLowerCase()}`);
  }

  function resetSong() {
    lyrics.setSongOffset(0);
    note("This song: in step with the audio");
  }

  function zoom(steps: number) {
    lyrics.setTextScale(steps === 0 ? 1 : lyrics.textScale + steps * TEXT_SCALE_STEP);
    note(`Text size ${Math.round(lyrics.textScale * 100)}%`);
  }

  function typing(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    return el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (optionsOpen) optionsOpen = false;
      else if (lyrics.immersive) lyrics.immersive = false;
      return;
    }
    if (typing(e) || lyrics.needsSignIn) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "=" || e.key === "+")) zoom(1);
    else if (mod && e.key === "-") zoom(-1);
    else if (mod && e.key === "0") zoom(0);
    else if (mod || e.altKey) return;
    // Shift turns [ and ] into { and } on most layouts.
    else if (e.key === "[" || e.key === "{") nudge(-NUDGE_MS * (e.shiftKey ? 10 : 1));
    else if (e.key === "]" || e.key === "}") nudge(NUDGE_MS * (e.shiftKey ? 10 : 1));
    else if (e.key === "\\") resetSong();
    else if (e.key === "f" || e.key === "F") lyrics.immersive = !lyrics.immersive;
    else return;
    e.preventDefault();
  }

  // The path, not contains(): a button that removes itself (Reset) is detached by the time this runs.
  function onWindowClick(e: MouseEvent) {
    if (optionsOpen && optionsEl && !e.composedPath().includes(optionsEl)) optionsOpen = false;
  }

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

<svelte:window onkeydown={onKey} onclick={onWindowClick} />

<section class="lyrics-view" class:see-through={lyrics.backdrop} aria-label="Lyrics" style:--lyrics-scale={lyrics.textScale}>
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
    <div class="options-anchor" bind:this={optionsEl}>
      <button
        class="ctl"
        class:on={optionsOpen || lyrics.songOffsetMs !== 0}
        onclick={() => (optionsOpen = !optionsOpen)}
        title="Timing, text size and copying"
        aria-expanded={optionsOpen}
      >
        <Icon name="sliders" size={18} />
      </button>
      {#if optionsOpen}
        <div class="options" role="dialog" aria-label="Lyrics options">
          <div class="option">
            <span class="option-label">This song's timing</span>
            <div class="stepper">
              <button class="step" onclick={() => nudge(-NUDGE_MS)} title="Earlier ([)" aria-label="Show lyrics earlier">
                <Icon name="minus" size={16} />
              </button>
              <span class="value" aria-live="polite">{timing(lyrics.songOffsetMs)}</span>
              <button class="step" onclick={() => nudge(NUDGE_MS)} title="Later (])" aria-label="Show lyrics later">
                <Icon name="plus" size={16} />
              </button>
            </div>
            <span class="hint">
              For this song only, on top of the timing in Settings{lyrics.offsetMs !== 0
                ? ` (${timing(lyrics.offsetMs).toLowerCase()})`
                : ""}. Keys: [ and ], Shift for bigger steps.
            </span>
            {#if lyrics.songOffsetMs !== 0}
              <button class="link" onclick={resetSong}>Reset this song (\)</button>
            {/if}
          </div>
          <div class="option">
            <span class="option-label">Text size</span>
            <div class="stepper">
              <button
                class="step"
                onclick={() => zoom(-1)}
                disabled={lyrics.textScale <= TEXT_SCALE_MIN}
                title="Smaller (Ctrl −)"
                aria-label="Smaller lyrics"
              >
                <span class="glyph small">A</span>
              </button>
              <button class="value as-button" onclick={() => zoom(0)} title="Reset text size (Ctrl 0)">
                {Math.round(lyrics.textScale * 100)}%
              </button>
              <button
                class="step"
                onclick={() => zoom(1)}
                disabled={lyrics.textScale >= TEXT_SCALE_MAX}
                title="Larger (Ctrl +)"
                aria-label="Larger lyrics"
              >
                <span class="glyph">A</span>
              </button>
            </div>
          </div>
          <button class="copy" onclick={() => lyrics.copy(romanAvailable && romanized)} disabled={!lyrics.hasText}>
            <Icon name="copy" size={16} />
            {romanAvailable && romanized ? "Copy romanized lyrics" : "Copy lyrics"}
          </button>
        </div>
      {/if}
    </div>
    <button
      class="ctl"
      onclick={() => (lyrics.immersive = !lyrics.immersive)}
      title={lyrics.immersive ? "Exit full window (Esc)" : "Fill the window (F)"}
    >
      <Icon name={lyrics.immersive ? "collapse" : "expand"} size={18} />
    </button>
    <button class="ctl" onclick={() => router.back()} title="Close lyrics">
      <Icon name="close" size={18} />
    </button>
  </div>

  {#if readout}
    <div class="readout" role="status" transition:fade={{ duration: 140 }}>{readout}</div>
  {/if}

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
    --spice-button: var(--highlight);
    --spice-rgb-selected-row: 255, 255, 255;
    --background-tinted-base: rgb(255 255 255 / 0.07);
    --encore-graphic-size-decorative-base: 24px;
  }
  /* The cover background is behind the whole window instead. */
  .lyrics-view.see-through {
    background: none;
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
    color: var(--highlight);
  }

  .options-anchor {
    position: relative;
  }
  .options {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    display: grid;
    gap: 16px;
    width: 280px;
    padding: 16px;
    border-radius: 12px;
    background: rgb(20 21 26 / 0.9);
    backdrop-filter: blur(20px);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
    font-size: var(--t-sm);
  }
  .option {
    display: grid;
    gap: 8px;
    justify-items: start;
  }
  .option-label {
    font-weight: 600;
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  .step {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    flex: none;
    border-radius: 50%;
    background: rgb(255 255 255 / 0.08);
    color: #fff;
  }
  .step:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.16);
  }
  .step:disabled {
    opacity: 0.35;
  }
  .glyph {
    font-weight: 700;
    font-size: 17px;
    line-height: 1;
  }
  .glyph.small {
    font-size: 12px;
  }
  .value {
    flex: 1;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .as-button {
    padding: 6px 0;
    border-radius: 6px;
  }
  .as-button:hover {
    background: rgb(255 255 255 / 0.08);
  }
  .hint {
    color: rgb(255 255 255 / 0.55);
    font-size: var(--t-xs);
  }
  .link {
    color: var(--highlight);
    font-size: var(--t-xs);
  }
  .link:hover {
    text-decoration: underline;
  }
  .copy {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 8px;
    background: rgb(255 255 255 / 0.08);
    color: #fff;
  }
  .copy:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.16);
  }
  .copy:disabled {
    opacity: 0.4;
  }

  .readout {
    position: absolute;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 6;
    padding: 6px 14px;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.5);
    backdrop-filter: blur(14px);
    color: #fff;
    font-size: var(--t-sm);
    pointer-events: none;
  }

  /* Text size: the renderer's own sizes, scaled. One more class than its rules, so these win. */
  .lyrics-view :global(#SpicyLyricsPage .LyricsContainer .LyricsContent) {
    --DefaultLyricsSize: calc(clamp(1.85rem, calc(1cqw * 7), 3.5rem) * var(--lyrics-scale, 1));
  }
  .lyrics-view
    :global(#SpicyLyricsPage.SpicyRenderer .LyricsContainer .SpicyLyricsScrollContainer[data-lyrics-type="Static"]) {
    --DefaultLyricsSize: calc(clamp(0.8rem, calc(1cqw * 5), 2.5rem) * var(--lyrics-scale, 1));
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
    color: var(--text-muted);
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
