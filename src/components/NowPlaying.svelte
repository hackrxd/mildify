<script lang="ts">
  import { coverColor } from "../lib/color";
  import { liked } from "../lib/liked.svelte";
  import { player } from "../lib/player.svelte";
  import { router } from "../lib/router.svelte";
  import { formatDuration } from "../lib/util";
  import DevicePicker from "./DevicePicker.svelte";
  import Icon from "./Icon.svelte";
  import Slider from "./Slider.svelte";

  let { queueOpen, ontogglequeue }: { queueOpen: boolean; ontogglequeue: () => void } = $props();

  const track = $derived(player.track);
  let ambient = $state<string | null>(null);
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

<footer class="deck" style:--deck-ambient={ambient ?? "transparent"}>
  <div class="info">
    {#if track}
      <button class="cover" onclick={() => track.album.uri && router.openUri(track.album.uri)} title={track.album.name}>
        {#if track.cover}<img src={track.cover} alt="" />{/if}
      </button>
      <div class="text">
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
          <Icon name="heart" filled={saved} />
        </button>
      {/if}
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
        <Icon name={player.isPlaying ? "pause" : "play"} size={18} />
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
      linear-gradient(90deg, color-mix(in srgb, var(--deck-ambient) 55%, transparent), transparent 55%),
      var(--panel);
    transition: background 600ms;
  }
  /* The one glowing edge: the colour of what's playing, bleeding into the room. */
  .deck::before {
    content: "";
    position: absolute;
    inset: -1px 0 auto 0;
    height: 1px;
    background: linear-gradient(90deg, var(--deck-ambient), transparent 70%);
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
    border-radius: 4px;
    overflow: hidden;
    background: var(--raised);
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
    gap: 14px;
  }
  .play {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--paper);
    color: var(--graphite);
    transition: transform 100ms;
  }
  .play:hover {
    transform: scale(1.06);
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
