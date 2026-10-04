<script lang="ts">
  import { fly } from "svelte/transition";
  import { toasts } from "../lib/toasts.svelte";
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts.items as t (t.id)}
    <button class="toast {t.tone}" transition:fly={{ y: 12, duration: 160 }} onclick={() => toasts.dismiss(t.id)}>
      {t.message}
    </button>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(var(--deck-h) + 18px);
    transform: translateX(-50%);
    display: grid;
    gap: 8px;
    justify-items: center;
    z-index: 40;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    max-width: min(560px, 90vw);
    padding: 10px 18px;
    border-radius: 10px;
    background: var(--text);
    color: var(--bg);
    font-size: var(--t-md);
    font-weight: 600;
    box-shadow: 0 10px 28px rgb(0 0 0 / 0.4);
  }
  .toast.error {
    background: #4a1f1a;
    color: #ffd9d2;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 50%, transparent), 0 10px 28px rgb(0 0 0 / 0.4);
  }
</style>
