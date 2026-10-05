//! The AI DJ's backend. The DJ itself (picking songs from the user's listening, timing its talk around
//! lyrics, captions) lives in the UI (`src/lib/dj.svelte.ts`); this side owns what has to run natively:
//!
//! - downloading the runtimes, model and voice, only once the DJ is turned on (`install.rs`),
//! - the language model: run locally by llama.cpp (`engine.rs`), on the user's own server, or a cloud provider's
//!   with the user's API key (kept in the system keychain, `secrets.rs`); asked through `chat.rs`,
//! - the voice, sherpa-onnx text-to-speech (`voice.rs`), played on this computer's audio output (`speaker.rs`).
//!
//! Everything lives in `<app data>/dj/`; removing the DJ deletes that folder.

pub mod chat;
pub mod engine;
pub mod install;
pub mod manifest;
pub mod secrets;
pub mod songinfo;
pub mod speaker;
pub mod voice;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, Result};
use chat::{Answer, Api, Ask, Message, ModelChoice, Target, Tool};
use engine::Engine;
use manifest::{Component, Runtime, OWN_SERVER};
use secrets::Keys;
use songinfo::{SongInfo, SongLookup, SongRef};
use speaker::{Cmd, Speaker, VoiceCommand};
use voice::Speech;

/// The DJ's settings, part of `config.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DjConfig {
    /// Off until the user turns it on; nothing is downloaded before.
    pub enabled: bool,
    /// Who writes the talk: one of `PROVIDERS`.
    pub provider: String,
    /// The `manifest::MODELS` id the `"local"` provider runs.
    pub model: String,
    /// A `manifest::VOICES` id.
    pub voice: String,
    /// The user's own OpenAI-compatible server (Ollama, LM Studio, llama.cpp…), the `"own"` provider.
    pub server_url: String,
    /// The model name that server knows.
    pub server_model: String,
    /// That server's model can call tools, so it can look songs up.
    pub own_tools: bool,
    /// The model picked for each cloud provider.
    pub api_models: BTreeMap<String, String>,
    /// The cloud providers with a key saved in the keychain. The keys themselves stay there; this only spares
    /// asking the keychain (which may ask the user to unlock it) when nothing needs a key.
    pub api_keys: BTreeSet<String>,
    /// Song look-ups may ask MusicBrainz for genres.
    pub musicbrainz: bool,
}

/// Who can write the DJ's talk: the downloaded model, the user's own server, or a cloud provider.
pub const PROVIDERS: [&str; 5] = ["local", OWN_SERVER, "openai", "anthropic", "gemini"];
/// The providers that need an API key.
pub const CLOUD: [&str; 3] = ["openai", "anthropic", "gemini"];
/// Anthropic's model until the user picks another; the others list what the user's key can use.
const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-5-5";

fn api(provider: &str) -> Api {
    match provider {
        OWN_SERVER => Api::Own,
        "openai" => Api::OpenAi,
        "anthropic" => Api::Anthropic,
        "gemini" => Api::Gemini,
        _ => Api::Local,
    }
}

impl Default for DjConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "local".into(),
            model: manifest::DEFAULT_MODEL.into(),
            voice: manifest::DEFAULT_VOICE.into(),
            server_url: "http://127.0.0.1:11434".into(),
            server_model: String::new(),
            own_tools: false,
            api_models: BTreeMap::new(),
            api_keys: BTreeSet::new(),
            musicbrainz: true,
        }
    }
}

/// A settings change from the UI; missing fields stay as they are.
#[derive(Debug, Default, Deserialize)]
pub struct DjSettingsInput {
    pub enabled: Option<bool>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub voice: Option<String>,
    pub server_url: Option<String>,
    pub server_model: Option<String>,
    pub own_tools: Option<bool>,
    /// Models to pick, by cloud provider; an empty name forgets the pick.
    pub api_models: Option<BTreeMap<String, String>>,
    pub musicbrainz: Option<bool>,
}

impl DjConfig {
    /// Applies a change, refusing ids this build doesn't know.
    pub fn apply(&mut self, input: DjSettingsInput) -> Result<()> {
        if let Some(p) = &input.provider {
            if !PROVIDERS.contains(&p.as_str()) {
                return Err(AppError::Other(format!("Unknown DJ model provider {p}")));
            }
        }
        if let Some(m) = &input.model {
            if m != OWN_SERVER && manifest::model(m).is_none() {
                return Err(AppError::Other(format!("Unknown DJ model {m}")));
            }
        }
        if let Some(bad) = input.api_models.iter().flatten().map(|(p, _)| p).find(|p| !CLOUD.contains(&p.as_str())) {
            return Err(AppError::Other(format!("Unknown DJ model provider {bad}")));
        }
        if let Some(m) = input.model {
            // Settings from before there were providers say "own" here.
            if m == OWN_SERVER {
                self.provider = OWN_SERVER.into();
            } else {
                self.model = m;
                self.provider = "local".into();
            }
        }
        if let Some(p) = input.provider {
            self.provider = p;
        }
        if let Some(v) = input.voice {
            if manifest::voice(&v).is_none() {
                return Err(AppError::Other(format!("Unknown DJ voice {v}")));
            }
            self.voice = v;
        }
        if let Some(url) = input.server_url {
            self.server_url = url.trim().to_owned();
        }
        if let Some(name) = input.server_model {
            self.server_model = name.trim().to_owned();
        }
        if let Some(on) = input.own_tools {
            self.own_tools = on;
        }
        for (provider, model) in input.api_models.into_iter().flatten() {
            let model = model.trim();
            if model.is_empty() {
                self.api_models.remove(&provider);
            } else {
                self.api_models.insert(provider, model.to_owned());
            }
        }
        if let Some(on) = input.musicbrainz {
            self.musicbrainz = on;
        }
        if let Some(on) = input.enabled {
            self.enabled = on;
        }
        Ok(())
    }

