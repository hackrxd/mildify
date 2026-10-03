<script lang="ts">
  import type { Snippet } from "svelte";
  import { pop } from "../lib/motion";

  // Redraws its content with a pop whenever `key` changes (play to pause, liked to not).
  // The first render stays still: local transitions only run when the key changes.
  let { key, children }: { key: unknown; children: Snippet } = $props();
</script>

{#key key}
  <span class="pop" in:pop>{@render children()}</span>
{/key}

<style>
  .pop {
    display: inline-grid;
    place-items: center;
  }
</style>
