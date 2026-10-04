//! The AI DJ's backend. The DJ itself (picking songs from the user's listening, timing its talk around
//! lyrics, captions) lives in the UI (`src/lib/dj.svelte.ts`); this side owns what has to run natively:
//!
//! - downloading the runtimes, model and voice, only once the DJ is turned on (`install.rs`),
//! - the language model, run locally by llama.cpp or on the user's own server (`engine.rs`),
//! - the voice, sherpa-onnx text-to-speech (`voice.rs`), played on this computer's audio output (`speaker.rs`).
//!
//! Everything lives in `<app data>/dj/`; removing the DJ deletes that folder.

pub mod engine;
pub mod install;
pub mod manifest;
pub mod speaker;
pub mod voice;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, Result};
use engine::{Engine, Message, Target};
use manifest::{Component, Runtime, OWN_SERVER};
use speaker::{Cmd, Speaker, VoiceCommand};
use voice::Speech;

/// The DJ's settings, part of `config.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DjConfig {
    /// Off until the user turns it on; nothing is downloaded before.
    pub enabled: bool,
    /// A `manifest::MODELS` id, or `"own"` for the server below.
    pub model: String,
    /// A `manifest::VOICES` id.
    pub voice: String,
    /// The user's own OpenAI-compatible server (Ollama, LM Studio, llama.cpp…), with model `"own"`.
    pub server_url: String,
    /// The model name that server knows.
    pub server_model: String,
}

impl Default for DjConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            model: manifest::DEFAULT_MODEL.into(),
            voice: manifest::DEFAULT_VOICE.into(),
            server_url: "http://127.0.0.1:11434".into(),
            server_model: String::new(),
        }
    }
}

/// A settings change from the UI; missing fields stay as they are.
#[derive(Debug, Default, Deserialize)]
pub struct DjSettingsInput {
    pub enabled: Option<bool>,
    pub model: Option<String>,
    pub voice: Option<String>,
    pub server_url: Option<String>,
    pub server_model: Option<String>,
}

impl DjConfig {
    /// Applies a change, refusing ids this build doesn't know.
    pub fn apply(&mut self, input: DjSettingsInput) -> Result<()> {
        if let Some(m) = input.model {
            if m != OWN_SERVER && manifest::model(&m).is_none() {
                return Err(AppError::Other(format!("Unknown DJ model {m}")));
            }
            self.model = m;
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
        if let Some(on) = input.enabled {
            self.enabled = on;
        }
        Ok(())
    }

    fn own_server(&self) -> bool {
        self.model == OWN_SERVER
    }

    /// What's missing from the own-server settings, if they're in use; servers refuse a request without
    /// a model name.
    fn server_problem(&self) -> Option<String> {
        if !self.own_server() {
            return None;
        }
        if let Err(e) = engine::chat_url(&self.server_url) {
            return Some(e.to_string());
        }
        self.server_model.trim().is_empty().then(|| "Enter the model name your server uses".to_owned())
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
    /// What the own-server settings still need, if anything.
    pub setup: Option<String>,
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
}

impl Dj {
    pub fn new(root: PathBuf, scratch: PathBuf, http: reqwest::Client) -> Self {
        Self {
            root,
            scratch,
            http,
            runtime: manifest::this_runtime(),
            install: Arc::default(),
            generation: Arc::default(),
            installing: Arc::default(),
            engine: Arc::default(),
            speech: Mutex::default(),
            next_speech: AtomicU64::new(1),
            speaker: Speaker::default(),
        }
    }

    /// The downloads `cfg` needs, smallest first so the voice can be checked before the model is in.
    fn needed(&self, cfg: &DjConfig) -> Vec<Component> {
        let Some(rt) = self.runtime else { return Vec::new() };
        let mut list = vec![rt.tts];
        if let Some(v) = manifest::voice(&cfg.voice) {
            list.push(v.component);
        }
        if !cfg.own_server() {
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
        let setup = cfg.server_problem();
        DjStatus {
            supported: self.runtime.is_some(),
            settings: cfg.clone(),
            ready: self.runtime.is_some() && setup.is_none() && needed.iter().all(|n| n.installed),
            setup,
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
        if let Some(problem) = cfg.server_problem() {
            return Err(AppError::Other(problem));
        }
        if cfg.own_server() {
            return Ok(Target {
                url: engine::chat_url(&cfg.server_url)?,
                key: None,
                model: cfg.server_model.clone(),
                local: false,
            });
        }
        let rt = self.runtime.ok_or_else(|| AppError::Other("The DJ can't run on this computer".into()))?;
        let model = manifest::model(&cfg.model).ok_or_else(|| AppError::Other("Pick a model for the DJ".into()))?;
        let server = install::find(&self.installed_dir(&rt.llm)?, manifest::LLAMA_SERVER, 2).ok_or_else(|| {
            AppError::Other("The DJ's model runtime is incomplete. Remove the DJ's files and turn it on again.".into())
        })?;
        let file = model.component.url.rsplit('/').next().unwrap_or_default();
        let weights = self.installed_dir(&model.component)?.join(file);
        tokio::fs::create_dir_all(&self.scratch).await?;
        self.engine.local(&server, &weights, &self.scratch.join("llama-server.log")).await
    }

    /// Loads the model ahead of the first request, so the DJ starts sooner.
    pub async fn warm(&self, cfg: &DjConfig) -> Result<()> {
        self.target(cfg).await.map(|_| ())
    }

    pub async fn generate(
        &self,
        cfg: &DjConfig,
        messages: &[Message],
        schema: Option<&Value>,
        max_tokens: u32,
    ) -> Result<Value> {
        let target = self.target(cfg).await?;
        self.engine.touch();
        let answer = engine::chat(&self.http, &target, messages, schema, max_tokens).await;
        self.engine.touch();
        answer
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
        Dj::new(root.join("dj"), root.join("cache"), reqwest::Client::new())
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
        c.apply(DjSettingsInput {
            enabled: Some(true),
            model: Some(OWN_SERVER.into()),
            voice: Some("emma".into()),
            server_url: Some(" http://localhost:1234 ".into()),
            server_model: Some(" qwen ".into()),
        })
        .unwrap();
        assert!(c.enabled && c.own_server());
        assert_eq!(c.voice, "emma");
        assert_eq!(c.server_url, "http://localhost:1234");
        assert_eq!(c.server_model, "qwen");
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
        let own = DjConfig { model: OWN_SERVER.into(), ..cfg };
        assert_eq!(ids(&own), vec![rt.tts.id, voice]);
    }

    #[test]
    fn an_own_server_needs_an_address_and_a_model_name() {
        let d = dj();
        let own = DjConfig {
            model: OWN_SERVER.into(),
            server_url: "http://127.0.0.1:11434".into(),
            ..DjConfig::default()
        };
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
        let cfg = DjConfig { enabled: true, model: OWN_SERVER.into(), ..DjConfig::default() };
        match d.generate(&cfg, &[], None, 10).await {
            Err(AppError::Other(m)) => assert!(m.contains("model name"), "{m}"),
            other => panic!("{other:?}"),
        }
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
        assert!(d.generate(&cfg, &[], None, 10).await.is_err());
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