    /// Settings written before there were providers kept the own server as a model.
    pub fn migrate(&mut self) {
        if self.model == OWN_SERVER {
            self.provider = OWN_SERVER.into();
            self.model = manifest::DEFAULT_MODEL.into();
        }
        if !PROVIDERS.contains(&self.provider.as_str()) {
            self.provider = "local".into();
        }
    }

    fn api(&self) -> Api {
        api(&self.provider)
    }

    /// Whether a change from `other` to these settings leaves the model and the downloads as they are: picking a
    /// cloud model, look-up options and the like don't unload the model or restart a download.
    pub fn same_engine(&self, other: &DjConfig) -> bool {
        (self.enabled, &self.provider, &self.model, &self.voice, &self.server_url, &self.server_model)
            == (other.enabled, &other.provider, &other.model, &other.voice, &other.server_url, &other.server_model)
    }

    /// The model picked for the cloud provider in use.
    fn api_model(&self) -> Option<String> {
        self.api_models
            .get(&self.provider)
            .cloned()
            .or_else(|| (self.provider == "anthropic").then(|| DEFAULT_ANTHROPIC_MODEL.to_owned()))
    }

    /// What the settings still need before the DJ can ask its model anything: an own server's address and
    /// model name (servers refuse a request without one), a cloud provider's key and model.
    fn setup_problem(&self) -> Option<String> {
        let api = self.api();
        match api {
            Api::Local => None,
            Api::Own => {
                if let Err(e) = chat::chat_url(&self.server_url) {
                    return Some(e.to_string());
                }
                self.server_model.trim().is_empty().then(|| "Enter the model name your server uses".to_owned())
            }
            _ if !self.api_keys.contains(&self.provider) => Some(format!("Add your {} API key", api.name())),
            _ => self.api_model().is_none().then(|| format!("Pick which {} model the DJ uses", api.name())),
        }
    }
}

/// A download the current settings need.
#[derive(Debug, Clone, Serialize)]
pub struct Needed {
    pub id: &'static str,
    pub label: &'static str,
    pub bytes: u64,
    pub installed: bool,
}

/// What's downloading.
#[derive(Debug, Clone, Default, Serialize)]
pub struct InstallState {
    pub running: bool,
    /// Label of the component downloading now.
    pub component: Option<String>,
    pub received: u64,
    pub total: Option<u64>,
    /// Why the last attempt stopped, if it failed.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Choice {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: Option<&'static str>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DjStatus {
    /// Prebuilt runtimes exist for this computer.
    pub supported: bool,
    pub settings: DjConfig,
    /// Everything the settings need is downloaded, and an own server is set up.
    pub ready: bool,
    /// What the model settings still need, if anything.
    pub setup: Option<String>,
    /// Which cloud providers have a key saved.
    pub keys: BTreeMap<&'static str, bool>,
    /// The model in use can look songs up.
    pub tools: bool,
    pub needed: Vec<Needed>,
    pub install: InstallState,
    /// Space the DJ's folder takes.
    pub disk_bytes: u64,
    pub folder: PathBuf,
    pub models: Vec<Choice>,
    pub voices: Vec<Choice>,
}

/// Spoken lines kept for the UI to fetch; a session only ever needs the next one or two.
const SPEECH_KEPT: usize = 8;
/// How often download progress reaches the UI.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

pub struct Dj {
    root: PathBuf,
    scratch: PathBuf,
    http: reqwest::Client,
    runtime: Option<Runtime>,
    install: Arc<Mutex<InstallState>>,
    /// Bumped to cancel a running install.
    generation: Arc<AtomicU64>,
    /// Held by the install task: a new one waits for a cancelled one to let go of its files.
    installing: Arc<tokio::sync::Mutex<()>>,
    engine: Arc<Engine>,
    speech: Mutex<VecDeque<(u64, Arc<Vec<u8>>)>>,
    next_speech: AtomicU64,
    speaker: Speaker,
    keys: Arc<Keys>,
    /// Whether each Anthropic model takes `effort`, once asked.
    effort: Mutex<HashMap<String, bool>>,
    songs: SongLookup,
}

/// The most songs one look-up covers: the model asks about a handful before it picks.
pub const LOOK_UP_AT_MOST: usize = 5;

