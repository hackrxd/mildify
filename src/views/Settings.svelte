<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import { lyrics } from "../lib/lyrics.svelte";
  import { session } from "../lib/session.svelte";
  import { updater } from "../lib/updater.svelte";

  const config = $derived(session.status?.config);
  const device = $derived(session.device);

  let deviceName = $state(session.status?.config.device_name ?? "");

  const stateText: Record<string, string> = {
    offline: "Stopped",
    needs_login: "Needs you to sign in",
    connecting: "Connecting to Spotify…",
    ready: "Ready. It shows up in every Spotify app as a speaker.",
    premium_required: "Playing music here needs Spotify Premium. You can still browse your library.",
    error: "Couldn't connect. Retrying automatically.",
  };

  let lyricsUser = $state("");
  let lyricsPassword = $state("");
  let lyricsBusy = $state(false);

  lyrics.refreshServer();
  const server = $derived(lyrics.server);

  async function lyricsSignIn(e: SubmitEvent) {
    e.preventDefault();
    lyricsBusy = true;
    if (await lyrics.signIn(lyricsUser, lyricsPassword)) lyricsUser = "";
    lyricsPassword = "";
    lyricsBusy = false;
  }

  function saveName() {
    const name = deviceName.trim();
    if (name && name !== config?.device_name) session.saveSettings({ device_name: name });
  }
</script>

