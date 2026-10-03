<script lang="ts">
  // Three bars bouncing like a level meter: marks what's playing. With reduced motion they
  // hold still at uneven heights, which still reads as the same mark. Takes the text colour.
  let { size = 14, label }: { size?: number; label?: string } = $props();
</script>

<span
  class="eq"
  style:--size="{size}px"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
>
  <span></span><span></span><span></span>
</span>

<style>
  .eq {
    display: inline-flex;
    align-items: flex-end;
    justify-content: space-between;
    flex: none;
    width: var(--size);
    height: var(--size);
  }
  .eq > span {
    width: 24%;
    height: 100%;
    border-radius: 1px;
    background: currentColor;
    transform-origin: 50% 100%;
    animation: level 0.9s ease-in-out infinite alternate;
  }
  /* Different speeds and offsets so the bars never move in step. */
  .eq > span:nth-child(1) {
    transform: scaleY(0.45);
    animation-duration: 0.82s;
    animation-delay: -0.3s;
  }
  .eq > span:nth-child(2) {
    transform: scaleY(0.9);
    animation-duration: 0.64s;
    animation-delay: -0.55s;
  }
  .eq > span:nth-child(3) {
    transform: scaleY(0.62);
    animation-duration: 1.04s;
    animation-delay: -0.15s;
  }

  @keyframes level {
    0% {
      transform: scaleY(0.2);
    }
    35% {
      transform: scaleY(0.95);
    }
    65% {
      transform: scaleY(0.5);
    }
    100% {
      transform: scaleY(0.8);
    }
  }
</style>