impl Dj {
    pub fn new(root: PathBuf, scratch: PathBuf, http: reqwest::Client) -> Self {
        Self {
            scratch,
            http: http.clone(),
            runtime: manifest::this_runtime(),
            install: Arc::default(),
            generation: Arc::default(),
            installing: Arc::default(),
            engine: Arc::default(),
            speech: Mutex::default(),
            next_speech: AtomicU64::new(1),
            speaker: Speaker::default(),
            // Beside the DJ's folder, not in it: removing the DJ's downloads keeps the keys.
            keys: Arc::new(Keys::new(root.with_file_name("dj_keys.json"))),
            effort: Mutex::default(),
            songs: SongLookup::new(http.clone(), root.join("song_info.json")),
            root,
        }
    }

    /// The downloads `cfg` needs, smallest first so the voice can be checked before the model is in.
    fn needed(&self, cfg: &DjConfig) -> Vec<Component> {
        let Some(rt) = self.runtime else { return Vec::new() };
        let mut list = vec![rt.tts];
        if let Some(v) = manifest::voice(&cfg.voice) {
            list.push(v.component);
        }
        if cfg.api() == Api::Local {
            list.push(rt.llm);
            if let Some(m) = manifest::model(&cfg.model) {
                list.push(m.component);
            }
        }
        list
    }

    pub fn status(&self, cfg: &DjConfig) -> DjStatus {
        let needed: Vec<Needed> = self
            .needed(cfg)
            .iter()
            .map(|c| Needed {
                id: c.id,
                label: c.label,
                bytes: c.bytes,
                installed: install::is_installed(&self.root, c),
            })
            .collect();
        let setup = cfg.setup_problem();
        DjStatus {
            supported: self.runtime.is_some(),
            settings: cfg.clone(),
            ready: self.runtime.is_some() && setup.is_none() && needed.iter().all(|n| n.installed),
            setup,
            keys: CLOUD.iter().map(|p| (*p, cfg.api_keys.contains(*p))).collect(),
            tools: can_look_up(cfg),
            needed,
            install: self.install.lock().unwrap().clone(),
            disk_bytes: install::size_of(&self.root),
            folder: self.root.clone(),
            models: manifest::MODELS
                .iter()
                .map(|m| Choice { id: m.id, label: m.label, detail: Some(m.detail), bytes: m.component.bytes })
                .collect(),
            voices: manifest::VOICES
                .iter()
                .map(|v| Choice { id: v.id, label: v.label, detail: None, bytes: v.component.bytes })
                .collect(),
        }
    }

    fn emit_status(&self, app: &AppHandle, cfg: &DjConfig) {
        let _ = app.emit("dj-status", self.status(cfg));
    }

    /// Downloads whatever `cfg` still needs, in the background. Only while the DJ is on.
    pub fn start_install(&self, app: &AppHandle, cfg: DjConfig) -> Result<()> {
        if !cfg.enabled {
            return Err(AppError::Other("Turn the DJ on first".into()));
        }
        if self.runtime.is_none() {
            return Err(AppError::Other("The DJ can't run on this computer".into()));
        }
        let missing: Vec<Component> =
            self.needed(&cfg).into_iter().filter(|c| !install::is_installed(&self.root, c)).collect();
        {
            let mut state = self.install.lock().unwrap();
            if state.running {
                return Ok(());
            }
            *state = InstallState { running: !missing.is_empty(), ..InstallState::default() };
        }
        if missing.is_empty() {
            self.emit_status(app, &cfg);
            return Ok(());
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (root, http, state, gen, app) =
            (self.root.clone(), self.http.clone(), self.install.clone(), self.generation.clone(), app.clone());
        let installing = self.installing.clone();
        tauri::async_runtime::spawn(async move {
            let _one_at_a_time = installing.lock().await;
            if gen.load(Ordering::SeqCst) != generation {
                return;
            }
            install::remove_stale(&root, &manifest::known_ids());
            let mut error = None;
            for c in &missing {
                {
                    let mut s = state.lock().unwrap();
                    s.component = Some(c.label.to_owned());
                    s.received = 0;
                    s.total = Some(c.bytes);
                }
                let _ = app.emit("dj-progress", state.lock().unwrap().clone());
                let reporter = Reporter {
                    app: app.clone(),
                    state: state.clone(),
                    gen: gen.clone(),
                    mine: generation,
                    last: Mutex::new(None),
                };
                match install::install(&http, &root, c, &reporter).await {
                    Ok(()) => log::info!("DJ: installed {}", c.id),
                    Err(AppError::Cancelled) => break,
                    Err(e) => {
                        log::warn!("DJ: couldn't install {}: {e}", c.id);
                        error = Some(e.to_string());
                        break;
                    }
                }
                if gen.load(Ordering::SeqCst) != generation {
                    break;
                }
            }
            if gen.load(Ordering::SeqCst) == generation {
                *state.lock().unwrap() = InstallState { error, ..InstallState::default() };
            }
            let _ = app.emit("dj-installed", ());
        });
        Ok(())
    }

    /// Stops a download; what's downloaded so far is kept and resumes next time.
    pub fn cancel_install(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let mut s = self.install.lock().unwrap();
        s.running = false;
        s.component = None;
    }

    /// Deletes everything the DJ downloaded.
    pub async fn remove(&self) -> Result<()> {
        self.cancel_install();
        self.engine.stop().await;
        self.songs.clear();
        // Let a cancelled download close its file first (Windows can't delete open files).
        let _done = tokio::time::timeout(Duration::from_secs(5), self.installing.lock()).await;
        for dir in [&self.root, &self.scratch] {
            match tokio::fs::remove_dir_all(dir).await {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    return Err(AppError::Other(format!("Couldn't delete {}: {e}", dir.display())));
                }
                _ => {}
            }
        }
        *self.install.lock().unwrap() = InstallState::default();
        Ok(())
    }

