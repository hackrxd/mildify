<script lang="ts">
  // Settings → AI DJ: turning the DJ on, its downloads, the model and voice, and how it talks.
  import { dj } from "../lib/dj.svelte";
  import { INSTRUCTIONS_MAX, isTalkStyle, listenerName, NAME_MAX } from "../lib/djTalk";
  import {
    askBefore,
    choicePatch,
    CLOUD_NAMES,
    cloudModelOf,
    cloudOf,
    DEFAULT_CLOUD_MODEL,
    firstCloudModel,
    isCloud,
    modelChoiceOf,
    speedWords,
    voiceGroups,
    VOICE_SPEED,
    type DjChange,
    type Question,
  } from "../lib/djView";
  import { errorMessage, type DjCloud, type DjModelChoice } from "../lib/ipc";
  import { router, SECTION_IDS } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { toasts } from "../lib/toasts.svelte";
  import { formatBytes, lowerFirst } from "../lib/util";
  import ConfirmStrip from "./ConfirmStrip.svelte";
  import Icon from "./Icon.svelte";

  dj.refresh();
  const djStatus = $derived(dj.status);
  const djSettings = $derived(djStatus?.settings);
  const djMissing = $derived(djStatus?.needed.filter((n) => !n.installed) ?? []);
  const djToDownload = $derived(djMissing.reduce((n, c) => n + c.bytes, 0));
  const djInstall = $derived(djStatus?.install);
  let serverUrl = $state(dj.status?.settings.server_url ?? "");
  let serverModel = $state(dj.status?.settings.server_model ?? "");
  // Fill the fields once the status arrives, without overwriting what's being typed afterwards.
  let serverLoaded = false;
  $effect(() => {
    if (djSettings && !serverLoaded) {
      serverLoaded = true;
      serverUrl = djSettings.server_url;
      serverModel = djSettings.server_model;
    }
  });

  function saveServer() {
    if (serverUrl.trim() !== djSettings?.server_url || serverModel.trim() !== djSettings?.server_model) {
      dj.configure({ server_url: serverUrl.trim(), server_model: serverModel.trim() });
    }
  }

  /** The speed slider's value while it's dragged, until it's saved. */
  let draggedSpeed = $state<number | null>(null);
  const shownSpeed = $derived(draggedSpeed ?? djSettings?.voice_speed ?? 1);

  async function saveSpeed(speed: number) {
    draggedSpeed = speed;
    await dj.configure({ voice_speed: speed });
    // Dragged on while it saved: that's the one to show.
    if (draggedSpeed === speed) draggedSpeed = null;
  }

  let callMe = $state(dj.callMe);
  /** The first name on the Spotify account, when it looks like a name: what the DJ calls the listener by default. */
  const accountName = $derived(listenerName(session.user?.display_name));

  function saveCallMe() {
    dj.setCallMe(callMe);
    callMe = dj.callMe;
  }

  /** The cloud provider in use, if any. */
  const cloud = $derived(djSettings ? cloudOf(djSettings) : null);
  /** The model picker's value: a downloaded model, the own server, or a cloud provider. */
  const modelChoice = $derived(djSettings ? modelChoiceOf(djSettings) : "");
  const cloudModel = $derived(djSettings ? cloudModelOf(djSettings) : "");

  /** The model being switched to, until the switch is saved: stopping the old model can take a moment. */
  let switchingTo = $state<string | null>(null);

  async function pickModel(value: string) {
    // A key typed for one provider isn't the next one's.
    apiKey = "";
    switchingTo = value;
    await dj.configure(choicePatch(value));
    if (switchingTo === value) switchingTo = null;
  }

  /** A change waiting on the answer to what Settings asked about it. */
  let pending = $state<{ change: DjChange; question: Question } | null>(null);
  /** The model picker shows the model it's asking about or switching to, and its description, until that's settled. */
  const shownChoice = $derived(pending?.change.kind === "model" ? pending.change.choice : (switchingTo ?? modelChoice));
  /** The voice picker shows the voice it's asking about. */
  const shownVoice = $derived(pending?.change.kind === "voice" ? pending.change.choice : (djSettings?.voice ?? ""));

  /** Makes `change`, once it's asked about it when it stops the DJ or can't be taken back. */
  function change(c: DjChange) {
    pending = null;
    // Back to the model or voice in use, from one it was asking about.
    if (c.kind === "model" && c.choice === modelChoice) return;
    if (c.kind === "voice" && c.choice === djSettings?.voice) return;
    const question = djStatus ? askBefore(c, djStatus, dj.phase !== "off") : null;
    if (question) pending = { change: c, question };
    else make(c);
  }

  function make(c: DjChange) {
    pending = null;
    if (c.kind === "model") pickModel(c.choice);
    else if (c.kind === "voice") dj.configure({ voice: c.choice });
    else if (c.kind === "key") removeKey(c.provider);
    else if (c.kind === "forget") {
      dj.forget();
      toasts.show("Your DJ forgot what it remembered");
    } else dj.remove();
  }

  let apiKey = $state("");
  async function saveKey() {
    const key = apiKey.trim();
    if (!cloud || !key) return;
    // The key's models are listed again once it's in: the status that says so brings the list's effect round.
    forgetModels();
    if (await dj.setKey(cloud, key)) apiKey = "";
  }

  function removeKey(provider: DjCloud) {
    forgetModels();
    dj.setKey(provider, null);
  }

  function forgetModels() {
    modelsFor = null;
    cloudModels = null;
    modelsError = null;
  }

  let cloudModels = $state<DjModelChoice[] | null>(null);
  let modelsError = $state<string | null>(null);
  let modelsFor: DjCloud | null = null;
  // Lists the provider's models once its key is in.
  $effect(() => {
    if (cloud && djStatus?.keys[cloud] && modelsFor !== cloud) loadModels(cloud);
  });

  async function loadModels(provider: DjCloud) {
    modelsFor = provider;
    cloudModels = null;
    modelsError = null;
    try {
      const list = await dj.models(provider);
      if (modelsFor !== provider) return;
      cloudModels = list;
      const pick = firstCloudModel(list);
      // Nothing picked yet, and no default: start it on that one.
      if (pick && !djSettings?.api_models[provider] && !DEFAULT_CLOUD_MODEL[provider]) {
        dj.configure({ api_models: { [provider]: pick.id } });
      }
    } catch (e) {
      if (modelsFor === provider) modelsError = errorMessage(e);
    }
  }

  function pickCloudModel(id: string) {
    if (cloud && id.trim() && id.trim() !== cloudModel) dj.configure({ api_models: { [cloud]: id.trim() } });
  }
