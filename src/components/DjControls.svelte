<script lang="ts">
  import { dj } from "../lib/dj.svelte";
  import { stageText } from "../lib/djView";
  import { router } from "../lib/router.svelte";
  import DjAsk from "./DjAsk.svelte";
  import Icon from "./Icon.svelte";

  // The DJ from the player bar, wherever the listener is: what's on and what's next, skipping, asking and stopping,
  // in a panel under the DJ's chip. It opens and closes like the device picker beside it.
  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  const next = $derived(
    dj.upNext?.name ?? (dj.stage ? stageText(dj.stage) : dj.phase === "starting" ? "Getting ready…" : "Being picked…"),
  );

  function onWindowClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
  function go() {
    open = false;
    router.go({ name: "dj" });
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => e.key === "Escape" && (open = false)} />

<div class="controls" bind:this={root}>
  <button
    class="dj-chip"
    class:busy={dj.phase === "starting"}
    aria-expanded={open}
    aria-haspopup="dialog"
    title="Your DJ"
    onclick={() => (open = !open)}
  >
    <Icon name="dj" size={14} /><span>{dj.current?.name ?? dj.upNext?.name ?? "DJ"}</span>
  </button>

  {#if open}
    <div class="pop" role="dialog" aria-label="Your DJ">
      <h3>Your DJ</h3>
      <dl>
        {#if dj.current}
          <dt>Now</dt>
          <dd>{dj.current.name}</dd>
        {/if}
        <dt>{dj.current ? "Up next" : "First"}</dt>
        <dd>{next}</dd>
      </dl>
      <div class="actions">
        {#if dj.onAir}
          <button class="btn quiet" onclick={() => dj.skipTalk()}><Icon name="next" size={16} /> Skip the talk</button>
        {:else if dj.skippingSet}
          <button class="btn quiet" disabled><Icon name="next" size={16} /> Picking something else…</button>
        {:else if dj.canSkipSet(dj.current)}
          <button class="btn quiet" onclick={() => dj.skipSet()}><Icon name="next" size={16} /> Skip this set</button>
        {/if}
        {#if dj.canHurry && (dj.phase === "starting" || dj.musicWaits)}
          <button class="btn quiet" onclick={() => dj.hurry()}>Don't wait: a short intro now</button>
        {/if}
      </div>
      <DjAsk compact />
      <div class="foot">
        <button class="link" onclick={go}>Open the DJ page</button>
        <button class="btn quiet" onclick={() => ((open = false), dj.stop())}>
          <Icon name="close" size={16} /> Stop the DJ
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .controls {
    position: relative;
  }
  /* The DJ is on: its set, and its panel a click away. */
  .dj-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 180px;
    height: 26px;
    margin-right: 6px;
    padding: 0 10px;
    border-radius: 13px;
    background: color-mix(in srgb, var(--highlight) 16%, transparent);
    color: var(--highlight);
    font-size: var(--t-xs);
    font-weight: 700;
    white-space: nowrap;
  }
  .dj-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dj-chip :global(svg) {
    flex: none;
  }
  .dj-chip.busy {
    animation: breathe 1.6s ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dj-chip.busy {
      animation: none;
    }
  }

  .pop {
    position: absolute;
    right: -8px;
    bottom: calc(100% + 14px);
    width: 340px;
    display: grid;
    gap: 12px;
    padding: 14px;
    border-radius: 12px;
    background: var(--surface-raised);
    box-shadow: var(--shadow-pop);
    z-index: 20;
    transform-origin: bottom right;
    animation: pop-in 140ms ease-out;
  }
  @keyframes pop-in {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.97);
    }
  }
  h3 {
    font-size: var(--t-md);
    font-weight: 600;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    margin: 0;
    font-size: var(--t-sm);
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions,
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .actions:empty {
    display: none;
  }
  .foot {
    justify-content: space-between;
  }
</style>