<div class="page">
  <h1>Settings</h1>

  <section>
    <h2>Built-in player</h2>
    <div class="status">
      <span class="dot state-{device?.state}"></span>
      <div>
        <p>{stateText[device?.state ?? "offline"]}</p>
        {#if device?.error}<p class="muted small">{device.error}</p>{/if}
      </div>
      {#if device?.state === "needs_login"}
        <button class="btn primary" onclick={() => session.signIn()} disabled={session.signingIn}>
          {session.signingIn ? "Waiting for your browser…" : "Sign in for playback"}
        </button>
      {:else}
        <button class="btn quiet" onclick={() => session.restartDevice()}>
          <Icon name="refresh" size={16} /> Restart player
        </button>
      {/if}
    </div>

    <label class="row">
      <span>
        <span class="label">Speaker name</span>
        <span class="muted small">What this computer is called in Spotify's device list.</span>
      </span>
      <input class="field" bind:value={deviceName} onblur={saveName} onkeydown={(e) => e.key === "Enter" && saveName()} />
    </label>

    <label class="row">
      <span>
        <span class="label">Audio quality</span>
        <span class="muted small">Higher quality uses more data. Changing it restarts the player.</span>
      </span>
      <select class="field" value={config?.bitrate} onchange={(e) => session.saveSettings({ bitrate: Number(e.currentTarget.value) })}>
        <option value={96}>Low (96 kbps)</option>
        <option value={160}>Normal (160 kbps)</option>
        <option value={320}>Very high (320 kbps)</option>
      </select>
    </label>

    <label class="row">
      <span>
        <span class="label">Normalize volume</span>
        <span class="muted small">Play every song at a similar loudness.</span>
      </span>
      <input
        type="checkbox"
        class="switch"
        checked={config?.normalisation}
        onchange={(e) => session.saveSettings({ normalisation: e.currentTarget.checked })}
      />
    </label>
  </section>

  <section>
    <h2>Lyrics</h2>

    <div class="row">
      <span>
        {#if !server}
          <span class="label">Checking the lyrics service…</span>
        {:else if !server.reachable}
          <span class="label">Can't reach the lyrics service</span>
          <span class="muted small">{server.error}</span>
        {:else if server.username}
          <span class="label">Signed in as {server.username}</span>
          <span class="muted small">{server.url.replace("https://", "")}</span>
        {:else if server.auth_required}
          <span class="label">Sign in to see lyrics</span>
          <span class="muted small">Use the account you were given for {server.url.replace("https://", "")}.</span>
        {:else}
          <span class="label">Connected</span>
          <span class="muted small">{server.url.replace("https://", "")}, no sign-in needed</span>
        {/if}
      </span>
      {#if server?.username}
        <button class="btn quiet" onclick={() => lyrics.signOut()}><Icon name="signOut" size={16} /> Sign out</button>
      {:else}
        <button class="btn quiet" onclick={() => lyrics.refreshServer()}><Icon name="refresh" size={16} /> Check again</button>
      {/if}
    </div>
    <label class="row">
      <span>
        <span class="label">Lyrics timing</span>
        <span class="muted small">
          {#if lyrics.offsetMs === 0}In step with the audio. Nudge it if your headphones add delay.
          {:else}{Math.abs(lyrics.offsetMs)} ms {lyrics.offsetMs > 0 ? "later" : "earlier"} than the audio clock.{/if}
        </span>
      </span>
      <span class="timing">
        <span class="muted small">Earlier</span>
        <input
          type="range"
          min="-1000"
          max="1000"
          step="25"
          value={lyrics.offsetMs}
          oninput={(e) => lyrics.setOffset(Number(e.currentTarget.value))}
          aria-label="Lyrics timing offset in milliseconds"
        />
        <span class="muted small">Later</span>
        <!-- Always laid out: appearing mid-drag would shift the slider under the pointer. -->
        <button
          class="btn quiet"
          class:hidden={lyrics.offsetMs === 0}
          type="button"
          disabled={lyrics.offsetMs === 0}
          onclick={() => lyrics.setOffset(0)}>Reset</button
        >
      </span>
    </label>

    {#if server?.reachable && server.auth_required && !server.username}
      <form class="row login" onsubmit={lyricsSignIn}>
        <input class="field" placeholder="Username" autocomplete="username" bind:value={lyricsUser} required />
        <input class="field" type="password" placeholder="Password" autocomplete="current-password" bind:value={lyricsPassword} required />
        <button class="btn primary" type="submit" disabled={lyricsBusy}>{lyricsBusy ? "Signing in…" : "Sign in"}</button>
      </form>
    {/if}

    <label class="row">
      <span>
        <span class="label">Lyrics in the player bar</span>
        <span class="muted small">The current line, next to the song title, when the window is wide enough.</span>
      </span>
      <input type="checkbox" class="switch" checked={lyrics.inDeck} onchange={(e) => lyrics.setInDeck(e.currentTarget.checked)} />
    </label>
  </section>

  <section>
    <h2>Account</h2>
    <div class="row">
      <span>
        <span class="label">{session.user?.display_name ?? session.user?.id ?? "Signed in"}</span>
        <span class="muted small">Developer app Client ID {config?.client_id}</span>
      </span>
      <button class="btn quiet" onclick={() => session.signOut()}>
        <Icon name="signOut" size={16} /> Sign out
      </button>
    </div>
  </section>

  <section>
    <h2>Updates</h2>
    <div class="row">
      <span>
        <span class="label">Native Spotify {updater.current}</span>
        <span class="muted small">
          {#if import.meta.env.DEV}Development builds don't update themselves.
          {:else if updater.state === "checking"}Checking for updates…
          {:else if updater.state === "up_to_date"}You're on the latest version.
          {:else if updater.state === "downloading"}Downloading {updater.available}{updater.progress === null ? "…" : ` (${Math.round(updater.progress * 100)}%)`}
          {:else if updater.state === "ready" || updater.state === "installing"}Version {updater.available} is downloaded and ready.
          {:else if updater.state === "error"}Couldn't check for updates: {updater.error}
          {:else}Updates download in the background and install when you restart.{/if}
        </span>
      </span>
      {#if updater.state === "ready" || updater.state === "installing"}
        <button class="btn primary" onclick={() => updater.restart()} disabled={updater.state === "installing"}>
          {updater.state === "installing" ? "Installing…" : "Restart now"}
        </button>
      {:else}
        <button
          class="btn quiet"
          onclick={() => updater.check()}
          disabled={import.meta.env.DEV || updater.state === "checking" || updater.state === "downloading"}
        >
          <Icon name="refresh" size={16} /> Check for updates
        </button>
      {/if}
    </div>
  </section>

  <section class="about muted small">
    <p>
      Browsing uses the Spotify Web API through your developer app. Development-mode apps are limited to 5 users,
      10 search results per category, and can't read the track lists of playlists you don't own.
      Playback runs on this computer through librespot as a Spotify Connect speaker.
    </p>
  </section>
</div>

<style>
  .page {
    display: grid;
    gap: 36px;
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
  section {
    display: grid;
    gap: 4px;
  }
  section h2 {
    margin-bottom: 10px;
  }
  .small {
    font-size: var(--t-sm);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    margin-bottom: 8px;
    border-radius: 8px;
    background: var(--panel);
    font-size: var(--t-md);
  }
  .status > div {
    flex: 1;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
    background: var(--smoke);
  }
  .dot.state-ready {
    background: var(--brass);
    box-shadow: 0 0 10px var(--brass);
  }
  .dot.state-error,
  .dot.state-needs_login,
  .dot.state-premium_required {
    background: var(--danger);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
    font-size: var(--t-md);
  }
  .row > span {
    display: grid;
    gap: 2px;
  }
  .label {
    font-weight: 600;
  }
  .row .field {
    width: 260px;
    flex: none;
  }
  select.field {
    appearance: auto;
  }
  .switch {
    width: 18px;
    height: 18px;
    accent-color: var(--brass);
  }
  .timing {
    display: flex !important;
    align-items: center;
    gap: 10px;
  }
  .timing input {
    width: 200px;
    accent-color: var(--brass);
  }
  .timing .hidden {
    visibility: hidden;
  }
  .login {
    justify-content: flex-start;
  }
  .login .field {
    width: 200px;
  }
  .about p {
    max-width: 70ch;
  }
</style>