    fn installed_dir(&self, c: &Component) -> Result<PathBuf> {
        if !install::is_installed(&self.root, c) {
            return Err(AppError::Other("The DJ is still downloading what it needs".into()));
        }
        Ok(install::component_dir(&self.root, c))
    }

    async fn target(&self, cfg: &DjConfig) -> Result<Target> {
        if !cfg.enabled {
            return Err(AppError::Other("The DJ is turned off".into()));
        }
        if let Some(problem) = cfg.setup_problem() {
            return Err(AppError::Other(problem));
        }
        let tools = can_look_up(cfg);
        match cfg.api() {
            Api::Local => {}
            Api::Own => {
                return Ok(Target {
                    api: Api::Own,
                    url: chat::chat_url(&cfg.server_url)?,
                    key: None,
                    model: cfg.server_model.clone(),
                    tools,
                    effort: false,
                });
            }
            api => {
                let key = Some(self.key(&cfg.provider).await?);
                let model = cfg.api_model().unwrap_or_default();
                let url = match api {
                    Api::OpenAi => chat::OPENAI_URL,
                    Api::Gemini => chat::GEMINI_URL,
                    _ => chat::ANTHROPIC_URL,
                };
                let effort = match (api, &key) {
                    (Api::Anthropic, Some(k)) => self.takes_effort(k, &model).await,
                    _ => false,
                };
                return Ok(Target { api, url: url.into(), key, model, tools, effort });
            }
        }
        let rt = self.runtime.ok_or_else(|| AppError::Other("The DJ can't run on this computer".into()))?;
        let model = manifest::model(&cfg.model).ok_or_else(|| AppError::Other("Pick a model for the DJ".into()))?;
        let server = install::find(&self.installed_dir(&rt.llm)?, manifest::LLAMA_SERVER, 2).ok_or_else(|| {
            AppError::Other("The DJ's model runtime is incomplete. Remove the DJ's files and turn it on again.".into())
        })?;
        let file = model.component.url.rsplit('/').next().unwrap_or_default();
        let weights = self.installed_dir(&model.component)?.join(file);
        tokio::fs::create_dir_all(&self.scratch).await?;
        let target = self.engine.local(&server, &weights, &self.scratch.join("llama-server.log")).await?;
        Ok(Target { tools, ..target })
    }

    /// Whether an Anthropic model takes `effort`; asked once per model, and taken as no when it can't be told.
    async fn takes_effort(&self, key: &str, model: &str) -> bool {
        if let Some(known) = self.effort.lock().unwrap().get(model) {
            return *known;
        }
        match chat::anthropic_effort(&self.http, key, model).await {
            Ok(takes) => {
                self.effort.lock().unwrap().insert(model.to_owned(), takes);
                takes
            }
            Err(e) => {
                log::warn!("DJ: couldn't tell whether {model} takes effort: {e}");
                false
            }
        }
    }

    /// The saved key for a cloud provider, read off the async runtime's workers: the keychain may wait on the
    /// user to unlock it.
    async fn key(&self, provider: &str) -> Result<String> {
        let (keys, p) = (self.keys.clone(), provider.to_owned());
        let name = api(provider).name();
        let key = tokio::task::spawn_blocking(move || keys.get(&p))
            .await
            .map_err(|e| AppError::Other(format!("Couldn't read the keychain: {e}")))?
            .map_err(|e| {
                AppError::Other(format!(
                    "Couldn't read your {name} API key from the keychain ({e}). If it's locked, unlock it and try again."
                ))
            })?;
        key.ok_or_else(|| {
            AppError::Other(format!("Your {name} API key isn't in the keychain any more. Add it again in Settings → AI DJ."))
        })
    }

    /// Saves, or with `None` removes, the API key for a cloud provider; whether one is saved now.
    pub async fn set_key(&self, provider: &str, key: Option<String>) -> Result<bool> {
        if !CLOUD.contains(&provider) {
            return Err(AppError::Other(format!("Unknown DJ model provider {provider}")));
        }
        let key = key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
        let saved = key.is_some();
        let (keys, p) = (self.keys.clone(), provider.to_owned());
        tokio::task::spawn_blocking(move || keys.set(&p, key.as_deref()))
            .await
            .map_err(|e| AppError::Other(format!("Couldn't reach the keychain: {e}")))??;
        Ok(saved)
    }