</script>

{#snippet asking(asked: { change: DjChange; question: Question })}
  <ConfirmStrip
    {...asked.question}
    danger={asked.change.kind !== "model" && asked.change.kind !== "voice"}
    onconfirm={() => make(asked.change)}
    oncancel={() => (pending = null)}
  />
{/snippet}

<section id={SECTION_IDS.dj}>
  <h2>AI DJ</h2>

  <label class="row">
    <span>
      <span class="label">Turn on the DJ</span>
      <span class="muted small">
        Plays songs from your listening and talks between them, like a radio host. Its voice is made on this computer,
        and so is its talk unless you pick a cloud model below. Turning it on downloads what it needs{djToDownload
          ? `, about ${formatBytes(djToDownload)}`
          : ""}; nothing is downloaded before.
      </span>
    </span>
    <input
      type="checkbox"
      class="switch"
      checked={dj.enabled}
      disabled={!djStatus?.supported}
      onchange={(e) => dj.setEnabled(e.currentTarget.checked)}
    />
  </label>

  {#if djStatus && !djStatus.supported}
    <div class="row"><span class="muted small">The DJ's model and voice aren't built for this computer's processor.</span></div>
  {:else if djSettings}
    {@const shown = { ...djSettings, ...choicePatch(shownChoice) }}
    {#if dj.enabled}
      <div class="row">
        <span>
          {#if djInstall?.running}
            <span class="label">Downloading {lowerFirst(djInstall.component ?? "the DJ")}…</span>
            <span class="muted small">
              {formatBytes(djInstall.received)}{djInstall.total ? ` of ${formatBytes(djInstall.total)}` : ""}
            </span>
          {:else if djInstall?.error}
            <span class="label">Download stopped</span>
            <span class="small error">{djInstall.error}</span>
          {:else if djMissing.length}
            <span class="label">{formatBytes(djToDownload)} left to download</span>
          {:else if djStatus?.setup}
            <span class="label">{cloud ? `Set up ${CLOUD_NAMES[cloud]}` : "Set up your model server"}</span>
            <span class="small error">{djStatus.setup}</span>
          {:else}
            <span class="label">Ready</span>
            <span class="muted small">Start it from the DJ page in the sidebar.</span>
          {/if}
        </span>
        <span class="buttons">
          {#if djInstall?.running}
            <button class="btn quiet" onclick={() => dj.cancelDownload()}>Pause</button>
          {:else if djMissing.length}
            <button class="btn primary" onclick={() => dj.retry()}>Download</button>
          {:else if djStatus?.setup}
            <!-- The fields are right below. -->
          {:else}
            <button class="btn quiet" onclick={() => router.go({ name: "dj" })}><Icon name="dj" size={16} /> Open the DJ</button>
          {/if}
        </span>
      </div>
    {/if}

    <label class="row">
      <span>
        <span class="label">Language model</span>
        <span class="muted small">
          {#if shown.provider === "own"}
            Any server with an OpenAI-style chat API: Ollama, LM Studio, llama.cpp. Nothing is downloaded for it.
          {:else if isCloud(shown.provider)}
            Usually smarter than the downloaded models, with your own {CLOUD_NAMES[shown.provider]} API key; what it
            uses is billed to your account. Nothing is downloaded for it.
          {:else}
            {djStatus?.models.find((m) => m.id === shown.model)?.detail ?? ""}
          {/if}
        </span>
      </span>
      <select
        class="field"
        value={shownChoice}
        onchange={(e) => change({ kind: "model", choice: e.currentTarget.value })}
      >
        <optgroup label="On this computer">
          {#each djStatus?.models ?? [] as m (m.id)}
            <option value="local:{m.id}">{m.label} ({formatBytes(m.bytes)})</option>
          {/each}
        </optgroup>
        <optgroup label="Your own">
          <option value="own">Your own model server</option>
        </optgroup>
        <optgroup label="Cloud, with your API key">
          {#each Object.entries(CLOUD_NAMES) as [id, name] (id)}
            <option value={id}>{name}</option>
          {/each}
        </optgroup>
      </select>
    </label>
    {#if pending?.change.kind === "model"}
      {@render asking(pending)}
    {/if}

    {#if cloud}
      {#if djStatus?.keys[cloud]}
        <div class="row">
          <span>
            <span class="label">{CLOUD_NAMES[cloud]} API key</span>
            <span class="muted small">Saved in your system's keychain. It never leaves this computer except to {CLOUD_NAMES[cloud]}.</span>
          </span>
          <button class="btn quiet danger" onclick={() => cloud && change({ kind: "key", provider: cloud })}>Remove key</button>
        </div>
        {#if pending?.change.kind === "key" && pending.change.provider === cloud}
          {@render asking(pending)}
        {/if}

        <div class="row">
          <span>
            <span class="label">Model</span>
            <span class="muted small">
              {#if modelsError}
                Couldn't list the models: {modelsError}. Type a model name instead.
              {:else}
                The models your key can use, newest first.
              {/if}
            </span>
          </span>
          <span class="buttons">
            {#if cloudModels?.length}
              <select class="field" value={cloudModel} onchange={(e) => pickCloudModel(e.currentTarget.value)}>
                {#if cloudModel && !cloudModels.some((m) => m.id === cloudModel)}
                  <option value={cloudModel}>{cloudModel}</option>
                {/if}
                {#each cloudModels as m (m.id)}
                  <option value={m.id}>{m.label}</option>
                {/each}
              </select>
            {:else if modelsError || cloudModels}
              <input
                class="field"
                value={cloudModel}
                placeholder="Model name"
                onblur={(e) => pickCloudModel(e.currentTarget.value)}
                onkeydown={(e) => e.key === "Enter" && pickCloudModel(e.currentTarget.value)}
              />
            {:else}
              <span class="muted small">Listing models…</span>
            {/if}
            <button class="btn quiet" title="List the models again" onclick={() => cloud && loadModels(cloud)}>Refresh</button>
          </span>
        </div>
      {:else}
        <label class="row">
          <span>
            <span class="label">{CLOUD_NAMES[cloud]} API key</span>
            <span class="muted small">Kept in your system's keychain, and only ever sent to {CLOUD_NAMES[cloud]}.</span>
          </span>
          <span class="buttons">
            <input
              class="field"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste your key"
              bind:value={apiKey}
              onkeydown={(e) => e.key === "Enter" && saveKey()}
            />
            <button class="btn primary" disabled={!apiKey.trim()} onclick={saveKey}>Save</button>
          </span>
        </label>
      {/if}
      <div class="row">
        <span class="muted small">
          With {CLOUD_NAMES[cloud]}, what the DJ is asked goes to {CLOUD_NAMES[cloud]}: the name it calls you, the songs
          it's choosing from with when you played or liked them, what it looked up about them, and your instructions
          below.
        </span>
      </div>
    {/if}

    {#if djSettings.provider === "own"}
      <label class="row">
        <span>
          <span class="label">Server address</span>
          <span class="muted small">Ollama listens on http://127.0.0.1:11434, LM Studio on http://127.0.0.1:1234.</span>
        </span>
        <input class="field" bind:value={serverUrl} onblur={saveServer} onkeydown={(e) => e.key === "Enter" && saveServer()} />
      </label>
      <label class="row">
        <span>
          <span class="label">Model name</span>
          <span class="muted small">As your server lists it, for example llama3.2 or qwen2.5:7b.</span>
        </span>
        <input class="field" bind:value={serverModel} onblur={saveServer} onkeydown={(e) => e.key === "Enter" && saveServer()} />
      </label>
      <label class="row">
        <span>
          <span class="label">Its model can look things up</span>
          <span class="muted small">
            Turn this on if the model supports tool calls, as most recent Llama, Qwen and Mistral models do. The DJ
            can then ask about songs before picking them.
          </span>
        </span>
        <input type="checkbox" class="switch" checked={djSettings.own_tools} onchange={(e) => dj.configure({ own_tools: e.currentTarget.checked })} />
      </label>
    {/if}

    {#if djStatus?.tools}
      <label class="row">
        <span>
          <span class="label">Look up genres on MusicBrainz</span>
          <span class="muted small">
            When the DJ looks songs up, it reads what Spotify says about them, and can ask MusicBrainz for their
            genres too. The songs' titles, artists and ISRC codes go to musicbrainz.org.
          </span>
        </span>
        <input type="checkbox" class="switch" checked={djSettings.musicbrainz} onchange={(e) => dj.configure({ musicbrainz: e.currentTarget.checked })} />
      </label>
    {/if}

    <label class="row">
      <span>
        <span class="label">Voice</span>
        <span class="muted small">The voices speak English. Those in a group download together.</span>
      </span>
      <select class="field" value={shownVoice} onchange={(e) => change({ kind: "voice", choice: e.currentTarget.value })}>
        {#each voiceGroups(djStatus?.voices ?? []) as group (group.name)}
          <optgroup label={group.label}>
            {#each group.voices as v (v.id)}
              <option value={v.id}>{v.label}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>
    {#if pending?.change.kind === "voice"}
      {@render asking(pending)}
    {/if}

    <label class="row">
      <span>
        <span class="label">Speaking speed</span>
        <span class="muted small">{speedWords(shownSpeed)}. A line the DJ already has ready keeps its speed.</span>
      </span>
      <span class="slider">
        <span class="muted small">Slower</span>
        <input
          type="range"
          min={VOICE_SPEED.min}
          max={VOICE_SPEED.max}
          step={VOICE_SPEED.step}
          value={shownSpeed}
          oninput={(e) => (draggedSpeed = Number(e.currentTarget.value))}
          onchange={(e) => saveSpeed(Number(e.currentTarget.value))}
          aria-label="How fast the DJ speaks"
        />
        <span class="muted small">Faster</span>
        <!-- Always laid out: appearing mid-drag would shift the slider under the pointer. -->
        <button
          class="btn quiet"
          class:hidden={shownSpeed === 1}
          type="button"
          disabled={shownSpeed === 1}
          onclick={() => saveSpeed(1)}>Reset</button
        >
      </span>
    </label>

    {#if dj.enabled}
      <label class="row">
        <span>
          <span class="label">Allow DJ to talk over beginning of track</span>
          <span class="muted small">
            The next song comes in under the last few seconds of the DJ's talk, and the DJ is done before anyone
            sings. When the song's intro is too short, or its lyrics aren't synced, it starts after the DJ anyway.
            Off, songs always start once the DJ is done.
          </span>
        </span>
        <input type="checkbox" class="switch" checked={dj.overStart} onchange={(e) => dj.setOverStart(e.currentTarget.checked)} />
      </label>

      <label class="row">
        <span>
          <span class="label">Allow DJ to talk over end of track</span>
          <span class="muted small">
            The DJ starts over the last few seconds of a song, once nobody is singing. Off, it waits for the song to
            finish.
          </span>
        </span>
        <input type="checkbox" class="switch" checked={dj.overEnd} onchange={(e) => dj.setOverEnd(e.currentTarget.checked)} />
      </label>

      <label class="row">
        <span>
          <span class="label">How much your DJ talks</span>
          <span class="muted small">
            Just play has no voice: the music plays straight through, and what the DJ would say shows as captions.
            Applies from its next set.
          </span>
        </span>
        <select class="field" value={dj.talk} onchange={(e) => isTalkStyle(e.currentTarget.value) && dj.setTalk(e.currentTarget.value)}>
          <option value="silent">Just play</option>
          <option value="brief">Brief</option>
          <option value="normal">Normal</option>
          <option value="chatty">Chatty</option>
        </select>
      </label>

      <label class="row">
        <span>
          <span class="label">Use my name</span>
          <span class="muted small">
            The DJ greets you by name, and says it again now and then: every fourth set on Normal and Chatty. Off, it
            never does.
          </span>
        </span>
        <input type="checkbox" class="switch" checked={dj.useName} onchange={(e) => dj.setUseName(e.currentTarget.checked)} />
      </label>

      <label class="row">
        <span>
          <span class="label">What your DJ calls you</span>
          <span class="muted small">
            {#if accountName}
              Empty, it calls you {accountName}, from your Spotify account.
            {:else}
              Empty, it uses no name: the one on your Spotify account doesn't look like one.
            {/if}
          </span>
        </span>
        <input
          class="field"
          maxlength={NAME_MAX}
          placeholder={accountName ?? "Your name"}
          disabled={!dj.useName}
          bind:value={callMe}
          onblur={saveCallMe}
          onkeydown={(e) => e.key === "Enter" && saveCallMe()}
        />
      </label>

      <label class="row">
        <span>
          <span class="label">Pick songs as it goes</span>
          <span class="muted small">
            The DJ picks each next song while one plays, so what you do changes what comes next: like a song and it
            plays more like it, skip one and that artist sits out, skip two and it moves on to something else. Off, it
            picks a whole set ahead. Applies from its next set.
          </span>
        </span>
        <input type="checkbox" class="switch" checked={dj.live} onchange={(e) => dj.setLive(e.currentTarget.checked)} />
      </label>

      <label class="row">
        <span>
          <span class="label">Let the DJ name every song in a set</span>
          <span class="muted small">
            {#if dj.live}
              While it picks songs as it goes, it introduces only the first song: it hasn't picked the rest yet.
            {:else}
              Off, it introduces only the first song and lets the rest of the set speak for itself.
            {/if}
          </span>
        </span>
        <input
          type="checkbox"
          class="switch"
          checked={dj.nameAll}
          disabled={dj.live}
          onchange={(e) => dj.setNameAll(e.currentTarget.checked)}
        />
      </label>

      <label class="row stacked">
        <span>
          <span class="label">Tell your DJ</span>
          <span class="muted small">How it should talk and what to play from your listening. Applies from its next set.</span>
        </span>
        <textarea
          class="field prose"
          rows="3"
          maxlength={INSTRUCTIONS_MAX}
          placeholder="Talk like a late-night radio host. Keep it short."
          value={dj.instructions}
          oninput={(e) => dj.setInstructions(e.currentTarget.value)}
        ></textarea>
      </label>
    {/if}
  {/if}

  {#if djStatus?.disk_bytes}
    <div class="row">
      <span>
        <span class="label">The DJ's files take {formatBytes(djStatus.disk_bytes)}</span>
        <span class="muted small">Removing them turns the DJ off. They download again if you turn it back on.</span>
      </span>
      <button class="btn quiet danger" onclick={() => change({ kind: "files" })}>Remove the DJ's files</button>
    </div>
    {#if pending?.change.kind === "files"}
      {@render asking(pending)}
    {/if}
  {/if}

  {#if djStatus?.supported}
    <div class="row">
      <span>
        <span class="label">What your DJ remembers</span>
        <span class="muted small">
          What it played, and what you skipped and liked while it played, kept on this computer for your Spotify
          account, for up to a year. Removing its files doesn't forget it.
        </span>
      </span>
      <button class="btn quiet danger" onclick={() => change({ kind: "forget" })}>Forget it</button>
    </div>
    {#if pending?.change.kind === "forget"}
      {@render asking(pending)}
    {/if}
  {/if}
</section>

<style>
  /* Opened from a link, it clears the top bar as the page's own heading does. */
  section {
    scroll-margin-top: 80px;
  }
  .row .prose {
    width: 100%;
    height: auto;
    padding: 10px 12px;
    color: inherit;
    resize: vertical;
    font: inherit;
    font-size: var(--t-md);
    user-select: text;
  }
</style>
