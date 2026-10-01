//! The in-process Spotify Connect device, built on librespot.
//!
//! Once running, the device appears in every Spotify client (and in the Web API's
//! `/me/player/devices`), so the UI selects music through the Web API and this
//! device does the actual streaming and audio output.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use librespot_connect::{ConnectConfig, Spirc};
use librespot_core::authentication::Credentials;
use librespot_core::cache::Cache;
use librespot_core::config::{DeviceType, SessionConfig};
use librespot_core::session::Session;
use librespot_core::{Error as LibrespotError, ErrorKind};
use librespot_playback::audio_backend;
use librespot_playback::config::{AudioFormat, Bitrate, PlayerConfig};
use librespot_playback::mixer::{self, MixerConfig};
use librespot_playback::player::{Player, PlayerEvent};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::auth::{self, LIBRESPOT_REDIRECT};
use crate::config::{Config, Paths};
use crate::error::{AppError, Result};

const AUDIO_CACHE_LIMIT: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceState {
    /// Not started yet.
    Offline,
    /// No cached librespot credentials; the user must sign in for playback.
    NeedsLogin,
    Connecting,
    Ready,
    /// Failed; the supervisor keeps retrying in the background.
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceStatus {
    pub state: DeviceState,
    pub device_id: String,
    pub name: String,
    pub error: Option<String>,
}

/// Transport commands executed directly on the local device (no Web API round-trip).
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum DeviceCommand {
    Play,
    Pause,
    PlayPause,
    Next,
    Prev,
    Seek { position_ms: u32 },
    /// 0-100.
    Volume { percent: u8 },
    Shuffle { on: bool },
    /// "off" | "context" | "track"
    Repeat { mode: String },
}

/// Local player events forwarded to the UI as `local-player`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LocalEvent {
    Playing { uri: String, position_ms: u32 },
    Paused { uri: String, position_ms: u32 },
    Loading { uri: String, position_ms: u32 },
    Seeked { uri: String, position_ms: u32 },
    Stopped { uri: String },
    EndOfTrack { uri: String },
    Unavailable { uri: String },
    Track {
        uri: String,
        name: String,
        artists: Vec<ArtistRef>,
        album: String,
        cover: Option<String>,
        duration_ms: u32,
        explicit: bool,
    },
    Volume { percent: u8 },
    Shuffle { on: bool },
    Repeat { context: bool, track: bool },
    SessionConnected,
    SessionDisconnected,
}

#[derive(Debug, Clone, Serialize)]
struct ArtistRef {
    uri: String,
    name: String,
}

pub struct ConnectDevice {
    paths: Paths,
    http: reqwest::Client,
    spirc: Mutex<Option<Spirc>>,
    status: Mutex<DeviceStatus>,
    /// Bumped on every start/stop so stale supervisors exit.
    generation: AtomicU64,
}

impl ConnectDevice {
    pub fn new(paths: Paths, http: reqwest::Client, config: &Config) -> Self {
        Self {
            paths,
            http,
            spirc: Mutex::new(None),
            status: Mutex::new(DeviceStatus {
                state: DeviceState::Offline,
                device_id: config.device_id.clone(),
                name: config.device_name.clone(),
                error: None,
            }),
            generation: AtomicU64::new(0),
        }
    }

    pub fn status(&self) -> DeviceStatus {
        self.status.lock().unwrap().clone()
    }

    fn set_status(&self, app: &AppHandle, state: DeviceState, error: Option<String>) {
        let status = {
            let mut s = self.status.lock().unwrap();
            s.state = state;
            s.error = error;
            s.clone()
        };
        let _ = app.emit("device-status", status);
    }

    pub fn mark(&self, app: &AppHandle, state: DeviceState) {
        self.set_status(app, state, None);
    }

    fn cache(&self) -> Result<Cache> {
        Cache::new(
            Some(&self.paths.librespot_dir),
            Some(&self.paths.librespot_dir),
            Some(&self.paths.audio_cache_dir),
            Some(AUDIO_CACHE_LIMIT),
        )
        .map_err(|e| AppError::Device(e.to_string()))
    }

    pub fn has_credentials(&self) -> bool {
        self.cache().ok().and_then(|c| c.credentials()).is_some()
    }

    /// Browser sign-in with librespot's client ID. The resulting credentials are
    /// exchanged for reusable stored credentials on first connect and cached.
    pub async fn sign_in(&self, app: &AppHandle, cancel: oneshot::Receiver<()>) -> Result<Credentials> {
        let client_id = SessionConfig::default().client_id;
        let token =
            auth::authorize(app, &self.http, &client_id, &LIBRESPOT_REDIRECT, &["streaming"], cancel).await?;
        Ok(Credentials::with_access_token(token.access_token))
    }

