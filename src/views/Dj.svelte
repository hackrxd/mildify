<script lang="ts">
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import DjSongs from "../components/DjSongs.svelte";
  import Icon from "../components/Icon.svelte";
  import OnAirLamp from "../components/OnAirLamp.svelte";
  import { dj, type DjSet } from "../lib/dj.svelte";
  import { REQUEST_MAX } from "../lib/djPicks";
  import { INSTRUCTIONS_MAX } from "../lib/djTalk";
  import { setMenu } from "../lib/djMenu";
  import { djLead, offNote, providerName, troubleNotes } from "../lib/djView";
  import { contextMenu, menu } from "../lib/menu.svelte";
  import { reducedMotion, rise } from "../lib/motion";
  import { router } from "../lib/router.svelte";
  import { formatBytes, lowerFirst } from "../lib/util";

  // The page moves only when the show does: a card rises in when the DJ reaches a new stage of getting ready, the
  // set that was up next glides into Now as the finished one lifts away, and a new line drops in on top of what
  // it said. Nothing is keyed on `status` itself: download progress replaces it four times a second.

  dj.refresh();

  const status = $derived(dj.status);
  const install = $derived(status?.install);
  const missing = $derived(status?.needed.filter((n) => !n.installed) ?? []);
  const toDownload = $derived(missing.reduce((n, c) => n + c.bytes, 0));
  const share = $derived(install?.running && install.total ? Math.min(1, install.received / install.total) : null);
  const said = $derived([...dj.said].reverse());
  const ready = $derived(!!status?.supported && dj.enabled && !missing.length && !status.setup);
  let request = $state("");
  function ask() {
    if (!request.trim()) return;
    dj.request(request);
    request = "";
  }
  /** What's wrong with the DJ's model or voice, until it's fixed; it plays on all the same. */
  const troubles = $derived(
    troubleNotes({ model: dj.modelTrouble, voice: dj.voiceTrouble, talk: dj.talk, playing: dj.phase !== "off" }),
  );
  const lamp = $derived(
    dj.phase === "off" ? "off" : dj.phase === "starting" ? "warming" : dj.paused ? "held" : dj.speaking ? "talking" : "on",
  );

  /** The page below the header as one keyed list: the card, then the running order. A set keeps its place as it
   * moves up and as it grows when it's picked as it goes, and the card is measured with the rest, so a change in
   * its height moves the blocks below smoothly. */
  type Block = { key: number; kind: "set"; set: DjSet } | { key: string; kind: "card" | "trouble" | "said" | "tell" };
  const blocks = $derived.by(() => {
    const out: Block[] = [{ key: "card", kind: "card" }];
    if (ready) {
      if (troubles.length) out.push({ key: "trouble", kind: "trouble" });
      if (dj.current) out.push({ key: dj.current.id, kind: "set", set: dj.current });
      if (dj.upNext && dj.upNext.id !== dj.current?.id) out.push({ key: dj.upNext.id, kind: "set", set: dj.upNext });
      if (said.length) out.push({ key: "said", kind: "said" });
    }
    if (status?.supported && dj.enabled) out.push({ key: "tell", kind: "tell" });
    return out;
  });

  /** Blocks arriving wait this long, while the ones below slide out of their way. */
  const MAKE_ROOM_MS = 220;

  /** Svelte's flip, at the app's pace, and still for reduced motion (it doesn't go by the CSS rule). */
  function settle(node: Element, rects: { from: DOMRect; to: DOMRect }, { duration = 420, still = false } = {}) {
    return still || reducedMotion() ? { duration: 0 } : flip(node, rects, { duration, easing: cubicOut });
  }
  /** A new line's list, or trouble, drops in, once the blocks below have mostly made room; the sets bring their own
   * rows' entrance. */
  function enter(node: Element, kind: Block["kind"]) {
    if (kind === "said" || kind === "trouble") return rise(node, { y: -8, delay: MAKE_ROOM_MS });
    // A transition, not a CSS animation: nothing fades in when the page opens.
    if (kind === "set" && !reducedMotion()) {
      return { delay: MAKE_ROOM_MS, duration: 240, easing: cubicOut, css: (t: number) => `opacity: ${t}` };
    }
    return { duration: 0 };
  }
  /** A finished set lifts away. Through `translate`, not `transform`: Svelte holds a leaving block in place with an
   * inline transform while the blocks below close up. */
  function leave(_node: Element, kind: Block["kind"]) {
    if (kind !== "set" || reducedMotion()) return { duration: 0 };
    return { duration: 260, easing: cubicOut, css: (t: number, u: number) => `translate: 0 ${-8 * u}px; opacity: ${t}` };
  }
</script>

