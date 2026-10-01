<script lang="ts">
  // Loading / error placeholder for views. Loading text appears only after a
  // short delay so fast loads don't flash.
  let { error = null, onretry }: { error?: string | null; onretry?: () => void } = $props();

  let showLoading = $state(false);
  $effect(() => {
    const t = setTimeout(() => (showLoading = true), 250);
    return () => clearTimeout(t);
  });
</script>

<div class="status">
  {#if error}
    <p>{error}</p>
    {#if onretry}<button class="btn quiet" onclick={onretry}>Try again</button>{/if}
  {:else if showLoading}
    <p class="muted">Loading…</p>
  {/if}
</div>

<style>
  .status {
    display: grid;
    justify-items: start;
    gap: 14px;
    padding: 48px var(--gutter);
    font-size: var(--t-md);
  }
  p {
    max-width: 60ch;
  }
</style>
