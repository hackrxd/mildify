<script lang="ts">
  import { player } from "../lib/player.svelte";
  import { session } from "../lib/session.svelte";
  import type { Device } from "../lib/types";
  import Icon, { type IconName } from "./Icon.svelte";

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  function toggle() {
    open = !open;
    if (open) player.loadDevices();
  }

  function iconFor(d: Device): IconName {
    const t = d.type.toLowerCase();
    if (t === "computer") return "computer";
    if (t === "smartphone" || t === "tablet") return "phone";
    return "speaker";
  }

  const localId = $derived(session.device?.device_id);
  const localName = $derived(session.device?.name);
  const isLocal = (d: Device) => d.id === localId || d.name === localName;

  // Our own device first, then the rest as Spotify lists them.
  const sorted = $derived([...player.devices].sort((a, b) => Number(isLocal(b)) - Number(isLocal(a))));

  function pick(d: Device) {
    if (d.id && !d.is_active) player.transferTo(d.id, player.isPlaying || !player.deviceId);
    open = false;
  }

  function onWindowClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => e.key === "Escape" && (open = false)} />

<div class="picker" bind:this={root}>
  <button
    class="icon-btn"
    class:on={!!player.deviceId && !player.isLocal}
    onclick={toggle}
    title="Connect to a device"
    aria-expanded={open}
  >
    <Icon name="speaker" />
  </button>

  {#if open}
    <div class="pop" role="dialog" aria-label="Devices">
      <h3>Play on</h3>
      <ul>
        {#each sorted as d (d.id ?? d.name)}
          <li>
            <button class="dev" class:active={d.is_active} disabled={!d.id || d.is_restricted} onclick={() => pick(d)}>
              <Icon name={iconFor(d)} />
              <span class="label">
                <span class="name">{d.name}</span>
                <span class="sub">
                  {#if d.is_active}Playing here{:else if isLocal(d)}This computer{:else}{d.type}{/if}
                </span>
              </span>
              {#if d.is_active}<Icon name="check" size={18} />{/if}
            </button>
          </li>
        {:else}
          <li class="none muted">No devices found. Open Spotify on another device, or check the built-in player in Settings.</li>
        {/each}
      </ul>
      {#if session.device && session.device.state !== "ready"}
        <p class="warn">
          {#if session.device.state === "premium_required"}
            The built-in player needs Spotify Premium.
          {:else}
            The built-in player is {session.device.state.replace("_", " ")}.
          {/if}
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
  }

  .pop {
    position: absolute;
    right: -8px;
    bottom: calc(100% + 14px);
    width: 300px;
    padding: 14px 8px 8px;
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
    padding: 0 10px 8px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .dev {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    text-align: left;
  }
  .dev:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .dev.active {
    color: var(--highlight);
    background: color-mix(in srgb, var(--highlight) 10%, transparent);
  }

  .label {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .name {
    font-size: var(--t-md);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: var(--t-xs);
    color: var(--text-muted);
  }
  /* Device types can arrive lowercase; "Playing here" and "This computer" are already in sentence case. */
  .sub::first-letter {
    text-transform: uppercase;
  }
  .dev.active .sub {
    color: inherit;
  }

  .none,
  .warn {
    padding: 6px 10px 8px;
    font-size: var(--t-sm);
  }
  .warn {
    color: var(--highlight);
  }
</style>