    /// The models a cloud provider offers with the saved key.
    pub async fn models(&self, provider: &str) -> Result<Vec<ModelChoice>> {
        if !CLOUD.contains(&provider) {
            return Err(AppError::Other(format!("Unknown DJ model provider {provider}")));
        }
        let key = self.key(provider).await?;
        chat::models(&self.http, api(provider), &key).await
    }

    /// Loads the model ahead of the first request, so the DJ starts sooner.
    pub async fn warm(&self, cfg: &DjConfig) -> Result<()> {
        self.target(cfg).await.map(|_| ())
    }

    /// Asks the model for JSON fitting `schema`, or, offered `tools`, for any look-ups it wants first.
    pub async fn generate(
        &self,
        cfg: &DjConfig,
        messages: &[Message],
        schema: Option<&Value>,
        tools: Option<&[Tool]>,
        max_tokens: u32,
    ) -> Result<Answer> {
        let ask = match (tools, schema) {
            (Some(tools), _) => Ask::LookUp(tools),
            (None, Some(schema)) => Ask::Json(schema),
            (None, None) => return Err(AppError::Other("Ask the DJ's model for JSON or look-ups".into())),
        };
        let target = self.target(cfg).await?;
        self.engine.touch();
        let answer = chat::chat(&self.http, &target, messages, ask, max_tokens).await;
        self.engine.touch();
        answer
    }

    /// What can be found out about songs the model asked about. Spotify's metadata comes through the player's
    /// session, so there's less to say while it isn't running.
    pub async fn song_info(
        &self,
        cfg: &DjConfig,
        songs: &[SongRef],
        session: Option<librespot_core::Session>,
        web: &crate::webapi::WebApi,
    ) -> Result<Vec<SongInfo>> {
        if !cfg.enabled {
            return Err(AppError::Other("The DJ is turned off".into()));
        }
        let songs = &songs[..songs.len().min(LOOK_UP_AT_MOST)];
        Ok(self.songs.look_up(songs, session, web, cfg.musicbrainz).await)
    }

    /// Unloads the model; the next request loads it again.
    pub async fn release(&self) {
        self.engine.stop().await;
    }

    /// Stops any line and lets go of the audio output, as a session ends.
    pub fn close_voice(&self) {
        self.speaker.close();
    }

    /// Unloads the model after it's gone unused for a while.
    pub fn watch_idle(&self) {
        let engine = self.engine.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                if engine.idle(Instant::now()) && engine.is_running().await {
                    log::info!("DJ: unloading the model after {} idle minutes", engine::IDLE.as_secs() / 60);
                    engine.stop().await;
                }
            }
        });
    }

    pub fn shutdown(&self) {
        self.cancel_install();
        self.speaker.close();
        self.engine.kill_now();
    }

    pub async fn speak(&self, cfg: &DjConfig, text: &str) -> Result<Speech> {
        if !cfg.enabled {
            return Err(AppError::Other("The DJ is turned off".into()));
        }
        let rt = self.runtime.ok_or_else(|| AppError::Other("The DJ can't run on this computer".into()))?;
        let v = manifest::voice(&cfg.voice).ok_or_else(|| AppError::Other("Pick a voice for the DJ".into()))?;
        let incomplete =
            || AppError::Other("The DJ's voice is incomplete. Remove the DJ's files and turn it on again.".into());
        let program = install::find(&self.installed_dir(&rt.tts)?, manifest::TTS_PROGRAM, 3).ok_or_else(incomplete)?;
        let dir = install::find(&self.installed_dir(&v.component)?, v.kind.model_file(), 2)
            .and_then(|f| f.parent().map(Path::to_owned))
            .ok_or_else(incomplete)?;
        let setup = voice::Setup { program, dir, voice: v };
        let (wav, sentences, duration_ms) = voice::speak(&setup, text, &self.scratch).await?;
        let id = self.next_speech.fetch_add(1, Ordering::SeqCst);
        let mut kept = self.speech.lock().unwrap();
        if kept.len() >= SPEECH_KEPT {
            kept.pop_front();
        }
        kept.push_back((id, Arc::new(wav)));
        Ok(Speech { id, duration_ms, sentences })
    }

    /// The WAV audio of a line `speak` made.
    fn speech_audio(&self, id: u64) -> Option<Arc<Vec<u8>>> {
        self.speech.lock().unwrap().iter().find(|(i, _)| *i == id).map(|(_, wav)| wav.clone())
    }

    /// Plays, pauses or stops the DJ's lines on this computer's audio output; `dj-voice` events say how it goes.
    pub fn voice(&self, app: &AppHandle, command: VoiceCommand) -> Result<()> {
        let cmd = match command {
            VoiceCommand::Play { id, gain } => {
                let wav = self.speech_audio(id).ok_or_else(|| AppError::Other("That line is gone".into()))?;
                let pcm = voice::pcm(&wav)
                    .ok_or_else(|| AppError::Other("The DJ's voice wrote audio it can't play".into()))?;
                Cmd::Play { id, pcm, gain: gain.clamp(0.0, 1.0) }
            }
            VoiceCommand::Pause => Cmd::Pause,
            VoiceCommand::Resume => Cmd::Resume,
            VoiceCommand::Gain { gain } => Cmd::Gain(gain.clamp(0.0, 1.0)),
            VoiceCommand::Stop => Cmd::Stop,
        };
        let app = app.clone();
        self.speaker.send(cmd, move || {
            Arc::new(move |event| {
                let _ = app.emit("dj-voice", event);
            })
        });
        Ok(())
    }
}

