/**
 * @name Recently played
 * @description A sidebar page with the last 20 songs you played. Double-click one to play it.
 * @author Mildify
 * @version 1.0
 */

import { formatTime } from "./format.js";

export default function (ns) {
  ns.addStyle(`
    .rp-list { display: grid; gap: 2px; }
    .rp-row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 12px; border-radius: 6px; }
    .rp-row:hover { background: var(--surface-raised); }
    .rp-row.playing .rp-name { color: var(--highlight); }
    .rp-when { color: var(--text-muted); font-size: var(--t-sm); }
  `);

  ns.addPage({
    id: "recent",
    label: "Recently played",
    icon: "queue",
    render(el) {
      el.innerHTML = `<p class="muted">Loading…</p>`;
      let stopWatching = () => {};

      ns.api("GET", "/me/player/recently-played", { query: { limit: 20 } })
        .then(({ items }) => {
          const list = document.createElement("div");
          list.className = "rp-list";
          for (const { track, played_at } of items) {
            const row = document.createElement("div");
            row.className = "rp-row";
            row.dataset.uri = track.uri;
            row.innerHTML = `<span class="rp-name"></span><span class="rp-when"></span>`;
            row.firstChild.textContent = `${track.name} · ${track.artists.map((a) => a.name).join(", ")}`;
            row.lastChild.textContent = formatTime(played_at);
            row.ondblclick = () => ns.player.playUris([track.uri]);
            list.append(row);
          }
          el.replaceChildren(list);

          // Re-runs whenever the playing track changes.
          stopWatching = ns.watch(() => {
            const playing = ns.player.track?.uri;
            for (const row of list.children) row.classList.toggle("playing", row.dataset.uri === playing);
          });
        })
        .catch((e) => {
          el.textContent = `Couldn't load your history: ${e.message}`;
        });

      // Runs when you leave the page.
      return () => stopWatching();
    },
  });
}
