<script lang="ts">
  let { size = 18 }: { size?: number } = $props();
</script>

<!-- Spicy Lyrics' sparkling microphone, redrawn on Icon's grid: its stroke, its padding. -->
<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d="M15 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.9 7.7l5.4 5.4M10.8 10.4l-6 7.3a1.1 1.1 0 0 0 1.5 1.5l7.3-6" />
  <path
    fill="currentColor"
    stroke="none"
    d="M6 2.5c.4 2.1 1.2 2.9 3.3 3.3-2.1.4-2.9 1.2-3.3 3.3-.4-2.1-1.2-2.9-3.3-3.3 2.1-.4 2.9-1.2 3.3-3.3zM18.8 15.5c.3 1.7 1 2.4 2.7 2.7-1.7.3-2.4 1-2.7 2.7-.3-1.7-1-2.4-2.7-2.7 1.7-.3 2.4-1 2.7-2.7z"
  />
</svg>
