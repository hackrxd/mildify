<script lang="ts">
  import Icon from "./Icon.svelte";

  // The DJ's "cover": its item in the player bar and the queue has no album art of its own.
  let { size = 56 }: { size?: number } = $props();
</script>

<span class="dj-cover" style:--size="{size}px" aria-hidden="true">
  <Icon name="dj" size={Math.round(size * 0.46)} />
</span>

<style>
  .dj-cover {
    display: grid;
    place-items: center;
    width: var(--size);
    height: var(--size);
    flex: none;
    border-radius: 6px;
    color: var(--on-highlight);
    background:
      radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--highlight) 55%, white) 0%, transparent 60%),
      linear-gradient(135deg, var(--highlight), color-mix(in srgb, var(--highlight) 45%, var(--bg)));
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
  }
</style>