/// Whether the model `cfg` uses can call tools.
fn can_look_up(cfg: &DjConfig) -> bool {
    match cfg.api() {
        Api::Local => manifest::model(&cfg.model).is_some_and(|m| m.tools),
        Api::Own => cfg.own_tools,
        _ => true,
    }
}

/// Passes download progress to the UI, a few times a second, and says when to stop.
struct Reporter {
    app: AppHandle,
    state: Arc<Mutex<InstallState>>,
    gen: Arc<AtomicU64>,
    mine: u64,
    last: Mutex<Option<Instant>>,
}

impl install::Progress for Reporter {
    fn report(&self, received: u64, total: Option<u64>) {
        if self.cancelled() {
            return;
        }
        let snapshot = {
            let mut s = self.state.lock().unwrap();
            s.received = received;
            s.total = total.or(s.total);
            s.clone()
        };
        let now = Instant::now();
        let mut last = self.last.lock().unwrap();
        let done = total == Some(received);
        if done || last.is_none_or(|t| now.duration_since(t) >= PROGRESS_EVERY) {
            *last = Some(now);
            let _ = self.app.emit("dj-progress", snapshot);
        }
    }

    fn cancelled(&self) -> bool {
        self.gen.load(Ordering::SeqCst) != self.mine
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dj() -> Dj {
        let root = std::env::temp_dir().join(format!("mildify-test-{}", crate::config::random_hex(8)));
        dj_with(Arc::default(), root)
    }

    /// A DJ whose keys are in `chain`, never the real keychain.
    fn dj_with(chain: Arc<secrets::Memory>, root: PathBuf) -> Dj {
        let mut d = Dj::new(root.join("dj"), root.join("cache"), reqwest::Client::new());
        d.keys = Arc::new(Keys::with(Box::new(chain), root.join("dj_keys.json")));
        d
    }

    fn own() -> DjConfig {
        DjConfig { provider: OWN_SERVER.into(), server_url: "http://127.0.0.1:11434".into(), ..DjConfig::default() }
    }

    #[test]
    fn off_by_default_with_the_default_model_and_voice() {
        let c = DjConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.model, manifest::DEFAULT_MODEL);
        assert_eq!(c.voice, manifest::DEFAULT_VOICE);
    }

    #[test]
    fn settings_changes_refuse_unknown_ids() {
        let mut c = DjConfig::default();
        assert!(c.apply(DjSettingsInput { model: Some("gpt-9".into()), ..Default::default() }).is_err());
        assert!(c.apply(DjSettingsInput { voice: Some("nobody".into()), ..Default::default() }).is_err());
        assert_eq!(c, DjConfig::default(), "a refused change changes nothing");
        assert!(c.apply(DjSettingsInput { provider: Some("skynet".into()), ..Default::default() }).is_err());
        let bad_pick = BTreeMap::from([("skynet".to_owned(), "t-800".to_owned())]);
        assert!(c.apply(DjSettingsInput { api_models: Some(bad_pick), ..Default::default() }).is_err());
        assert_eq!(c, DjConfig::default(), "a refused change changes nothing");
        c.apply(DjSettingsInput {
            enabled: Some(true),
            provider: Some(OWN_SERVER.into()),
            voice: Some("emma".into()),
            server_url: Some(" http://localhost:1234 ".into()),
            server_model: Some(" qwen ".into()),
            own_tools: Some(true),
            ..Default::default()
        })
        .unwrap();
        assert!(c.enabled && c.api() == Api::Own && c.own_tools);
        assert_eq!(c.voice, "emma");
        assert_eq!(c.server_url, "http://localhost:1234");
        assert_eq!(c.server_model, "qwen");
        // Picking a downloaded model goes back to running it here.
        c.apply(DjSettingsInput { model: Some("qwen3-4b".into()), ..Default::default() }).unwrap();
        assert_eq!((c.provider.as_str(), c.model.as_str()), ("local", "qwen3-4b"));
    }

