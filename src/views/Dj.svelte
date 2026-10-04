<script lang="ts">
  import Equalizer from "../components/Equalizer.svelte";
  import Icon from "../components/Icon.svelte";
  import { dj } from "../lib/dj.svelte";
  import { INSTRUCTIONS_MAX } from "../lib/djPicks";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";
  import { formatBytes, lowerFirst } from "../lib/util";

  dj.refresh();

  const status = $derived(dj.status);
  const install = $derived(status?.install);
  const missing = $derived(status?.needed.filter((n) => !n.installed) ?? []);
  const toDownload = $derived(missing.reduce((n, c) => n + c.bytes, 0));
  const share = $derived(install?.running && install.total ? Math.min(1, install.received / install.total) : null);
  const said = $derived([...dj.said].reverse());
</script>

{#snippet songs(list: { uri: string; name: string; artists: string[] }[])}
  <ol class="songs">
    {#each list as s (s.uri)}
      {@const playing = player.track?.uri === s.uri}
      <li class:playing>
        <span class="mark">{#if playing && player.isPlaying}<Equalizer label="Playing" />{/if}</span>
        <span class="name">{s.name}</span>
        <span class="muted">{s.artists.join(", ")}</span>
      </li>
    {/each}
  </ol>
{/snippet}

<div class="page">
  <header>
    <h1>DJ</h1>
    <p class="muted lead">
      Your own radio DJ, running on this computer. It plays songs from your listening and talks between them, in a
      voice made here rather than in the cloud.
    </p>
  </header>

  {#if !status}
    <p class="muted">Checking on your DJ…</p>
  {:else if !status.supported}
    <section class="card">
      <p>The DJ can't run on this computer: its model and voice aren't built for this kind of processor.</p>
    </section>
  {:else if !dj.enabled}
    <section class="card">
      <p>
        The DJ is off. Turning it on downloads what it runs on, about {formatBytes(toDownload)}: a language model, a
        voice and the programs for them. Nothing is downloaded until then, and you can remove it all again in
        Settings.
      </p>
      <div class="actions">
        <button class="btn primary" onclick={() => dj.setEnabled(true)}><Icon name="dj" size={18} /> Turn on the DJ</button>
        <button class="btn quiet" onclick={() => router.go({ name: "settings" })}>Choose a model and voice</button>
      </div>
    </section>
  {:else if missing.length}
    <section class="card">
      {#if install?.running}
        <p>Downloading {lowerFirst(install.component ?? "your DJ")}…</p>
        <div class="bar" role="progressbar" aria-valuenow={share === null ? undefined : Math.round(share * 100)}>
          <div style:width="{(share ?? 0) * 100}%"></div>
        </div>
        <p class="muted small">
          {formatBytes(install.received)}{install.total ? ` of ${formatBytes(install.total)}` : ""}. {missing.length === 1
            ? "This is the last download."
            : `${missing.length} downloads left, ${formatBytes(toDownload)} in all.`} It keeps going if you leave this page.
        </p>
        <div class="actions"><button class="btn quiet" onclick={() => dj.cancelDownload()}>Pause download</button></div>
      {:else}
        {#if install?.error}<p class="error">{install.error}</p>{/if}
        <p class="muted">{formatBytes(toDownload)} left to download before the DJ can play.</p>
        <div class="actions"><button class="btn primary" onclick={() => dj.retry()}>Download</button></div>
      {/if}
    </section>
  {:else}
    <section class="card start">
      {#if dj.phase === "off"}
        <button class="btn primary big" onclick={() => dj.start()}><Icon name="play" size={18} /> Start the DJ</button>
        <p class="muted small">It plays on this computer, and talks over the ends and starts of songs, never over the singing.</p>
      {:else}
        <button class="btn quiet big" onclick={() => dj.stop()}><Icon name="close" size={18} /> Stop the DJ</button>
        {#if dj.activity}<p class="muted small busy">{dj.activity}</p>{/if}
      {/if}
    </section>

    {#if dj.current}
      <section>
        <h2>Now: {dj.current.name}</h2>
        {@render songs(dj.current.songs)}
      </section>
    {/if}
    {#if dj.upNext}
      <section>
        <h2>Up next: {dj.upNext.name}</h2>
        {@render songs(dj.upNext.songs)}
      </section>
    {/if}
    {#if said.length}
      <section>
        <h2>What your DJ said</h2>
        <ul class="said">
          {#each said as line, i (said.length - i)}
            <li>
              <span class="segment">{line.name}</span>
              <p>{line.talk}</p>
              {#if !line.byModel}<span class="muted small">From a template: the model didn't answer in time.</span>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}

  {#if status?.supported && dj.enabled}
    <section>
      <h2>Tell your DJ</h2>
      <p class="muted small">
        How it should talk and what to play from your listening: a mood, a persona, things to avoid. It reads this every
        time it picks songs, so changes apply from its next set.
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
    </section>
  {/if}
</div>

<style>
  .page {
    display: grid;
    gap: 28px;
    max-width: 780px;
    padding: 20px var(--gutter) 48px;
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
  .busy {
    animation: breathe 1.6s ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      opacity: 0.5;
    }
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--text) 12%, transparent);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--highlight);
    transition: width 250ms linear;
  }
  .error {
    color: var(--danger);
  }
  .songs {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .songs li {
    display: grid;
    grid-template-columns: 20px minmax(0, auto) minmax(0, 1fr);
    align-items: baseline;
    gap: 10px;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: var(--t-md);
  }
  .songs li > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .songs li.playing {
    background: color-mix(in srgb, var(--highlight) 10%, transparent);
  }
  .songs li.playing .name,
  .mark {
    color: var(--highlight);
  }
  .said {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .said li {
    display: grid;
    gap: 4px;
    padding: 12px 16px;
    border-radius: 10px;
    background: var(--surface);
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
