<script lang="ts">
  import { dj } from "../lib/dj.svelte";
  import { REQUEST_MAX } from "../lib/djPicks";
  import { rise } from "../lib/motion";

  // Asking the DJ for its next set, and what's been asked for until that set comes on. On the DJ page and in the
  // player bar's DJ panel, so each copy needs its own field id.
  let { compact = false }: { compact?: boolean } = $props();

  const id = `dj-request-${Math.random().toString(36).slice(2, 8)}`;
  let request = $state("");
  function ask() {
    if (!request.trim()) return;
    dj.request(request);
    request = "";
  }
</script>

<form class="ask" class:compact onsubmit={(e) => (e.preventDefault(), ask())}>
  <label class="muted small" for={id}>Ask for the next set</label>
  <div class="ask-row">
    <input
      {id}
      class="field"
      maxlength={REQUEST_MAX}
      placeholder={compact ? "Something upbeat, the 90s…" : "Something upbeat, more Radiohead, the 90s…"}
      bind:value={request}
    />
    <button class="btn primary" type="submit" disabled={!request.trim()}>Ask</button>
  </div>
</form>
{#if dj.requested}
  <p class="small requested" in:rise={{ y: 4, duration: 240 }}>
    {#if dj.requestedBy}{dj.requestedBy.name} asked for the next set{:else}Your request is next{/if}: “{dj.requested}”
    <button class="link" onclick={() => dj.cancelRequest()}>Never mind</button>
  </p>
{/if}

<style>
  .ask {
    display: grid;
    gap: 6px;
    width: 100%;
    max-width: 520px;
    margin-top: 6px;
  }
  .ask.compact {
    margin-top: 0;
  }
  .ask-row {
    display: flex;
    gap: 8px;
  }
  .ask-row .field {
    flex: 1;
    min-width: 0;
  }
  .requested {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
</style>
