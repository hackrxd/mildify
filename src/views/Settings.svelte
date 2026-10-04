<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { audioFx, INTENSITY_MAX, INTENSITY_MIN, INTENSITY_STEP } from "../lib/audiofx.svelte";
  import { lyrics, TEXT_SCALE_MAX, TEXT_SCALE_MIN, TEXT_SCALE_STEP, WARMUP_MAX } from "../lib/lyrics.svelte";
  import { mods } from "../lib/mods.svelte";
  import { session } from "../lib/session.svelte";
  import { updater } from "../lib/updater.svelte";
  import { whatsNew } from "../lib/whatsnew.svelte";
  import { plural } from "../lib/util";
  import { builtinThemes } from "../themes";

  const config = $derived(session.status?.config);
  const device = $derived(session.device);
  const devtools = $derived(session.status?.devtools);

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

  function saveWarmup(e: Event & { currentTarget: HTMLInputElement }) {
    const input = e.currentTarget;
    const n = Number(input.value);
    if (input.value.trim() !== "" && Number.isFinite(n)) lyrics.setWarmup(n);
    // Show what was kept: clamped, rounded, or the old value for nonsense.
    input.value = String(lyrics.warmup);
  }

  const MODS_GUIDE = "https://github.com/hackrxd/mildify/blob/main/docs/mods.md";

  // Pick up files added since the app started.
  mods.refresh();
  const themes = $derived(mods.list?.themes ?? []);
  const extensions = $derived(mods.list?.extensions ?? []);
  const needsReload = $derived(Object.values(mods.states).includes("restart"));

  const scales = Array.from(
    { length: Math.round((TEXT_SCALE_MAX - TEXT_SCALE_MIN) / TEXT_SCALE_STEP) + 1 },
    (_, i) => Math.round((TEXT_SCALE_MIN + i * TEXT_SCALE_STEP) * 100) / 100,
  );

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

    <label class="row">
      <span>
        <span class="label">Load lyrics ahead</span>
        <span class="muted small">
          How many songs coming up in the queue to fetch lyrics for, so they show up right away. 0 turns it off;
          up to {WARMUP_MAX}. Each song's lyrics are fetched fresh every time it plays.
        </span>
      </span>
      <span class="count">
        <input
          class="field"
          type="number"
          min="0"
          max={WARMUP_MAX}
          step="1"
          inputmode="numeric"
          value={lyrics.warmup}
          onchange={saveWarmup}
          onkeydown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span class="muted small">songs</span>
      </span>
    </label>

    <div class="row">
      <span>
        <span class="label">Per-song timing</span>
        <span class="muted small">
          {#if lyrics.songOffsetCount === 0}None yet. If one song's sync is off, nudge it from the lyrics view with
            the options button or the [ and ] keys.
          {:else}{plural(lyrics.songOffsetCount, "song")} {lyrics.songOffsetCount === 1 ? "has its" : "have their"} own
            timing, on top of Lyrics timing.{/if}
        </span>
      </span>
      <button class="btn quiet" type="button" disabled={lyrics.songOffsetCount === 0} onclick={() => lyrics.forgetSongOffsets()}>
        Reset all
      </button>
    </div>

    <label class="row">
      <span>
        <span class="label">Lyrics text size</span>
        <span class="muted small">How big the lyrics view writes them. Ctrl + and Ctrl − change it there too.</span>
      </span>
      <select class="field narrow" value={lyrics.textScale} onchange={(e) => lyrics.setTextScale(Number(e.currentTarget.value))}>
        {#each scales as scale (scale)}
          <option value={scale}>{Math.round(scale * 100)}%{scale === 1 ? " (default)" : ""}</option>
        {/each}
      </select>
    </label>

    <label class="row">
      <span>
        <span class="label">Cover background behind everything</span>
        <span class="muted small">In the lyrics view, the moving cover art fills the whole window, not just the lyrics.</span>
      </span>
      <input type="checkbox" class="switch" checked={lyrics.backdrop} onchange={(e) => lyrics.setBackdrop(e.currentTarget.checked)} />
    </label>

    <label class="row">
      <span>
        <span class="label">Dim it under the panels</span>
        <span class="muted small">The sidebar, top bar, player bar and queue darken the background a little. Off, they're see-through.</span>
      </span>
      <input
        type="checkbox"
        class="switch"
        checked={lyrics.backdropDim}
        disabled={!lyrics.backdrop}
        onchange={(e) => lyrics.setBackdropDim(e.currentTarget.checked)}
      />
    </label>

    <label class="row">
      <span>
        <span class="label">Audio-responsive Effects</span>
        <span class="muted small">The glow from the cover in the player bar pulses with the beat. Only for music playing on this computer.</span>
      </span>
      <input type="checkbox" class="switch" checked={audioFx.on} onchange={(e) => audioFx.setOn(e.currentTarget.checked)} />
    </label>

    <label class="row">
      <span>
        <span class="label">Effect intensity</span>
        <span class="muted small">How strongly the glow pulses: {Math.round(audioFx.intensity * 100)}%.</span>
      </span>
      <span class="timing">
        <span class="muted small">Subtle</span>
        <input
          type="range"
          min={INTENSITY_MIN}
          max={INTENSITY_MAX}
          step={INTENSITY_STEP}
          value={audioFx.intensity}
          disabled={!audioFx.on}
          oninput={(e) => audioFx.setIntensity(Number(e.currentTarget.value))}
          aria-label="Audio-responsive effect intensity"
        />
        <span class="muted small">Strong</span>
        <button
          class="btn quiet"
          class:hidden={audioFx.intensity === 1}
          type="button"
          disabled={audioFx.intensity === 1}
          onclick={() => audioFx.setIntensity(1)}>Reset</button
        >
      </span>
    </label>

    <label class="row">
      <span>
        <span class="label">Let Mild Lyrics follow playback</span>
        <span class="muted small">
          {#if devtools?.error}{devtools.error}
          {:else if devtools?.port}Mild Lyrics can see what's playing and control it on port {devtools.port}, as with
            Spotify started with its debug port.
          {:else}Answers Mild Lyrics on port 9222, where it looks for Spotify. It can see what's playing and control
            playback, nothing else.{/if}
        </span>
      </span>
      <input
        type="checkbox"
        class="switch"
        checked={config?.devtools}
        onchange={(e) => session.saveSettings({ devtools: e.currentTarget.checked })}
      />
    </label>
  </section>

  <section>
    <h2>Themes and extensions</h2>

    {#if mods.safeMode}
      <div class="status">
        <span class="dot state-error"></span>
        <div><p>Safe mode: no theme, Quick CSS or extension is loaded. Start the app normally to bring them back.</p></div>
      </div>
    {/if}

    <label class="row">
      <span>
        <span class="label">Theme</span>
        <span class="muted small">
          {#if mods.activeTheme}
            {mods.activeTheme.description ?? "A theme from your themes folder."}
            {#if mods.activeTheme.author}{" "}By {mods.activeTheme.author}.{/if}
          {:else}
            Built-in themes, or CSS files in your themes folder. Edits show up when you switch back to the app.
          {/if}
        </span>
      </span>
      <select class="field" value={mods.theme ?? ""} onchange={(e) => mods.setTheme(e.currentTarget.value || null)}>
        <option value="">Default</option>
        <optgroup label="Built in">
          {#each builtinThemes as theme (theme.id)}
            <option value={theme.id}>{theme.name}</option>
          {/each}
        </optgroup>
        {#if themes.length}
          <optgroup label="Your themes">
            {#each themes as theme (theme.id)}
              <option value={theme.id}>{theme.name}</option>
            {/each}
          </optgroup>
        {/if}
        {#if mods.theme && !mods.activeTheme}
          <option value={mods.theme} disabled>{mods.theme} (missing)</option>
        {/if}
      </select>
    </label>

    <label class="row stacked">
      <span>
        <span class="label">Quick CSS</span>
        <span class="muted small">Small tweaks on top of the theme, applied as you type.</span>
      </span>
      <textarea
        class="field code"
        rows="5"
        spellcheck="false"
        placeholder={":root {\n  --brass: #7aa2f7;\n}"}
        value={mods.quickCss}
        oninput={(e) => mods.setQuickCss(e.currentTarget.value)}
      ></textarea>
    </label>

    {#each extensions as ext (ext.id)}
      {@const state = mods.states[ext.id] ?? "off"}
      <label class="row">
        <span>
          <span class="label">{ext.name}{#if ext.version}<span class="muted small version">{ext.version}</span>{/if}</span>
          {#if ext.description || ext.author}
            <span class="muted small">{ext.description ?? ""}{#if ext.author}{" "}By {ext.author}.{/if}</span>
          {/if}
          {#if state === "error"}
            <span class="small error">Couldn't start: {mods.errors[ext.id]}</span>
          {:else if state === "restart"}
            <span class="small">Still active until the window reloads.</span>
          {/if}
        </span>
        <input
          type="checkbox"
          class="switch"
          checked={mods.isEnabled(ext.id)}
          disabled={mods.safeMode}
          onchange={(e) => mods.setEnabled(ext.id, e.currentTarget.checked)}
        />
      </label>
    {:else}
      <div class="row">
        <span>
          <span class="label">No extensions yet</span>
          <span class="muted small">Put .js files (or folders with an index.js) in your extensions folder.</span>
        </span>
      </div>
    {/each}

    <div class="row">
      <span class="muted small">
        Extensions run with full access to the app and your Spotify account. Only turn on ones you trust.
        <button class="link" onclick={() => openUrl(MODS_GUIDE).catch(() => {})}>How to make themes and extensions</button>
      </span>
    </div>
    <div class="actions">
      <button class="btn quiet" onclick={() => mods.openFolder("themes")}>Themes folder</button>
      <button class="btn quiet" onclick={() => mods.openFolder("extensions")}>Extensions folder</button>
      <button class="btn quiet" onclick={() => mods.refresh(true)}><Icon name="refresh" size={16} /> Reload</button>
      {#if needsReload}
        <button class="btn primary" onclick={() => location.reload()}>Reload window</button>
      {/if}
    </div>
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
        <span class="label">
          Mildify {updater.current}{updater.app && updater.app !== updater.current ? ` (app ${updater.app})` : ""}
        </span>
        <span class="muted small">
          {#if import.meta.env.DEV}Development builds don't update themselves.
          {:else if updater.state === "checking"}Checking for updates…
          {:else if updater.state === "up_to_date"}You're on the latest version.
          {:else if updater.state === "downloading"}Downloading {updater.available}{updater.progress === null ? "…" : ` (${Math.round(updater.progress * 100)}%)`}
          {:else if (updater.state === "ready" || updater.state === "installing") && updater.needsRestart}Version {updater.available} is downloaded. Installing it restarts Mildify, which stops your music.
          {:else if updater.state === "ready" || updater.state === "installing"}Version {updater.available} is downloaded. Reloading applies it without stopping your music.
          {:else if updater.state === "error"}Couldn't check for updates: {updater.error}
          {:else}Updates download in the background. Most apply with a reload and the music keeps playing; ones that change the app itself need a restart, which stops it.{/if}
        </span>
      </span>
      <span class="buttons">
        <button class="btn quiet" onclick={() => whatsNew.open()}>What's new</button>
        {#if updater.state === "ready" || updater.state === "installing"}
          <button class="btn primary" onclick={() => updater.apply()} disabled={updater.state === "installing"}>
            {#if updater.needsRestart}{updater.state === "installing" ? "Installing…" : "Restart and stop music"}
            {:else}{updater.state === "installing" ? "Reloading…" : "Reload now"}{/if}
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
      </span>
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
    border-radius: 10px;
    background: var(--panel);
    box-shadow: inset 0 0 0 1px var(--line);
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
  .count {
    display: flex !important;
    align-items: center;
    gap: 10px;
  }
  .row .count .field {
    width: 80px;
  }
  select.field {
    appearance: auto;
  }
  .row .field.narrow {
    width: 160px;
  }
  .switch {
    /* Checkboxes drawn as toggle switches. */
    appearance: none;
    position: relative;
    flex: none;
    width: 40px;
    height: 22px;
    margin: 0;
    border-radius: 11px;
    background: color-mix(in srgb, var(--paper) 18%, transparent);
    cursor: pointer;
    transition: background 160ms;
  }
  .switch::before {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--paper);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
    transition: transform 160ms;
  }
  .switch:checked {
    background: var(--brass);
  }
  .switch:checked::before {
    transform: translateX(18px);
    background: var(--brass-ink);
  }
  .switch:disabled {
    cursor: default;
    opacity: 0.4;
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
  .stacked {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .row .code {
    width: 100%;
    height: auto;
    padding: 10px 12px;
    color: inherit;
    resize: vertical;
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, monospace;
    font-size: var(--t-sm);
    user-select: text;
  }
  .version {
    margin-left: 8px;
    font-weight: 400;
  }
  .error {
    color: var(--danger);
  }
  .link {
    display: block;
    margin-top: 4px;
    padding: 0;
    color: var(--brass);
    font-size: inherit;
  }
  .link:hover {
    text-decoration: underline;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 12px;
  }
  .buttons {
    display: flex;
    flex: none;
    gap: 8px;
  }
  .about p {
    max-width: 70ch;
  }
</style>
