<script lang="ts" module>
  // 24px grid. Stroke icons unless listed in FILLED.
  const PATHS = {
    home: "M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z",
    search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM20 20l-4.8-4.8",
    heart: "M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z",
    disc: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
    mic: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21",
    sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
    back: "M15 5l-7 7 7 7",
    forward: "M9 5l7 7-7 7",
    play: "M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4l-12-7.5A.8.8 0 0 0 7 4.5z",
    pause: "M6.5 4h3.5v16H6.5zM14 4h3.5v16H14z",
    next: "M5 5.2v13.6a.6.6 0 0 0 .9.5l10-6.8a.6.6 0 0 0 0-1L5.9 4.7a.6.6 0 0 0-.9.5zM17.5 4.5h2v15h-2z",
    prev: "M19 5.2v13.6a.6.6 0 0 1-.9.5l-10-6.8a.6.6 0 0 1 0-1l10-6.8a.6.6 0 0 1 .9.5zM4.5 4.5h2v15h-2z",
    shuffle: "M3 7h3.5c2.5 0 4 1.5 5.5 5s3 5 5.5 5H20M3 17h3.5c1.4 0 2.5-.5 3.4-1.5M14 8.5c.8-1 1.9-1.5 3.5-1.5H20M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5",
    repeat: "M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3",
    repeatOne: "M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3M11.5 10.5l1-.5v5",
    volume: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
    volumeLow: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6",
    volumeOff: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5",
    speaker: "M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM12 10.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM12 6.5v.01",
    computer: "M3.5 5h17v11h-17zM9 20h6M12 16v4",
    phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
    queue: "M4 6h12M4 11h12M4 16h7M15 15l5 3-5 3z",
    plus: "M12 5v14M5 12h14",
    close: "M6 6l12 12M18 6 6 18",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    check: "M5 12.5l4.5 4.5L19 7.5",
    refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
    signOut: "M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10",
    lyrics: "M5 5.5h14M5 10h10M5 14.5h12M5 19h7",
    cover: "M4 4h16v16H4zM4 15.5l4.5-4.5 4 4 2.5-2.5L20 17.5M15.5 8.5h.01",
    romanize: "M3.5 18 8 6l4.5 12M5.2 13.5h5.6M15 10.5c.6-.7 1.5-1 2.5-1 1.7 0 2.5 1 2.5 2.6V18M20 13.8c-3.5 0-5.3.7-5.3 2.3 0 1.1.8 1.9 2.1 1.9 1.6 0 3.2-1.2 3.2-3",
    expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    collapse: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  } as const;

  const FILLED = new Set(["play", "pause", "next", "prev"]);

  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  let {
    name,
    size = 20,
    filled = false,
    label,
  }: { name: IconName; size?: number; filled?: boolean; label?: string } = $props();

  const isFilled = $derived(filled || FILLED.has(name));
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={isFilled ? "currentColor" : "none"}
  stroke={isFilled ? "none" : "currentColor"}
  stroke-width={name === "more" ? 3 : 1.75}
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
>
  <path d={PATHS[name]} />
</svg>