<div class="page">
  <header>
    <div class="title-row">
      <h1>DJ</h1>
      {#if ready}<OnAirLamp mode={lamp} />{/if}
    </div>
    <p class="muted lead">{djLead(status)}</p>
  </header>

  {#each blocks as b (b.key)}
    <section animate:settle={{ still: b.kind === "card" }} in:enter={b.kind} out:leave={b.kind}>
      {#if b.kind === "card"}
        {#if !status}
          <p class="muted checking">Checking on your DJ…</p>
        {:else if !status.supported}
          <section class="card" in:rise>
            <p>The DJ can't run on this computer: its model and voice aren't built for this kind of processor.</p>
          </section>
        {:else if !dj.enabled}
          <section class="card" in:rise>
            <p>{offNote(status)}</p>
            <div class="actions">
              <button class="btn primary" onclick={() => dj.setEnabled(true)}><Icon name="dj" size={18} /> Turn on the DJ</button>
              <button class="btn quiet" onclick={() => router.go({ name: "settings", section: "dj" })}>Choose a model and voice</button>
            </div>
          </section>
        {:else if missing.length && install?.running}
          <section class="card" in:rise>
            {#key install.component}
              <div class="step" in:rise={{ y: 4, duration: 300 }}>
                <p>Downloading {lowerFirst(install.component ?? "your DJ")}…</p>
                <div class="bar" role="progressbar" aria-valuenow={share === null ? undefined : Math.round(share * 100)}>
                  <div style:transform="scaleX({share ?? 0})"></div>
                </div>
              </div>
            {/key}
            <p class="muted small">
              {formatBytes(install.received)}{install.total ? ` of ${formatBytes(install.total)}` : ""}. {missing.length === 1
                ? "This is the last download."
                : `${missing.length} downloads left, ${formatBytes(toDownload)} in all.`} It keeps going if you leave this page.
            </p>
            <div class="actions"><button class="btn quiet" onclick={() => dj.cancelDownload()}>Pause download</button></div>
          </section>
        {:else if missing.length}
          <section class="card" in:rise>
            {#if install?.error}<p class="error">{install.error}</p>{/if}
            <p class="muted">{formatBytes(toDownload)} left to download before the DJ can play.</p>
            <div class="actions"><button class="btn primary" onclick={() => dj.retry()}>Download</button></div>
          </section>
        {:else if status.setup}
          <section class="card" in:rise>
            <p>
              The DJ is set to use {providerName(status.settings)}, and it isn't set up yet:
              {lowerFirst(status.setup)}.
            </p>
            <div class="actions"><button class="btn primary" onclick={() => router.go({ name: "settings", section: "dj" })}>Set it up in Settings</button></div>
          </section>
        {:else}
          <section class="card start" in:rise>
            {#if dj.phase === "off"}
              <button class="btn primary big" in:rise={{ y: 4, scale: 0.96, duration: 300 }} onclick={() => dj.start()}>
                <Icon name="play" size={18} /> Start the DJ
              </button>
              <p class="muted small" in:rise={{ y: 4, delay: 60, duration: 300 }}>
                It plays on this computer, and talks over the ends and starts of songs, never over the singing.
              </p>
            {:else}
              <button class="btn quiet big" in:rise={{ y: 4, scale: 0.96, duration: 300 }} onclick={() => dj.stop()}>
                <Icon name="close" size={18} /> Stop the DJ
              </button>
              {#if dj.activity}{#key dj.activity}<p class="muted small busy">{dj.activity}</p>{/key}{/if}
              {#if dj.phase === "on"}
                <form class="ask" onsubmit={(e) => (e.preventDefault(), ask())}>
                  <label class="muted small" for="dj-request">Ask for the next set</label>
                  <div class="ask-row">
                    <input
                      id="dj-request"
                      class="field"
                      maxlength={REQUEST_MAX}
                      placeholder="Something upbeat, more Radiohead, the 90s…"
                      bind:value={request}
                    />
                    <button class="btn primary" type="submit" disabled={!request.trim()}>Ask</button>
                  </div>
                </form>
                {#if dj.requested}
                  <p class="small requested" in:rise={{ y: 4, duration: 240 }}>
                    Your request is next: “{dj.requested}”
                    <button class="link" onclick={() => dj.cancelRequest()}>Never mind</button>
                  </p>
                {/if}
              {/if}
            {/if}
          </section>
        {/if}
      {:else if b.kind === "trouble"}
        <section class="card trouble">
          {#each troubles as note (note)}<p>{note}</p>{/each}
          <div class="actions">
            <button class="btn quiet" onclick={() => router.go({ name: "settings", section: "dj" })}>Check the DJ's settings</button>
          </div>
        </section>
      {:else if b.kind === "set"}
        {@const now = b.set.id === dj.current?.id}
        <div class="set-head">
          <h2 {@attach contextMenu(() => setMenu(b.set))}>
            {#key now}<span class="when" class:now in:rise={{ y: 6, duration: 300 }}>{now ? "Now" : "Up next"}:</span>{/key}
            {b.set.name}
          </h2>
          <span class="set-actions">
            {#if now && dj.canSkipSet(b.set)}
              <button class="btn quiet" title="Not feeling it? Go on to the next set." onclick={() => dj.skipSet()}>
                <Icon name="next" size={16} /> Skip this set
              </button>
            {/if}
            <button
              class="icon-btn"
              aria-haspopup="menu"
              aria-label="More for {b.set.name}"
              title="More for {b.set.name}"
              onclick={(e) => menu.showFor(e.currentTarget, setMenu(b.set))}
            >
              <Icon name="more" size={18} />
            </button>
          </span>
        </div>
        {#if b.set.request}<p class="muted small request-note">Your request: “{b.set.request}”</p>{/if}
        <DjSongs set={b.set} />
        {#if b.set.live}
          <p class="muted small live-note">Picked as you listen: like a song for more like it, or skip what isn't working.</p>
        {/if}
      {:else if b.kind === "said"}
        <h2>What your DJ said</h2>
        <ul class="said">
          {#each said as line, i (said.length - i)}
            <li class:live={i === 0 && (dj.speaking || dj.showing)} in:rise={{ y: -8, delay: 60 }} animate:settle={{ duration: 320 }}>
              <span class="segment">{line.name}</span>
              <p>{line.talk}</p>
              {#if !line.byModel}<span class="muted small">From a template: {line.why ?? "the model didn't answer in time"}.</span>{/if}
            </li>
          {/each}
        </ul>
      {:else}
        <h2>Tell your DJ</h2>
        <p class="muted small">
          How it should talk and what to play from your listening: a mood, a persona, things to avoid. It reads this
          every time it picks songs, so changes apply from its next set.
        </p>
        <textarea
          class="field"
          rows="4"
          maxlength={INSTRUCTIONS_MAX}
          placeholder={"Talk like a late-night radio host. Keep it short.\nNo explicit songs.\nMention the year a song came out."}
          value={dj.instructions}
          oninput={(e) => dj.setInstructions(e.currentTarget.value)}
        ></textarea>
        <span class="muted small count">{dj.instructions.length} / {INSTRUCTIONS_MAX}</span>
      {/if}
    </section>
  {/each}
</div>

<style>
  .page {
    /* A set lifting away is held in place against the page while the rest close up. */
    position: relative;
    display: grid;
    gap: 28px;
    max-width: 780px;
    padding: 20px var(--gutter) 48px;
  }
  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 18px;
  }
  h1 {
    font-family: var(--font-display);
    font-variation-settings: "wdth" 125;
    font-weight: 800;
    font-size: clamp(2.5rem, 4.6vw, 4rem);
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .lead {
    max-width: 62ch;
    margin-top: 10px;
    font-size: var(--t-lg);
  }
  .small {
    font-size: var(--t-sm);
  }
  section {
    display: grid;
    gap: 10px;
  }
  .card {
    padding: 18px 20px;
    border-radius: var(--panel-radius);
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .card p {
    max-width: 66ch;
  }
  /* What's wrong with the DJ's model or voice, until it's fixed. */
  .trouble {
    display: grid;
    gap: 10px;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 50%, var(--border));
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .start {
    justify-items: start;
  }
  .big {
    height: 44px;
    padding: 0 22px;
    font-size: var(--t-lg);
  }
  /* Each step of the DJ's work rises in, then breathes until the next. */
  .busy {
    animation:
      rise 300ms var(--ease-out) backwards,
      breathe 1.6s ease-in-out 300ms infinite;
  }
  @keyframes breathe {
    50% {
      opacity: 0.55;
    }
  }
  /* Only shown when checking takes a moment. */
  .checking {
    animation: fade-in 300ms ease-out 250ms backwards;
  }
  .step {
    display: grid;
    gap: 10px;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--text) 12%, transparent);
    overflow: hidden;
  }
  /* Scaled, not resized: each progress report glides into the next without laying out the page. */
  .bar div {
    width: 100%;
    height: 100%;
    background: var(--highlight);
    transform-origin: left;
    transition: transform 250ms linear;
  }
  .error {
    color: var(--danger);
  }
  .when.now {
    color: var(--highlight);
  }
  .live-note {
    padding: 0 10px;
  }
  .when {
    display: inline-block;
  }
  .set-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .set-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }
  .request-note {
    padding: 0 10px;
  }
  .ask {
    display: grid;
    gap: 6px;
    width: 100%;
    max-width: 520px;
    margin-top: 6px;
  }
  .ask-row {
    display: flex;
    gap: 8px;
  }
  .ask-row .field {
    flex: 1;
    min-width: 0;
  }
  .requested {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
  .said {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .said li {
    position: relative;
    display: grid;
    gap: 4px;
    padding: 12px 16px;
    border-radius: 10px;
    background: var(--surface);
  }
  /* The line on air is lit, and cools off once it's said. */
  .said li::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: color-mix(in srgb, var(--highlight) 8%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--highlight) 55%, var(--border));
    opacity: 0;
    pointer-events: none;
    transition: opacity 1200ms var(--ease-out);
  }
  .said li.live::after {
    opacity: 1;
    transition-duration: 200ms;
  }
  .said p {
    font-size: var(--t-lg);
    line-height: 1.45;
  }
  .segment {
    color: var(--highlight);
    font-size: var(--t-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  textarea {
    width: 100%;
    height: auto;
    padding: 10px 12px;
    color: inherit;
    resize: vertical;
    font: inherit;
    font-size: var(--t-md);
    user-select: text;
  }
  .count {
    justify-self: end;
  }
</style>
