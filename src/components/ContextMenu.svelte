<script lang="ts">
  import { tick } from "svelte";
  import { menu } from "../lib/menu.svelte";

  let el: HTMLUListElement | undefined = $state();
  let pos = $state({ x: 0, y: 0 });

  // Keep the menu on screen, then focus the first item for keyboard use.
  $effect(() => {
    if (!menu.open) return;
    pos = { x: menu.x, y: menu.y };
    tick().then(() => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = menu.alignEnd ? menu.x - r.width : menu.x;
      pos = {
        x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
        y: Math.min(menu.y, window.innerHeight - r.height - 8),
      };
      el.querySelector("button")?.focus();
    });
  });

  function onKey(e: KeyboardEvent) {
    if (!menu.open) return;
    if (e.key === "Escape") menu.close(true);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const buttons = [...(el?.querySelectorAll("button:not(:disabled)") ?? [])] as HTMLButtonElement[];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }
</script>

<svelte:window
  onkeydown={onKey}
  onpointerdown={(e) => menu.open && el && !el.contains(e.target as Node) && menu.close()}
  onblur={() => menu.close()}
  onresize={() => menu.close()}
/>

{#if menu.open}
  <ul class="menu" class:end={menu.alignEnd} role="menu" bind:this={el} style:left="{pos.x}px" style:top="{pos.y}px">
    <!-- Not keyed by label: two entries may share one, as two artists may share a name. -->
    {#each menu.items as item}
      <li role="none">
        <button
          role="menuitem"
          disabled={item.disabled}
          onclick={() => {
            menu.close(true);
            item.action();
          }}
        >
          {item.label}
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 50;
    min-width: 200px;
    margin: 0;
    padding: 5px;
    list-style: none;
    border-radius: 10px;
    background: var(--surface-raised);
    box-shadow: var(--shadow-pop);
    transform-origin: top left;
    animation: pop-in 120ms ease-out;
  }
  .menu.end {
    transform-origin: top right;
  }
  @keyframes pop-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }
  button {
    width: 100%;
    padding: 8px 12px;
    border-radius: 6px;
    text-align: left;
    font-size: var(--t-md);
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: color-mix(in srgb, var(--text) 8%, transparent);
    outline: none;
  }
</style>
