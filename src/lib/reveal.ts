// Scroll reveal: list items (track rows, cover cards, playlists) wait hidden until they scroll
// into view, then pop up; app.css styles `data-reveal`. Items of one list that arrive together,
// like the first screenful or a fast scroll, follow one another top to bottom, left to right.
// With reduced motion, or without IntersectionObserver, items are simply there.
import type { Attachment } from "svelte/attachments";
import { reducedMotion } from "./motion";

/** Items past this place in one arrival share its beat, so a long jump doesn't crawl in. */
const MAX_BEAT = 10;

let observer: IntersectionObserver | null = null;

function arrive(entries: IntersectionObserverEntry[]) {
  const shown = entries
    .filter((e) => e.isIntersecting)
    .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left);
  // Beats count per list, so a sidebar and a page that load together each start on the first beat.
  const beats = new Map<Element | null, number>();
  for (const { target } of shown) {
    const el = target as HTMLElement;
    const beat = beats.get(el.parentElement) ?? 0;
    beats.set(el.parentElement, beat + 1);
    observer?.unobserve(el);
    el.style.setProperty("--reveal-beat", String(Math.min(beat, MAX_BEAT)));
    el.dataset.reveal = "in";
  }
}

export const reveal: Attachment<HTMLElement> = (node) => {
  if (typeof IntersectionObserver === "undefined" || reducedMotion()) return;
  observer ??= new IntersectionObserver(arrive, { threshold: 0.1 });
  node.dataset.reveal = "wait";
  observer.observe(node);
  return () => observer?.unobserve(node);
};
