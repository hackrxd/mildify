// Svelte transitions for things that change in place: a new track, a heart, play and pause.
// Entrances are CSS animations, which app.css stills for reduced motion. These run through the
// Web Animations API, which ignores that rule, so they check the preference themselves.
import { backOut, cubicOut } from "svelte/easing";
import type { TransitionConfig } from "svelte/transition";

let query: MediaQueryList | null | undefined;

/** The system asks for less motion. Read when a transition starts, so a change applies to the next one. */
export function reducedMotion(): boolean {
  if (query === undefined) {
    query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  }
  return query?.matches ?? false;
}

/** Grows in from `from` and overshoots a little: an icon that just changed state. */
export function pop(_node: Element, { from = 0.4, duration = 380 }: { from?: number; duration?: number } = {}): TransitionConfig {
  if (reducedMotion()) return { duration: 0 };
  return {
    duration,
    easing: backOut,
    css: (t) => `transform: scale(${from + (1 - from) * t}); opacity: ${Math.min(1, t * 2)}`,
  };
}

/** Fades in while rising `y` pixels into place, optionally growing from `scale`: content that replaced what was there. */
export function rise(
  _node: Element,
  { y = 8, scale = 1, delay = 0, duration = 420 }: { y?: number; scale?: number; delay?: number; duration?: number } = {},
): TransitionConfig {
  if (reducedMotion()) return { duration: 0 };
  return {
    delay,
    duration,
    easing: cubicOut,
    css: (t, u) => `transform: translateY(${u * y}px) scale(${scale + (1 - scale) * t}); opacity: ${t}`,
  };
}
