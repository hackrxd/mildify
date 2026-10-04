<script lang="ts">
  import { audioFx } from "../lib/audiofx.svelte";
  import { coverColor } from "../lib/color";
  import { liked } from "../lib/liked.svelte";
  import { rise } from "../lib/motion";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";
  import { formatDuration } from "../lib/util";
  import DeckLyric from "./DeckLyric.svelte";
  import DevicePicker from "./DevicePicker.svelte";
  import Icon from "./Icon.svelte";
  import Pop from "./Pop.svelte";
  import Slider from "./Slider.svelte";

  let { queueOpen, ontogglequeue }: { queueOpen: boolean; ontogglequeue: () => void } = $props();

  const track = $derived(player.track);
  let ambient = $state<string | null>(null);
  let deck: HTMLElement | undefined = $state();
  let seekPreview = $state<number | null>(null);
  let volumeBeforeMute = 50;

  $effect(() => {
    const url = track?.cover;
    coverColor(url).then((c) => {
      if (url === player.track?.cover) ambient = c;
    });
  });

  $effect(() => {
    if (track?.uri) liked.ensure([track.uri]);
  });

  // Audio-responsive Effects: the cover's glow pulses with the music.
  $effect(() => {
    const el = deck;
    if (el && audioFx.on) return audioFx.attach(() => el);
  });

  const saved = $derived(track ? liked.has(track.uri) : undefined);
  const volumeIcon = $derived(player.volume === 0 ? "volumeOff" : player.volume < 50 ? "volumeLow" : "volume");

  function toggleMute() {
    if (player.volume > 0) {
      volumeBeforeMute = player.volume;
      player.setVolume(0);
    } else {
      player.setVolume(volumeBeforeMute || 50);
    }
  }
</script>