    pub fn forget_credentials(&self) {
        let _ = std::fs::remove_file(self.paths.librespot_dir.join("credentials.json"));
    }

    /// Starts (or restarts) the device. Uses `credentials` if given, else cached ones.
    pub fn start(self: &Arc<Self>, app: AppHandle, config: Config, credentials: Option<Credentials>) {
        self.stop();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut s = self.status.lock().unwrap();
            s.device_id = config.device_id.clone();
            s.name = config.device_name.clone();
        }

        let cache = match self.cache() {
            Ok(c) => c,
            Err(e) => return self.set_status(&app, DeviceState::Error, Some(e.to_string())),
        };
        let Some(credentials) = credentials.or_else(|| cache.credentials()) else {
            return self.set_status(&app, DeviceState::NeedsLogin, None);
        };

        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            this.supervise(app, config, cache, credentials, generation).await;
        });
    }

    /// Keeps the device alive: reconnects with backoff whenever the Spirc task ends
    /// (network loss, session expiry) until stopped or credentials are rejected.
    async fn supervise(
        self: Arc<Self>,
        app: AppHandle,
        config: Config,
        cache: Cache,
        mut credentials: Credentials,
        generation: u64,
    ) {
        let mut backoff = Duration::from_secs(2);
        while self.generation.load(Ordering::SeqCst) == generation {
            self.set_status(&app, DeviceState::Connecting, None);
            let started = Instant::now();

            match self.run_once(&app, &config, cache.clone(), credentials.clone(), generation).await {
                Ok(()) => {}
                Err(e) if e.kind == ErrorKind::PermissionDenied => {
                    log::warn!("librespot rejected credentials: {e}");
                    self.forget_credentials();
                    self.set_status(&app, DeviceState::NeedsLogin, Some(e.to_string()));
                    return;
                }
                Err(e) => {
                    log::error!("Connect device error: {e}");
                    self.set_status(&app, DeviceState::Error, Some(e.to_string()));
                }
            }

            if self.generation.load(Ordering::SeqCst) != generation {
                break;
            }
            // After the first successful connect the cache holds reusable credentials;
            // prefer them over a one-shot OAuth access token.
            if let Some(stored) = cache.credentials() {
                credentials = stored;
            }
            if started.elapsed() > Duration::from_secs(60) {
                backoff = Duration::from_secs(2);
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    }

    async fn run_once(
        &self,
        app: &AppHandle,
        config: &Config,
        cache: Cache,
        credentials: Credentials,
        generation: u64,
    ) -> std::result::Result<(), LibrespotError> {
        let session_config = SessionConfig {
            device_id: config.device_id.clone(),
            ..SessionConfig::default()
        };
        let player_config = PlayerConfig {
            bitrate: match config.bitrate {
                96 => Bitrate::Bitrate96,
                160 => Bitrate::Bitrate160,
                _ => Bitrate::Bitrate320,
            },
            normalisation: config.normalisation,
            ..PlayerConfig::default()
        };
        let connect_config = ConnectConfig {
            name: config.device_name.clone(),
            device_type: DeviceType::Computer,
            initial_volume: (u32::from(config.initial_volume.min(100)) * u32::from(u16::MAX) / 100) as u16,
            ..ConnectConfig::default()
        };

        let sink_builder = audio_backend::find(None)
            .ok_or_else(|| LibrespotError::unavailable("no audio backend compiled in"))?;
        let mixer_builder =
            mixer::find(None).ok_or_else(|| LibrespotError::unavailable("no mixer compiled in"))?;

        let session = Session::new(session_config, Some(cache));
        let mixer = mixer_builder(MixerConfig::default())?;
        let player = Player::new(player_config, session.clone(), mixer.get_soft_volume(), move || {
            sink_builder(None, AudioFormat::default())
        });

        let events = player.get_player_event_channel();
        tauri::async_runtime::spawn(forward_events(app.clone(), events));

        let (spirc, task) = Spirc::new(connect_config, session.clone(), credentials, player, mixer).await?;

        if self.generation.load(Ordering::SeqCst) != generation {
            let _ = spirc.shutdown();
            return Ok(());
        }
        *self.spirc.lock().unwrap() = Some(spirc);
        {
            let mut s = self.status.lock().unwrap();
            s.device_id = session.device_id().to_owned();
        }
        self.set_status(app, DeviceState::Ready, None);

        task.await;

        self.spirc.lock().unwrap().take();
        Ok(())
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(spirc) = self.spirc.lock().unwrap().take() {
            let _ = spirc.shutdown();
        }
    }

    pub fn command(&self, cmd: DeviceCommand) -> Result<()> {
        let guard = self.spirc.lock().unwrap();
        let spirc = guard
            .as_ref()
            .ok_or_else(|| AppError::Device("the playback device isn't running".into()))?;
        let r = match cmd {
            DeviceCommand::Play => spirc.play(),
            DeviceCommand::Pause => spirc.pause(),
            DeviceCommand::PlayPause => spirc.play_pause(),
            DeviceCommand::Next => spirc.next(),
            DeviceCommand::Prev => spirc.prev(),
            DeviceCommand::Seek { position_ms } => spirc.set_position_ms(position_ms),
            DeviceCommand::Volume { percent } => {
                spirc.set_volume((u32::from(percent.min(100)) * u32::from(u16::MAX) / 100) as u16)
            }
            DeviceCommand::Shuffle { on } => spirc.shuffle(on),
            DeviceCommand::Repeat { mode } => match mode.as_str() {
                "track" => spirc.repeat(true).and_then(|_| spirc.repeat_track(true)),
                "context" => spirc.repeat_track(false).and_then(|_| spirc.repeat(true)),
                _ => spirc.repeat_track(false).and_then(|_| spirc.repeat(false)),
            },
        };
        r.map_err(|e| AppError::Device(e.to_string()))
    }
}

async fn forward_events(app: AppHandle, mut events: librespot_playback::player::PlayerEventChannel) {
    while let Some(event) = events.recv().await {
        if let Some(ev) = to_local_event(event) {
            let _ = app.emit("local-player", ev);
        }
    }
}

fn to_local_event(event: PlayerEvent) -> Option<LocalEvent> {
    use librespot_metadata::audio::UniqueFields;
    Some(match event {
        PlayerEvent::Playing { track_id, position_ms, .. } => {
            LocalEvent::Playing { uri: track_id.to_uri(), position_ms }
        }
        PlayerEvent::Paused { track_id, position_ms, .. } => {
            LocalEvent::Paused { uri: track_id.to_uri(), position_ms }
        }
        PlayerEvent::Loading { track_id, position_ms, .. } => {
            LocalEvent::Loading { uri: track_id.to_uri(), position_ms }
        }
        PlayerEvent::Seeked { track_id, position_ms, .. }
        | PlayerEvent::PositionCorrection { track_id, position_ms, .. } => {
            LocalEvent::Seeked { uri: track_id.to_uri(), position_ms }
        }
        PlayerEvent::Stopped { track_id, .. } => LocalEvent::Stopped { uri: track_id.to_uri() },
        PlayerEvent::EndOfTrack { track_id, .. } => LocalEvent::EndOfTrack { uri: track_id.to_uri() },
        PlayerEvent::Unavailable { track_id, .. } => LocalEvent::Unavailable { uri: track_id.to_uri() },
        PlayerEvent::TrackChanged { audio_item } => {
            let cover = audio_item.covers.iter().max_by_key(|c| c.width).map(|c| c.url.clone());
            let (artists, album) = match &audio_item.unique_fields {
                UniqueFields::Track { artists, album, .. } => (
                    artists
                        .iter()
                        .map(|a| ArtistRef { uri: a.id.to_uri(), name: a.name.clone() })
                        .collect(),
                    album.clone(),
                ),
                UniqueFields::Episode { show_name, .. } => (Vec::new(), show_name.clone()),
                UniqueFields::Local { artists, album, .. } => (
                    artists
                        .iter()
                        .map(|a| ArtistRef { uri: String::new(), name: a.clone() })
                        .collect(),
                    album.clone().unwrap_or_default(),
                ),
            };
            LocalEvent::Track {
                uri: audio_item.uri.clone(),
                name: audio_item.name.clone(),
                artists,
                album,
                cover,
                duration_ms: audio_item.duration_ms,
                explicit: audio_item.is_explicit,
            }
        }
        PlayerEvent::VolumeChanged { volume } => LocalEvent::Volume {
            percent: ((u32::from(volume) * 100 + u32::from(u16::MAX) / 2) / u32::from(u16::MAX)) as u8,
        },
        PlayerEvent::ShuffleChanged { shuffle } => LocalEvent::Shuffle { on: shuffle },
        PlayerEvent::RepeatChanged { context, track } => LocalEvent::Repeat { context, track },
        PlayerEvent::SessionConnected { .. } => LocalEvent::SessionConnected,
        PlayerEvent::SessionDisconnected { .. } => LocalEvent::SessionDisconnected,
        _ => return None,
    })
}
