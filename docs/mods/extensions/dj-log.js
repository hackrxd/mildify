/**
 * @name DJ log
 * @description Logs what the AI DJ does, on a page of its own, and gives it a Short songs segment, an instruction and a set menu entry.
 * @author Mildify
 * @version 1.0
 */

/** How many entries the log keeps. */
const KEEP = 100;

/** Puts text on the clipboard. Older WebKitGTK builds refuse the async API; a hidden text box still works there. */
async function copy(text) {
  try {
    return await navigator.clipboard.writeText(text);
  } catch {
    const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
    area.style.cssText = "position: fixed; opacity: 0; pointer-events: none";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("Couldn't copy to the clipboard");
  }
}

export default function (ns) {
  /** What happened, newest first, kept across restarts. */
  let log = ns.storage.get("log") ?? [];
  /** Draws the log again while its page is open. */
  let redraw = () => {};

  const note = (text) => {
    log = [{ at: new Date().toISOString(), text }, ...log].slice(0, KEEP);
    ns.storage.set("log", log);
    redraw();
  };
  const byline = (song) => `${song.name} by ${song.artists.join(", ")}`;

  // What happens in a session, as it happens.
  ns.dj.on((e) => {
    if (e.type === "set-started") {
      const from = e.set.from ? `, a segment from ${e.set.from}` : "";
      note(`Started “${e.set.name}”${from}: ${e.set.songs.map(byline).join("; ")}`);
    } else if (e.type === "line-spoken") note(`${e.line.spoken ? "Said" : "Showed"}: “${e.line.talk}”`);
    else if (e.type === "song-skipped") note(`You skipped ${byline(e.song)}`);
    else if (e.type === "song-liked") note(`You liked ${byline(e.song)}`);
    else if (e.type === "set-skipped") note(`You skipped the rest of “${e.set.name}”`);
    else if (e.type === "stopped") note("The DJ stopped");
  });

  // A kind of set of its own, from your listening: songs under three minutes.
  ns.dj.addSegment({
    id: "short",
    label: "Short songs",
    brief: "songs under three minutes, to keep things moving",
    phrase: "some short ones",
    fits: (song) => song.durationMs < 180_000,
  });

  // Read after your own instructions, which come first where they disagree.
  ns.dj.setInstructions("Keep your lines short and upbeat.");

  ns.dj.addSetAction({
    label: "Copy song links",
    action: async (set) => {
      const links = set.songs.map((song) => `https://open.spotify.com/track/${song.uri.split(":")[2]}`);
      await copy(links.join("\n"));
      ns.toasts.show(`Copied ${links.length} song links`);
    },
  });

  ns.addStyle(`
    .djlog { display: grid; gap: 16px; max-width: 760px; }
    .djlog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .djlog-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
    .djlog-list li { display: flex; gap: 12px; padding: 8px 12px; border-radius: 6px; background: var(--surface); }
    .djlog-at { flex: none; color: var(--text-muted); font-size: var(--t-sm); font-variant-numeric: tabular-nums; }
  `);

  ns.addPage({
    id: "log",
    label: "DJ log",
    icon: "dj",
    render(el) {
      el.innerHTML = `
        <div class="djlog">
          <div class="djlog-head"><p class="djlog-now muted"></p><button class="btn quiet">Clear</button></div>
          <ul class="djlog-list"></ul>
        </div>`;
      const now = el.querySelector(".djlog-now");
      const list = el.querySelector(".djlog-list");
      el.querySelector("button").onclick = () => {
        log = [];
        ns.storage.remove("log");
        redraw();
      };

      redraw = () => {
        list.replaceChildren(
          ...log.map(({ at, text }) => {
            const li = document.createElement("li");
            const time = document.createElement("span");
            time.className = "djlog-at";
            time.textContent = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const what = document.createElement("span");
            what.textContent = text;
            li.append(time, what);
            return li;
          }),
        );
        if (!log.length) list.innerHTML = `<li class="muted">Nothing yet: start the DJ.</li>`;
      };
      redraw();

      // Re-runs whenever what it reads of the DJ changes.
      const stop = ns.watch(() => {
        const set = ns.dj.current;
        now.textContent =
          ns.dj.phase === "off" ? "The DJ is off." : set ? `Now: ${set.name}` : "The DJ is getting ready…";
      });

      return () => {
        redraw = () => {};
        stop();
      };
    },
  });
}
