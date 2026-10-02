<script lang="ts">
  import { untrack } from "svelte";
  import { mods } from "../lib/mods.svelte";
  import { router } from "../lib/router.svelte";

  let { id }: { id: string } = $props();

  const page = $derived(mods.page(id));
  let el: HTMLElement | undefined = $state();

  // Hand the extension an empty element; it draws the page and cleans up when the page closes.
  $effect(() => {
    if (!page || !el) return;
    const target = el;
    const current = page;
    let cleanup: void | (() => void);
    try {
      // Whatever app state render reads mustn't re-run it; extensions use watch() for that.
      cleanup = untrack(() => current.render(target));
    } catch (e) {
      console.error(`[${current.extension}] page failed to render`, e);
      target.textContent = `This page couldn't load: ${e instanceof Error ? e.message : String(e)}`;
    }
    return () => {
      try {
        if (typeof cleanup === "function") untrack(cleanup);
      } catch (e) {
        console.error(`[${current.extension}] page cleanup failed`, e);
      }
      target.replaceChildren();
    };
  });
</script>

<div class="page">
  {#if page}
    <h1>{page.label}</h1>
    <div class="body" bind:this={el} data-extension={page.extension}></div>
  {:else}
    <h1>Page not available</h1>
    <p class="muted">The extension that added this page is turned off or was removed.</p>
    <div><button class="btn quiet" onclick={() => router.go({ name: "settings" })}>Open settings</button></div>
  {/if}
</div>

<style>
  .page {
    display: grid;
    gap: 28px;
    padding: 20px var(--gutter) 48px;
  }
  h1 {
    font-family: var(--font-display);
    font-variation-settings: "wdth" 125;
    font-weight: 800;
    font-size: clamp(2.5rem, 4.6vw, 4rem);
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .body {
    min-width: 0;
    user-select: text;
  }
</style>