<footer class="deck" bind:this={deck} style:--deck-ambient={ambient ?? "transparent"}>
  {#if audioFx.on}<div class="flare" aria-hidden="true"><div></div></div>{/if}
  <div class="info">
    {#if track}
      <!-- A new track's cover and title rise into place; the heart only pops when you toggle it. -->
      {#key track.uri}
        <button class="cover" in:rise={{ scale: 0.9 }} onclick={() => track.album.uri && router.openUri(track.album.uri)} title={track.album.name}>
          {#if track.cover}<img src={track.cover} alt="" />{/if}
        </button>
        <div class="text" in:rise={{ y: 6, delay: 60 }}>
          <div class="title-row">
            <button class="title link" onclick={() => track.album.uri && router.openUri(track.album.uri)}>{track.name}</button>
            {#if track.explicit}<span class="explicit" title="Explicit">E</span>{/if}
          </div>
          <div class="artists muted">
            {#each track.artists as a, i (a.uri + i)}
              {#if i > 0},&nbsp;{/if}<button class="link" onclick={() => a.uri && router.openUri(a.uri)}>{a.name}</button>
            {/each}
          </div>
        </div>
        {#if saved !== undefined}
          <button class="icon-btn" class:on={saved} onclick={() => liked.toggle(track.uri)} title={saved ? "Remove from Liked Songs" : "Save to Liked Songs"}>
            <Pop key={saved}><Icon name="heart" filled={saved} /></Pop>
          </button>
        {/if}
      {/key}
      <DeckLyric />
    {:else}
      <p class="idle muted">Pick something to play.</p>
    {/if}
  </div>

  <div class="transport">
    <div class="buttons">
      <button class="icon-btn" class:on={player.shuffle} onclick={() => player.toggleShuffle()} title="Shuffle" aria-pressed={player.shuffle}>
        <Icon name="shuffle" size={18} />
      </button>
      <button class="icon-btn" onclick={() => player.prev()} title="Previous">
        <Icon name="prev" size={18} />
      </button>
      <button class="play" onclick={() => player.togglePlay()} title={player.isPlaying ? "Pause" : "Play"}>
        <Pop key={player.isPlaying}><Icon name={player.isPlaying ? "pause" : "play"} size={18} /></Pop>
      </button>
      <button class="icon-btn" onclick={() => player.next()} title="Next">
        <Icon name="next" size={18} />
      </button>
      <button
        class="icon-btn"
        class:on={player.repeat !== "off"}
        onclick={() => player.cycleRepeat()}
        title={player.repeat === "track" ? "Repeat one" : player.repeat === "context" ? "Repeat all" : "Repeat off"}
      >
        <Icon name={player.repeat === "track" ? "repeatOne" : "repeat"} size={18} />
      </button>
    </div>
    <div class="progress">
      <span class="time num">{formatDuration(seekPreview ?? player.position)}</span>
      <Slider
        label="Seek"
        value={player.position}
        max={track?.durationMs ?? 0}
        step={5000}
        disabled={!track || !player.deviceId}
        onpreview={(v) => (seekPreview = v)}
        oncommit={(v) => player.seek(v)}
      />
      <span class="time num">{formatDuration(track?.durationMs ?? 0)}</span>
    </div>
  </div>

  <div class="extras">
    {#if player.deviceId && !player.isLocal}
      <span class="remote" title="Playing on another device">
        <Icon name="speaker" size={14} />{player.deviceName}
      </span>
    {/if}
    <button
      class="icon-btn"
      class:on={router.current.name === "lyrics"}
      onclick={() => (router.current.name === "lyrics" ? router.back() : router.go({ name: "lyrics" }))}
      title="Lyrics"
      aria-pressed={router.current.name === "lyrics"}
    >
      <Icon name="lyrics" size={18} />
    </button>
    <button class="icon-btn" class:on={queueOpen} onclick={ontogglequeue} title="Queue" aria-pressed={queueOpen}>
      <Icon name="queue" size={18} />
    </button>
    <DevicePicker />
    <button class="icon-btn" onclick={toggleMute} title={player.volume === 0 ? "Unmute" : "Mute"} disabled={!player.supportsVolume}>
      <Icon name={volumeIcon} size={18} />
    </button>
    <div class="volume">
      <Slider
        label="Volume"
        value={player.volume}
        max={100}
        step={5}
        disabled={!player.supportsVolume}
        onpreview={(v) => v !== null && player.setVolume(v)}
        oncommit={(v) => player.setVolume(v)}
      />
    </div>
  </div>
</footer>

<style>
  .deck {
    position: relative;
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(320px, 1.6fr) minmax(180px, 1fr);
    align-items: center;
    gap: 24px;
    height: var(--deck-h);
    padding: 0 20px 0 14px;
    background:
      radial-gradient(90% 160% at 0% 100%, color-mix(in srgb, var(--deck-ambient) var(--deck-glow), transparent), transparent 60%),
      var(--frame);
    /* The glow and colour follow the lyrics view's cover background in and out. */
    transition:
      --deck-ambient 900ms ease,
      --deck-glow var(--backdrop-fade, 0ms) var(--ease-out),
      background-color var(--backdrop-fade, 0ms) var(--ease-out);
  }
  /* The one glowing edge: the colour of what's playing, bleeding into the room. */
  .deck::before {
    content: "";
    position: absolute;
    inset: 0 auto auto var(--seam);
    width: 60%;
    height: 1px;
    background: linear-gradient(90deg, var(--deck-ambient), transparent);
    opacity: calc(0.8 + var(--audio-pulse, 0) * 0.2);
    transform-origin: left;
    scale: calc(1 + var(--audio-pulse, 0) * 0.6) 1;
  }
  /* Above the flare. */
  .deck > :not(.flare) {
    position: relative;
  }

  /* Audio-responsive Effects: a brighter, wider copy of the glow that flares up with each hit
     (--audio-pulse, 0-1, set every frame by audioFx). Only its opacity and scale change, which
     the compositor animates without repainting. */
  .flare {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .flare > div {
    position: absolute;
    inset: 0;
    background: radial-gradient(
      80% 240% at 0% 100%,
      color-mix(in srgb, color-mix(in oklab, var(--deck-ambient), white 35%) calc(var(--deck-glow) * 1.7), transparent),
      transparent 70%
    );
    transform-origin: 0% 100%;
    opacity: var(--audio-pulse, 0);
    scale: calc(1 + var(--audio-pulse, 0) * 0.35);
    will-change: opacity, scale;
  }

  .info {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .cover {
    flex: none;
    width: 60px;
    height: 60px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--raised);
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.45);
    transition: transform 140ms;
  }
  .cover:hover {
    transform: scale(1.04);
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .text {
    min-width: 0;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .title {
    font-size: var(--t-md);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
  .artists {
    font-size: var(--t-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .idle {
    font-size: var(--t-sm);
  }

  .transport {
    display: grid;
    gap: 4px;
    justify-items: center;
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .play {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--paper);
    color: var(--graphite);
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.35);
    transition: transform 100ms, background 120ms;
  }
  .play:hover {
    transform: scale(1.06);
    background: #fff;
  }
  .play:active {
    transform: scale(0.96);
  }
  /* Toggles that are on get a lit dot underneath, like a switched-on channel. */
  .buttons :global(.icon-btn.on),
  .extras :global(.icon-btn.on) {
    position: relative;
  }
  .buttons :global(.icon-btn.on)::after,
  .extras :global(.icon-btn.on)::after {
    content: "";
    position: absolute;
    left: 50%;
    bottom: 0;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--brass);
    transform: translateX(-50%);
  }

  .progress {
    display: grid;
    grid-template-columns: 44px 1fr 44px;
    align-items: center;
    gap: 8px;
    width: 100%;
    max-width: 640px;
  }
  .time {
    font-size: var(--t-xs);
    color: var(--smoke);
  }
  .time:first-child {
    text-align: right;
  }

  .extras {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    min-width: 0;
  }
  .remote {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-right: 6px;
    font-size: var(--t-xs);
    font-weight: 600;
    color: var(--brass);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .volume {
    width: 110px;
    flex: none;
  }
</style>
