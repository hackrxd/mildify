<script lang="ts">
  import type { Snippet } from "svelte";
  import { coverColor } from "../lib/color";

  let {
    image,
    kind,
    title,
    round = false,
    art,
    tint,
    meta,
    actions,
  }: {
    image: string | null;
    kind: string;
    title: string;
    round?: boolean;
    /** Replaces the cover image (e.g. for Liked Songs). */
    art?: Snippet;
    /** Wash colour to use when there's no image to sample. */
    tint?: string;
    meta?: Snippet;
    actions?: Snippet;
  } = $props();

  let ambient = $state<string | null>(null);
  $effect(() => {
    const url = image;
    ambient = null;
    coverColor(url).then((c) => {
      if (url === image) ambient = c;
    });
  });

  // Very long titles step down so the header never wraps to five lines.
  const size = $derived(title.length > 48 ? "s" : title.length > 22 ? "m" : "l");
</script>

<header class="hero" style:--ambient={ambient ?? tint ?? "var(--raised)"}>
  <div class="art" class:round>
    {#if art}{@render art()}{:else if image}<img src={image} alt="" />{/if}
  </div>
  <div class="text">
    <p class="kind">{kind}</p>
    <h1 class="title size-{size}">{title}</h1>
    {#if meta}<div class="meta">{@render meta()}</div>{/if}
  </div>
</header>
{#if actions}
  <div class="actions" style:--ambient={ambient ?? tint ?? "var(--raised)"}>{@render actions()}</div>
{/if}

<style>
  .hero {
    display: flex;
    align-items: flex-end;
    gap: 32px;
    padding: 72px var(--gutter) 28px;
    margin-top: -60px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--ambient) 85%, transparent), color-mix(in srgb, var(--ambient) 45%, transparent));
    transition: background 500ms;
  }

  .art {
    flex: none;
    width: clamp(168px, 18vw, 232px);
    aspect-ratio: 1;
    border-radius: 6px;
    overflow: hidden;
    background: color-mix(in srgb, var(--graphite) 40%, transparent);
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.5);
  }
  .art.round {
    border-radius: 50%;
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .text {
    min-width: 0;
    display: grid;
    gap: 10px;
  }
  .kind {
    font-size: var(--t-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  /* The signature: record-sleeve titles set wide and heavy. */
  .title {
    font-family: var(--font-display);
    font-variation-settings: "wdth" 125;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 0.95;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    padding-bottom: 0.06em;
  }
  .size-l {
    font-size: clamp(2.75rem, 6.4vw, 6rem);
  }
  .size-m {
    font-size: clamp(2.25rem, 4.4vw, 4rem);
  }
  .size-s {
    font-size: clamp(1.75rem, 3vw, 2.75rem);
    font-variation-settings: "wdth" 110;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
    font-size: var(--t-md);
    color: color-mix(in srgb, var(--paper) 80%, transparent);
  }

  /* Picks up where the hero's wash ends and fades it out behind the top of the list, so there's no seam.
     The extra bottom padding carries the fade; the negative margin pulls the list back up over it. */
  .actions {
    --fade: 160px;
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 22px var(--gutter) calc(22px + var(--fade));
    margin-bottom: calc(-1 * var(--fade));
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--ambient) 45%, transparent),
      color-mix(in srgb, var(--ambient) 24%, transparent) 70px,
      color-mix(in srgb, var(--ambient) 8%, transparent) 170px,
      transparent
    );
  }
</style>