    #[test]
    fn picks_and_forgets_a_model_per_cloud_provider() {
        let mut c = DjConfig { provider: "anthropic".into(), ..DjConfig::default() };
        assert_eq!(c.api_model().as_deref(), Some(DEFAULT_ANTHROPIC_MODEL));
        let pick = |p: &str, m: &str| DjSettingsInput {
            api_models: Some(BTreeMap::from([(p.to_owned(), m.to_owned())])),
            ..Default::default()
        };
        c.apply(pick("anthropic", " claude-sonnet-5-5 ")).unwrap();
        assert_eq!(c.api_model().as_deref(), Some("claude-sonnet-5-5"));
        c.apply(pick("anthropic", "")).unwrap();
        assert_eq!(c.api_model().as_deref(), Some(DEFAULT_ANTHROPIC_MODEL));
        c.provider = "openai".into();
        assert_eq!(c.api_model(), None);
    }

    #[test]
    fn settings_from_before_providers_keep_the_own_server() {
        let old: DjConfig = serde_json::from_str(r#"{"enabled":true,"model":"own","server_model":"llama3.2"}"#).unwrap();
        let mut c = old.clone();
        c.migrate();
        assert_eq!(c.provider, OWN_SERVER);
        assert_eq!(c.model, manifest::DEFAULT_MODEL);
        assert_eq!(c.server_model, "llama3.2");
        assert!(c.musicbrainz, "new settings start at their defaults");
        let mut local: DjConfig = serde_json::from_str(r#"{"model":"qwen3-4b"}"#).unwrap();
        local.migrate();
        assert_eq!((local.provider.as_str(), local.model.as_str()), ("local", "qwen3-4b"));
    }

    #[test]
    fn needs_the_voice_first_and_no_model_with_an_own_server() {
        let d = dj();
        let Some(rt) = d.runtime else { return };
        let ids = |c: &DjConfig| d.needed(c).iter().map(|c| c.id).collect::<Vec<_>>();
        let cfg = DjConfig::default();
        let voice = manifest::voice(&cfg.voice).unwrap().component.id;
        let model = manifest::model(&cfg.model).unwrap().component.id;
        assert_eq!(ids(&cfg), vec![rt.tts.id, voice, rt.llm.id, model]);
        assert_eq!(ids(&DjConfig { provider: OWN_SERVER.into(), ..cfg.clone() }), vec![rt.tts.id, voice]);
        assert_eq!(ids(&DjConfig { provider: "gemini".into(), ..cfg }), vec![rt.tts.id, voice]);
    }

    #[test]
    fn an_own_server_needs_an_address_and_a_model_name() {
        let d = dj();
        let own = own();
        let status = d.status(&own);
        assert!(!status.ready);
        assert!(status.setup.as_deref().is_some_and(|s| s.contains("model name")), "{:?}", status.setup);
        let bad_url = DjConfig { server_url: "localhost:11434".into(), server_model: "llama3.2".into(), ..own.clone() };
        assert!(d.status(&bad_url).setup.is_some());
        let named = DjConfig { server_model: " llama3.2 ".into(), ..own };
        assert_eq!(d.status(&named).setup, None);
        // A built-in model needs neither.
        assert_eq!(d.status(&DjConfig::default()).setup, None);
    }

    #[tokio::test]
    async fn wont_ask_an_own_server_without_a_model_name() {
        let d = dj();
        let cfg = DjConfig { enabled: true, ..own() };
        let schema = serde_json::json!({ "type": "object" });
        match d.generate(&cfg, &[], Some(&schema), None, 10).await {
            Err(AppError::Other(m)) => assert!(m.contains("model name"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_cloud_provider_needs_a_key_and_a_model() {
        let d = dj();
        let cfg = DjConfig { provider: "openai".into(), ..DjConfig::default() };
        let status = d.status(&cfg);
        assert_eq!(status.setup.as_deref(), Some("Add your OpenAI API key"));
        assert_eq!(status.keys.get("openai"), Some(&false));
        let keyed = DjConfig { api_keys: BTreeSet::from(["openai".to_owned()]), ..cfg };
        let status = d.status(&keyed);
        assert_eq!(status.keys.get("openai"), Some(&true));
        assert_eq!(status.setup.as_deref(), Some("Pick which OpenAI model the DJ uses"));
        let picked = DjConfig { api_models: BTreeMap::from([("openai".into(), "gpt-x".into())]), ..keyed };
        assert_eq!(d.status(&picked).setup, None);
    }

    #[tokio::test]
    async fn keeps_keys_in_the_keychain_and_asks_it_only_when_a_key_is_needed() {
        let chain = Arc::<secrets::Memory>::default();
        let root = std::env::temp_dir().join(format!("mildify-test-{}", crate::config::random_hex(8)));
        let d = dj_with(chain.clone(), root);
        assert!(d.set_key("openai", Some("  sk-test ".into())).await.unwrap());
        assert!(d.set_key("skynet", Some("x".into())).await.is_err());
        let cfg = DjConfig {
            enabled: true,
            provider: "openai".into(),
            api_keys: BTreeSet::from(["openai".to_owned()]),
            api_models: BTreeMap::from([("openai".into(), "gpt-x".into())]),
            ..DjConfig::default()
        };
        // Showing the settings, with any provider, leaves the keychain alone.
        for provider in ["openai", "anthropic", "local"] {
            d.status(&DjConfig { provider: provider.into(), ..cfg.clone() });
        }
        assert_eq!(chain.reads(), 0);
        assert_eq!(d.target(&cfg).await.unwrap().key.as_deref(), Some("sk-test"));
        assert!(!d.set_key("openai", None).await.unwrap());
        // Gone from the keychain behind the settings' back: said plainly, not sent without a key.
        match d.target(&cfg).await {
            Err(AppError::Other(m)) => assert!(m.contains("isn't in the keychain any more"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn only_model_and_download_changes_unload_the_model() {
        let old = DjConfig { enabled: true, ..DjConfig::default() };
        let picks = DjConfig {
            musicbrainz: false,
            own_tools: true,
            api_models: BTreeMap::from([("openai".into(), "gpt-x".into())]),
            api_keys: BTreeSet::from(["openai".to_owned()]),
            ..old.clone()
        };
        assert!(picks.same_engine(&old));
        assert!(!DjConfig { model: "qwen3-4b".into(), ..old.clone() }.same_engine(&old));
        assert!(!DjConfig { provider: "anthropic".into(), ..old.clone() }.same_engine(&old));
        assert!(!DjConfig { voice: "emma".into(), ..old.clone() }.same_engine(&old));
        assert!(!DjConfig { enabled: false, ..old.clone() }.same_engine(&old));
        assert!(!DjConfig { server_url: "http://x".into(), ..old.clone() }.same_engine(&old));
    }

    #[test]
    fn says_which_models_can_look_songs_up() {
        let d = dj();
        assert!(!d.status(&DjConfig::default()).tools, "the small model is left to pick from what it's given");
        assert!(d.status(&DjConfig { model: "qwen3-4b".into(), ..DjConfig::default() }).tools);
        assert!(!d.status(&own()).tools);
        assert!(d.status(&DjConfig { own_tools: true, ..own() }).tools);
        assert!(d.status(&DjConfig { provider: "anthropic".into(), ..DjConfig::default() }).tools);
    }

    #[tokio::test]
    async fn asks_a_cloud_provider_with_the_saved_key_and_model() {
        let d = dj();
        d.set_key("gemini", Some("g-key".into())).await.unwrap();
        let cfg = DjConfig {
            enabled: true,
            provider: "gemini".into(),
            api_keys: BTreeSet::from(["gemini".to_owned()]),
            api_models: BTreeMap::from([("gemini".into(), "gemini-x".into())]),
            ..DjConfig::default()
        };
        let t = d.target(&cfg).await.unwrap();
        assert_eq!(t.api, Api::Gemini);
        assert_eq!(t.url, chat::GEMINI_URL);
        assert_eq!(t.key.as_deref(), Some("g-key"));
        assert_eq!(t.model, "gemini-x");
        assert!(t.tools);
    }

    #[test]
    fn nothing_downloads_while_the_dj_is_off() {
        let d = dj();
        let status = d.status(&DjConfig::default());
        assert!(!status.ready);
        assert!(status.needed.iter().all(|n| !n.installed));
        assert_eq!(status.disk_bytes, 0);
        assert!(!d.root.exists(), "looking doesn't create the folder");
    }

    #[tokio::test]
    async fn refuses_to_talk_or_think_while_off() {
        let d = dj();
        let cfg = DjConfig::default();
        assert!(d.speak(&cfg, "Hi").await.is_err());
        let schema = serde_json::json!({ "type": "object" });
        assert!(d.generate(&cfg, &[], Some(&schema), None, 10).await.is_err());
    }

    #[tokio::test]
    async fn waits_for_downloads_before_running_anything() {
        let d = dj();
        if d.runtime.is_none() {
            return;
        }
        let cfg = DjConfig { enabled: true, ..DjConfig::default() };
        match d.speak(&cfg, "Hi").await {
            Err(AppError::Other(m)) => assert!(m.contains("downloading"), "{m}"),
            other => panic!("{other:?}"),
        }
        match d.warm(&cfg).await {
            Err(AppError::Other(m)) => assert!(m.contains("downloading"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn removing_the_djs_files_forgets_its_song_look_ups() {
        let d = dj();
        d.songs.keep(&SongInfo { uri: "spotify:track:a".into(), ..Default::default() }, true);
        d.remove().await.unwrap();
        assert_eq!(d.songs.kept("spotify:track:a"), None);
    }

    #[tokio::test]
    async fn removing_with_nothing_downloaded_is_fine() {
        let d = dj();
        d.remove().await.unwrap();
        assert_eq!(d.status(&DjConfig::default()).disk_bytes, 0);
    }

    #[test]
    fn keeps_the_last_few_lines() {
        let d = dj();
        for i in 0..(SPEECH_KEPT as u64 + 3) {
            let mut kept = d.speech.lock().unwrap();
            if kept.len() >= SPEECH_KEPT {
                kept.pop_front();
            }
            kept.push_back((i, Arc::new(vec![i as u8])));
        }
        assert!(d.speech_audio(0).is_none());
        assert_eq!(d.speech_audio(SPEECH_KEPT as u64 + 2).as_deref(), Some(&vec![(SPEECH_KEPT + 2) as u8]));
    }
}
