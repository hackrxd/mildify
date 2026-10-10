<script lang="ts">
  // A question under a setting, before a change that stops something or can't be taken back, answered in place.
  // The cancel button has the focus, and Escape answers with it; answered, the focus goes back where it was.
  let {
    text,
    confirm,
    cancel,
    danger = false,
    onconfirm,
    oncancel,
  }: { text: string; confirm: string; cancel: string; danger?: boolean; onconfirm: () => void; oncancel: () => void } = $props();

  const id = $props.id();
  let keep: HTMLButtonElement | undefined = $state();
  /** Where the focus was when it asked. */
  let back: Element | null = null;

  $effect(() => {
    back = document.activeElement;
    keep?.focus();
  });

  /** Gives the focus back before answering, which takes the question away. */
  function answer(then: () => void) {
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    then();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    answer(oncancel);
  }
</script>

<div class="confirm" role="group" aria-labelledby={id}>
  <p {id}>{text}</p>
  <span class="answers">
    <button class="btn {danger ? 'danger' : 'primary'}" onclick={() => answer(onconfirm)} {onkeydown}>{confirm}</button>
    <button class="btn quiet" bind:this={keep} onclick={() => answer(oncancel)} {onkeydown}>{cancel}</button>
  </span>
</div>

<style>
  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 16px;
    margin: 6px 0;
    padding: 12px 14px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--highlight) 7%, var(--surface));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--highlight) 28%, var(--border));
    font-size: var(--t-md);
    animation: rise 240ms var(--ease-out) backwards;
  }
  p {
    flex: 1 1 320px;
    max-width: 62ch;
  }
  .answers {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .answers .btn {
    flex: none;
  }
</style>
