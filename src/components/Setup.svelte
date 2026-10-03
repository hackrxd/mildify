<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { session } from "../lib/session.svelte";
  import Icon from "./Icon.svelte";

  const status = $derived(session.status);
  let clientId = $state(session.status?.config.client_id ?? "");
  let copied = $state(false);

  const validId = $derived(/^[0-9a-f]{32}$/i.test(clientId.trim()));

  async function copyRedirect() {
    if (!status) return;
    await navigator.clipboard.writeText(status.redirect_uri);
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }

  async function connect() {
    if (clientId.trim() !== status?.config.client_id) {
      await session.saveSettings({ client_id: clientId.trim() });
    }
    await session.signIn();
  }
</script>

<div class="setup">
  <section class="intro">
    <h1>Your music, your client.</h1>
    <p class="muted">
      This app talks to Spotify through a developer app that you own, and plays audio on this computer
      as a Spotify Connect speaker. Setup takes about two minutes and needs a Premium account.
    </p>
  </section>

  <ol class="steps">
    <li>
      <h3>Create a Spotify developer app</h3>
      <p class="muted">Any name and description will do. Under "Which API/SDKs are you planning to use?", select Web API.</p>
      <button class="btn quiet" onclick={() => openUrl("https://developer.spotify.com/dashboard/create")}>
        Open Spotify Developer Dashboard
      </button>
    </li>

    <li>
      <h3>Add this redirect URI to the app</h3>
      <div class="copy-row">
        <code>{status?.redirect_uri}</code>
        <button class="btn quiet" onclick={copyRedirect}>
          {#if copied}<Icon name="check" size={16} /> Copied{:else}Copy{/if}
        </button>
      </div>
    </li>

    <li>
      <h3>Paste the app's Client ID</h3>
      <p class="muted">It's shown on the app's Basic Information page.</p>
      <input
        class="field num"
        placeholder="32-character Client ID"
        spellcheck="false"
        autocomplete="off"
        bind:value={clientId}
      />
    </li>

    <li>
      <h3>Sign in</h3>
      <p class="muted">
        Your browser opens twice: once to approve your developer app, then once to let this computer
        play your music.
      </p>
      {#if session.signingIn}
        <div class="waiting">
          <span class="pulse" aria-hidden="true"></span>
          <span>Waiting for your browser…</span>
          <button class="btn quiet" onclick={() => session.cancelSignIn()}>Cancel</button>
        </div>
      {:else}
        <button class="btn primary" disabled={!validId} onclick={connect}>Sign in with Spotify</button>
      {/if}
    </li>
  </ol>
</div>

<style>
  .setup {
    height: 100%;
    overflow: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
    gap: 64px;
    align-items: center;
    padding: 64px clamp(32px, 7vw, 112px);
    background:
      radial-gradient(60% 70% at 0% 100%, color-mix(in srgb, var(--brass) 14%, transparent), transparent 70%),
      var(--graphite);
  }

  h1 {
    font-family: var(--font-display);
    font-variation-settings: "wdth" 125;
    font-weight: 800;
    font-size: clamp(2.75rem, 5.2vw, 4.75rem);
    line-height: 0.95;
    letter-spacing: -0.025em;
    margin-bottom: 24px;
  }

  .intro p {
    max-width: 46ch;
    font-size: var(--t-lg);
  }

  /* First run: the headline rises in, then each step in turn. */
  h1,
  .intro p,
  .steps li {
    animation: rise 620ms var(--ease-out) backwards;
  }
  .intro p {
    animation-delay: 120ms;
  }
  .steps li:nth-child(1) {
    animation-delay: 260ms;
  }
  .steps li:nth-child(2) {
    animation-delay: 340ms;
  }
  .steps li:nth-child(3) {
    animation-delay: 420ms;
  }
  .steps li:nth-child(4) {
    animation-delay: 500ms;
  }

  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    counter-reset: step;
    display: grid;
    gap: 28px;
  }

  .steps li {
    counter-increment: step;
    position: relative;
    padding-left: 48px;
    display: grid;
    gap: 10px;
    justify-items: start;
  }

  .steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: -2px;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: var(--t-md);
    color: var(--brass);
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--brass) 55%, transparent);
  }

  h3 {
    font-size: var(--t-lg);
    font-weight: 600;
  }

  .steps p {
    font-size: var(--t-md);
    max-width: 52ch;
  }

  .copy-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  code {
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--panel);
    font-size: var(--t-md);
    user-select: all;
  }

  .field {
    max-width: 380px;
  }

  .waiting {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: var(--t-md);
  }

  .pulse {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--brass);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
      transform: scale(0.7);
    }
  }

  @media (max-width: 980px) {
    .setup {
      grid-template-columns: 1fr;
      align-items: start;
      gap: 40px;
    }
  }
</style>
