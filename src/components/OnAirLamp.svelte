<script lang="ts">
  import { untrack } from "svelte";
  import { reducedMotion } from "../lib/motion";

  // A studio's on-air sign beside the DJ page's title: unlit while the DJ is off, warming while it picks its
  // first songs, lit once it's on, with a ring going out while it talks, and dimmed while the listener has it
  // paused. It catches like a filament when it lights. The page says all this in words too, so it's hidden
  // from screen readers.
  type LampState = "off" | "warming" | "on" | "talking" | "held";
  let { mode }: { mode: LampState } = $props();

  const lit = $derived(mode !== "off" && mode !== "warming");
  const titles: Record<LampState, string> = {
    off: "Your DJ is off",
    warming: "Your DJ is getting ready",
    on: "Your DJ is on",
    talking: "Your DJ is talking",
    held: "Your DJ is paused",
  };

  let glass: HTMLSpanElement | undefined = $state();
  let was = untrack(() => lit);
  $effect(() => {
    const now = lit;
    if (now && !was && glass && !reducedMotion()) {
      glass.animate(
        [{ opacity: 0.35 }, { opacity: 1, offset: 0.12 }, { opacity: 0.5, offset: 0.22 }, { opacity: 1, offset: 0.34 }, { opacity: 1 }],
        { duration: 520, easing: "linear" },
      );
    }
    was = now;
  });
</script>

<span class="lamp {mode}" title={titles[mode]} aria-hidden="true">
  <span class="glass" bind:this={glass}></span>
  <span class="label">On air</span>
</span>

<style>
  .lamp {
    position: relative;
    display: inline-grid;
    place-items: center;
    height: 26px;
    padding: 0 12px;
    border-radius: 13px;
    box-shadow: inset 0 0 0 1px var(--border);
    color: var(--text-muted);
    font-size: var(--t-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    isolation: isolate;
    transition: color 300ms var(--ease-out);
  }
  .glass {
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background:
      radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--highlight) 55%, white) 0%, transparent 60%),
      linear-gradient(135deg, var(--highlight), color-mix(in srgb, var(--highlight) 70%, var(--bg)));
    box-shadow: 0 0 12px color-mix(in srgb, var(--highlight) 45%, transparent);
    opacity: 0;
    transition: opacity 300ms var(--ease-out);
  }
  .warming .glass {
    opacity: 0.35;
    animation: warm 1.6s ease-in-out infinite alternate;
  }
  @keyframes warm {
    from {
      opacity: 0.15;
    }
    to {
      opacity: 0.35;
    }
  }
  .on .glass,
  .talking .glass {
    opacity: 1;
  }
  /* Dim glass behind light text; dark ink only on the fully lit sign. */
  .held .glass {
    opacity: 0.3;
  }
  .warming,
  .held {
    color: var(--text);
  }
  .on,
  .talking {
    color: var(--on-highlight);
  }
  .lamp::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: 0 0 0 1.5px var(--highlight);
    opacity: 0;
    pointer-events: none;
  }
  .talking::after {
    animation: ring 2.2s ease-out infinite;
  }
  @keyframes ring {
    0% {
      opacity: 0.7;
      transform: none;
    }
    60%,
    100% {
      opacity: 0;
      transform: scale(1.12, 1.5);
    }
  }
  /* Held still: the ring stays as an outline, so talking still looks different from on. */
  @media (prefers-reduced-motion: reduce) {
    .talking::after {
      opacity: 0.7;
    }
  }
</style>
