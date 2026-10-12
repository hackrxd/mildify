<script lang="ts">
  import { dj, OPENING_TIMEOUT_MS } from "../lib/dj.svelte";
  import { readySteps } from "../lib/djView";
  import Icon from "./Icon.svelte";

  // While the DJ gets its first set ready: each step it takes, ticked off as it goes, how long it's been once that's
  // worth saying, and, once the model has had a fair while, a way to start without it.

  /** Past this long, the time so far is shown. */
  const SHOW_TIME_MS = 10_000;
  /** Past this long, the listener can start without waiting for the model. */
  const OFFER_MS = 15_000;

  const steps = $derived(readySteps({ stage: dj.stage, status: dj.status, talk: dj.talk, modelLoaded: dj.modelLoaded }));
  let now = $state(performance.now());
  $effect(() => {
    const t = setInterval(() => (now = performance.now()), 1000);
    return () => clearInterval(t);
  });
  // From when the session started, so coming back to the page doesn't start the count again.
  const waited = $derived(now - dj.startedAt);
  const minutes = OPENING_TIMEOUT_MS / 60_000;
</script>

<div class="ready">
  <ol aria-label="Getting your first set ready">
    {#each steps as step (step.label)}
      <li class={step.state}>
        <span class="mark" aria-hidden="true">
          {#if step.state === "done"}<Icon name="check" size={14} />{/if}
        </span>
        {step.label}
        <span class="visually-hidden">{step.state === "done" ? "(done)" : step.state === "now" ? "(under way)" : ""}</span>
      </li>
    {/each}
  </ol>
  {#if waited >= SHOW_TIME_MS}
    <p class="muted small">
      {Math.floor(waited / 1000)} s so far. If its model takes more than {minutes === 2.5 ? "2½" : minutes} minutes, it
      starts with a short intro from a template.
    </p>
  {/if}
  <div aria-live="polite">
    {#if dj.canHurry && waited >= OFFER_MS}
      <button class="btn quiet" onclick={() => dj.hurry()}>Start now with a short intro</button>
    {/if}
  </div>
</div>

<style>
  .ready {
    display: grid;
    gap: 10px;
    justify-items: start;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
    text-align: left;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    font-size: var(--t-md);
  }
  li.done {
    color: var(--text);
  }
  li.now {
    color: var(--text);
    animation: breathe 1.8s ease-in-out infinite;
  }
  .mark {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1.5px solid currentColor;
    flex: none;
  }
  li.done .mark {
    border-color: var(--highlight);
    color: var(--highlight);
  }
  li.later .mark {
    opacity: 0.5;
  }
  @keyframes breathe {
    50% {
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    li.now {
      animation: none;
    }
  }
</style>
