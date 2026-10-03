<script lang="ts">
  // A horizontal slider that only commits on release, so dragging a seek bar
  // doesn't fire a seek per pixel. Arrow keys step by `step`.
  let {
    value,
    max,
    step = max / 50,
    label,
    disabled = false,
    oncommit,
    onpreview,
  }: {
    value: number;
    max: number;
    step?: number;
    label: string;
    disabled?: boolean;
    oncommit: (v: number) => void;
    onpreview?: (v: number | null) => void;
  } = $props();

  let track: HTMLDivElement | undefined = $state();
  let dragValue = $state<number | null>(null);

  const shown = $derived(dragValue ?? value);
  const pct = $derived(max > 0 ? Math.max(0, Math.min(1, shown / max)) * 100 : 0);

  function valueAt(clientX: number) {
    const rect = track!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * max;
  }

  function down(e: PointerEvent) {
    if (disabled || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragValue = valueAt(e.clientX);
    onpreview?.(dragValue);
  }

  function move(e: PointerEvent) {
    if (dragValue === null) return;
    dragValue = valueAt(e.clientX);
    onpreview?.(dragValue);
  }

  function up() {
    if (dragValue === null) return;
    const v = dragValue;
    dragValue = null;
    onpreview?.(null);
    oncommit(v);
  }

  function key(e: KeyboardEvent) {
    if (disabled) return;
    const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
    if (!delta) return;
    e.preventDefault();
    oncommit(Math.max(0, Math.min(max, value + delta)));
  }
</script>

<div
  class="slider"
  class:dragging={dragValue !== null}
  class:disabled
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={Math.round(max)}
  aria-valuenow={Math.round(shown)}
  aria-disabled={disabled}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={key}
>
  <div class="track" bind:this={track}>
    <div class="fill" style:width="{pct}%"></div>
    <div class="thumb" style:left="{pct}%"></div>
  </div>
</div>

<style>
  .slider {
    position: relative;
    height: 16px;
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
  }
  .slider.disabled {
    cursor: default;
    opacity: 0.5;
  }
  .track {
    position: relative;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--paper) 18%, transparent);
  }
  /* Glides between updates (the position ticks four times a second; seeks and arrow keys jump),
     but follows the pointer exactly while dragging. */
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 2px;
    background: var(--paper);
    transition: width 250ms linear, background 120ms;
  }
  .thumb {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--paper);
    transform: translate(-50%, -50%) scale(0);
    transition: transform 100ms, left 250ms linear;
  }
  .dragging .fill {
    transition: background 120ms;
  }
  .dragging .thumb {
    transition: transform 100ms;
  }
  .slider:hover:not(.disabled) .fill,
  .slider.dragging .fill,
  .slider:focus-visible .fill {
    background: var(--brass);
  }
  .slider:hover:not(.disabled) .thumb,
  .slider.dragging .thumb,
  .slider:focus-visible .thumb {
    transform: translate(-50%, -50%) scale(1);
  }
  .slider:focus-visible {
    outline: none;
  }
</style>
