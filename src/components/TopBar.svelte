<script lang="ts">
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { pickImage } from "../lib/util";
  import Icon from "./Icon.svelte";

  let input: HTMLInputElement | undefined = $state();
  let query = $state("");

  // Keep the box in sync when navigating between searches with back/forward.
  $effect(() => {
    const r = router.current;
    if (r.name === "search") query = r.q ?? "";
  });

  function onInput() {
    if (router.current.name === "search") router.replace({ name: "search", q: query });
    else router.go({ name: "search", q: query });
  }

  export function focusSearch() {
    input?.focus();
    input?.select();
  }

  const avatar = $derived(pickImage(session.user?.images, 40));
</script>

<header class="topbar">
  <div class="history">
    <button class="icon-btn" disabled={!router.canBack} onclick={() => router.back()} title="Back">
      <Icon name="back" />
    </button>
    <button class="icon-btn" disabled={!router.canForward} onclick={() => router.forward()} title="Forward">
      <Icon name="forward" />
    </button>
  </div>

  <label class="search">
    <Icon name="search" size={18} />
    <span class="visually-hidden">Search</span>
    <input
      bind:this={input}
      bind:value={query}
      oninput={onInput}
      onfocus={() => router.current.name !== "search" && query && onInput()}
      placeholder="Search songs, artists, albums"
      spellcheck="false"
    />
    {#if query}
      <button class="clear" onclick={() => { query = ""; onInput(); input?.focus(); }} title="Clear search">
        <Icon name="close" size={16} />
      </button>
    {/if}
  </label>

  <div class="me">
    {#if session.user}
      {#if avatar}<img src={avatar} alt="" />{/if}
      <span class="muted">{session.user.display_name ?? session.user.id}</span>
    {/if}
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 60px;
    padding: 0 var(--gutter) 0 16px;
  }

  .history {
    display: flex;
    gap: 2px;
  }

  .search {
    flex: 0 1 420px;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 38px;
    padding: 0 10px 0 14px;
    border-radius: 19px;
    background: var(--panel);
    color: var(--smoke);
    box-shadow: inset 0 0 0 1px transparent;
    transition: box-shadow 120ms;
  }
  .search:focus-within {
    box-shadow: inset 0 0 0 1.5px var(--brass);
    color: var(--paper);
  }
  input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: none;
    font-size: var(--t-md);
    user-select: text;
  }
  input::placeholder {
    color: var(--smoke);
  }
  .clear {
    display: grid;
    color: var(--smoke);
  }

  .me {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--t-sm);
  }
  .me img {
    width: 28px;
    height: 28px;
    border-radius: 50%;
  }
</style>
