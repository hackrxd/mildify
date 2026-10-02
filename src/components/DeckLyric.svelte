<script lang="ts">
  import { untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { lineAt, lyricLines, nextChange, sung, type LyricLine } from "../lib/lyricLines";
  import { lyrics } from "../lib/lyrics.svelte";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";

  /** Any narrower and the line would crowd the title, so it isn't shown. */
  const MIN_WIDTH = 200;

  let width = $state(0);
  let lineEl: HTMLElement | undefined = $state();
  let loaded = $state.raw<{ id: string; user: string | null | undefined; lines: LyricLine[] } | null>(null);
  let shown = $state.raw<{ lines: LyricLine[]; index: number } | null>(null);

  const uri = $derived(player.track?.uri ?? "");
  const trackId = $derived(uri.startsWith("spotify:track:") ? uri.split(":")[2] : null);
  // Signing in to the lyrics service can turn a failed fetch into lyrics.
  const lyricsUser = $derived(lyrics.server?.username);
  const wanted = $derived(lyrics.inDeck && width >= MIN_WIDTH);
  const lines = $derived(loaded && loaded.id === trackId ? loaded.lines : []);
  // The lyrics view already shows the line, much bigger.
  const visible = $derived(wanted && router.current.name !== "lyrics" && lines.length > 0);
  const line = $derived(visible && shown?.lines === lines ? lines[shown.index] : undefined);

  $effect(() => {
    const id = trackId;
    const user = lyricsUser;
    if (!id || !wanted) return;
    const have = untrack(() => loaded);
    if (have?.id === id && have.user === user) return;
    let stale = false;
    untrack(() => lyrics.fetchQuietly(id)).then((response) => {
      if (!stale) loaded = { id, user, lines: lyricLines(response) };
    });
    return () => {
      stale = true;
    };
  });

  // Re-runs on every position update (4 Hz), so seeks and pauses land; the timer
  // catches the line changes in between on time. `shown` is read untracked: it's written here.
  $effect(() => {
    if (!visible) return;
    void [player.position, player.isPlaying, lyrics.totalOffsetMs];
    const ls = lines;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const now = Math.max(0, player.positionNow() - lyrics.totalOffsetMs);
      const index = lineAt(ls, now);
      if (shown?.lines !== ls || shown.index !== index) shown = { lines: ls, index };
      if (player.isPlaying) timer = setTimeout(tick, Math.min(1000, Math.max(16, nextChange(ls, now) - now)));
    };
    untrack(tick);
    return () => clearTimeout(timer);
  });

  // Syllable syncs fill each syllable as it's sung. Per frame, but only while such a line
  // is up and playing; styles are written directly so Svelte doesn't re-render each frame.
  $effect(() => {
    const el = lineEl;
    const syllables = line?.syllables;
    if (!el || !syllables) return;
    void [player.position, player.isPlaying, lyrics.totalOffsetMs];
    const spans = el.querySelectorAll<HTMLElement>(".syllable");
    const painted: number[] = [];
    let frame = 0;
    const paint = () => {
      const now = Math.max(0, player.positionNow() - lyrics.totalOffsetMs);
      syllables.forEach((s, i) => {
        const part = sung(s, now);
        if (painted[i] !== part) spans[i]?.style.setProperty("--sung", String((painted[i] = part)));
      });
      if (player.isPlaying) frame = requestAnimationFrame(paint);
    };
    untrack(paint);
    return () => cancelAnimationFrame(frame);
  });

  const credit = $derived(lyrics.current ? `Lyrics from ${lyrics.current.provider}. Click for all lyrics.` : "Show lyrics");
</script>

<div class="deck-lyric" bind:clientWidth={width}>
  {#if line}
    {#key line}
      <button
        class="line"
        class:synced={!!line.syllables}
        bind:this={lineEl}
        in:fade={{ duration: 160 }}
        onclick={() => router.go({ name: "lyrics" })}
        title={credit}
      >
        {#if line.syllables}
          {#each line.syllables as s, i (i)}<span class="syllable">{s.text}</span>{s.partOfWord ? "" : " "}{/each}
        {:else}
          {line.text}
        {/if}
      </button>
    {/key}
  {/if}
</div>

<style>
  .deck-lyric {
    flex: 1 1 0;
    min-width: 0;
    margin-left: 12px;
  }
  .line {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    max-width: 100%;
    font-size: var(--t-md);
    font-weight: 500;
    line-height: 1.35;
    text-align: left;
    color: var(--paper);
    opacity: 0.85;
  }
  .line:hover {
    opacity: 1;
  }
  .synced {
    opacity: 1;
  }
  /* Sung text is full brightness, the rest dimmed; a soft edge sweeps across each syllable. */
  .syllable {
    --sung: 0;
    --edge: 0.35em;
    color: transparent;
    background: linear-gradient(
      90deg,
      var(--paper) calc(var(--sung) * (100% + var(--edge)) - var(--edge)),
      color-mix(in srgb, var(--paper) 45%, transparent) calc(var(--sung) * (100% + var(--edge)))
    );
    -webkit-background-clip: text;
    background-clip: text;
  }
</style>
