<script lang="ts">
  import { untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { dj } from "../lib/dj.svelte";
  import { lineAt, sung } from "../lib/lyricLines";

  // What the DJ is saying, a line at a time, each word lit as it's spoken: the same lines and sweep as the
  // lyric in the player bar, timed by the DJ's voice instead of the song.
  let { stage = false }: { stage?: boolean } = $props();

  let index = $state(-1);
  let lineEl: HTMLElement | undefined = $state();

  const lines = $derived(dj.caption ?? []);
  const line = $derived(index >= 0 ? lines[index] : undefined);

  // Per frame while the DJ talks; word fills are written straight to the elements.
  $effect(() => {
    const ls = lines;
    if (!ls.length) {
      index = -1;
      return;
    }
    let frame = 0;
    const paint = () => {
      const now = dj.speechNow();
      // Between sentences the last one stays up; before the first, the first shows.
      let i = lineAt(ls, now);
      if (i < 0) i = Math.max(0, ls.filter((l) => l.start <= now).length - 1);
      if (i !== untrack(() => index)) index = i;
      const syllables = ls[i]?.syllables;
      const spans = lineEl?.querySelectorAll<HTMLElement>(".word");
      syllables?.forEach((s, j) => spans?.[j]?.style.setProperty("--sung", String(sung(s, now))));
      frame = requestAnimationFrame(paint);
    };
    untrack(paint);
    return () => cancelAnimationFrame(frame);
  });
</script>

<div class="dj-caption" class:stage aria-live="polite">
  {#if line}
    {#key line}
      <p class="line" bind:this={lineEl} in:fade={{ duration: 160 }}>
        <span class="who">DJ</span>
        {#each line.syllables ?? [] as s, i (i)}<span class="word">{s.text}</span>{" "}{/each}
      </p>
    {/key}
  {/if}
</div>

<style>
  .dj-caption {
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
    font-size: var(--t-md);
    font-weight: 500;
    line-height: 1.35;
    color: var(--text);
  }
  .who {
    display: inline-block;
    margin-right: 6px;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--highlight);
    color: var(--on-highlight);
    font-size: var(--t-xs);
    font-weight: 800;
    letter-spacing: 0.06em;
    vertical-align: 0.1em;
  }
  /* Spoken words at full brightness, the rest dimmed, a soft edge sweeping across each. */
  .word {
    --sung: 0;
    --edge: 0.35em;
    color: transparent;
    background: linear-gradient(
      90deg,
      var(--text) calc(var(--sung) * (100% + var(--edge)) - var(--edge)),
      color-mix(in srgb, var(--text) 45%, transparent) calc(var(--sung) * (100% + var(--edge)))
    );
    -webkit-background-clip: text;
    background-clip: text;
  }

  /* Over the lyrics: big, centred, on a dark pill so it reads over any cover. */
  .stage {
    margin: 0;
  }
  .stage .line {
    -webkit-line-clamp: 3;
    line-clamp: 3;
    max-width: min(900px, 86vw);
    margin: 0 auto;
    padding: 14px 22px;
    border-radius: 18px;
    background: rgb(0 0 0 / 0.55);
    backdrop-filter: blur(14px);
    font-size: clamp(1.25rem, 2.4vw, 2rem);
    font-weight: 700;
    line-height: 1.3;
    text-align: center;
    --text: #fff;
  }
</style>
