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
use librespot_core::error::ErrorKind;
use librespot_core::Error as LibrespotError;
use librespot_playback::audio_backend::{self, Sink, SinkResult};
use librespot_playback::config::{AudioFormat, Bitrate, PlayerConfig};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::mixer::{self, MixerConfig};
use librespot_playback::player::{Player, PlayerEvent};
use librespot_playback::SAMPLES_PER_SECOND;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::auth::{self, LIBRESPOT_REDIRECT};
use crate::config::{Config, Paths};
use crate::error::{AppError, Result};
use crate::meter::{Analyser, Meter};

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
    /// The account isn't Premium, which librespot requires. Stopped until restarted.
    PremiumRequired,
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

/// Local player events forwarded to the UI as `local-player`. Positions are what's
/// audible right now, not where the decoder is (see [`OutputClock`]).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LocalEvent {
    Playing { uri: String, position_ms: u32 },
    Paused { uri: String, position_ms: u32 },
    Loading { uri: String, position_ms: u32 },
    Seeked { uri: String, position_ms: u32 },
    /// Periodic position while playing (see `position_update_interval`).
    Position { uri: String, position_ms: u32 },
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
    /// Levels of what's playing, for audio-responsive effects. Outlives restarts.
    meter: Meter,
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
            meter: Meter::default(),
        }
    }

    pub fn meter(&self) -> &Meter {
        &self.meter
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
                Ok(Ended::Normally) => {}
                Ok(Ended::NotPremium(account_type)) => {
                    log::warn!("Spotify account type is {account_type:?}; playback needs Premium");
                    self.set_status(&app, DeviceState::PremiumRequired, None);
                    return;
                }
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
    ) -> std::result::Result<Ended, LibrespotError> {
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
            // Periodic positions let the UI keep its clock locked to the audio.
            position_update_interval: Some(Duration::from_millis(1000)),
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
        let clock = OutputClock::default();
        let sink_clock = clock.clone();
        let meter = self.meter.clone();
        let player = Player::new(player_config, session.clone(), mixer.get_soft_volume(), move || {
            Box::new(ClockedSink {
                inner: sink_builder(None, AudioFormat::default()),
                clock: sink_clock,
                meter,
                analyser: Analyser::default(),
            }) as Box<dyn Sink>
        });

        let events = player.get_player_event_channel();
        tauri::async_runtime::spawn(forward_events(app.clone(), events, clock));

        let started = Spirc::new(connect_config, session.clone(), credentials, player, mixer).await;
        if let Some(account_type) = non_premium(&session) {
            if let Ok((spirc, _)) = started {
                let _ = spirc.shutdown();
            }
            return Ok(Ended::NotPremium(account_type));
        }
        let (spirc, task) = started?;

        if self.generation.load(Ordering::SeqCst) != generation {
            let _ = spirc.shutdown();
            return Ok(Ended::Normally);
        }
        *self.spirc.lock().unwrap() = Some(spirc);
        {
            let mut s = self.status.lock().unwrap();
            s.device_id = session.device_id().to_owned();
        }
        self.set_status(app, DeviceState::Ready, None);

        // Spotify reports the account type shortly after login, possibly after Spirc is up.
        tokio::pin!(task);
        let ended = tokio::select! {
            _ = &mut task => Ended::Normally,
            account_type = wait_for_non_premium(&session) => {
                if let Some(spirc) = self.spirc.lock().unwrap().take() {
                    let _ = spirc.shutdown();
                }
                task.await;
                Ended::NotPremium(account_type)
            }
        };

        self.spirc.lock().unwrap().take();
        Ok(ended)
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
            DeviceCommand::Volume { percent } => spirc.set_volume(volume_from_percent(percent)),
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

/// librespot's mixer volume (0-65535) for a UI percentage, clamped to 100.
fn volume_from_percent(percent: u8) -> u16 {
    (u32::from(percent.min(100)) * u32::from(u16::MAX) / 100) as u16
}

/// The UI percentage for a mixer volume, rounded to the nearest.
fn percent_from_volume(volume: u16) -> u8 {
    ((u32::from(volume) * 100 + u32::from(u16::MAX) / 2) / u32::from(u16::MAX)) as u8
}

/// How a device run ended without a librespot error.
enum Ended {
    /// Stopped, or the connection dropped; the supervisor reconnects if still current.
    Normally,
    /// Spotify reported this account type (e.g. "free"); librespot can't play for it.
    NotPremium(String),
}

/// The account type, if Spotify has reported one other than Premium. Our patched
/// librespot-core stores it instead of exiting (see vendor/librespot-core/PATCHED.md).
fn non_premium(session: &Session) -> Option<String> {
    session.get_user_attribute("type").filter(|t| t != "premium")
}

async fn wait_for_non_premium(session: &Session) -> String {
    loop {
        if let Some(account_type) = non_premium(session) {
            return account_type;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Tracks how far the speakers run behind the decoder.
///
/// librespot reports decoder positions, but the rodio output keeps ~27 packets
/// queued ahead of the speakers. Packet sizes vary, so that's anywhere from under
/// 100 ms to over half a second of audio. Seeks and track changes don't flush the
/// queue; pausing plays it out first. Knowing when everything written so far will
/// have finished playing turns a decoder position into the audible one.
#[derive(Clone, Default)]
struct OutputClock(Arc<Mutex<ClockState>>);

#[derive(Default)]
struct ClockState {
    /// When everything written so far will have been played.
    until: Option<Instant>,
    /// When writing last started into an empty queue.
    refill_from: Option<Instant>,
}

/// After starting from an empty queue the player decodes a full queue's worth in a
/// burst. Events reported just before that burst can reach us after it, so within
/// this long of a refill they're taken to describe the empty queue.
const REFILL_WINDOW: Duration = Duration::from_millis(200);

impl OutputClock {
    /// Notes `audio` written to the output; returns when it will start playing.
    fn queued(&self, audio: Duration) -> Instant {
        self.queued_at(Instant::now(), audio)
    }

    fn queued_at(&self, now: Instant, audio: Duration) -> Instant {
        let mut s = self.0.lock().unwrap();
        let until = match s.until {
            Some(u) if u > now => u,
            _ => {
                s.refill_from = Some(now);
                now
            }
        };
        s.until = Some(until + audio);
        until
    }

    fn drained(&self) {
        self.0.lock().unwrap().until = None;
    }

    fn heard(&self, decoder_ms: u32) -> u32 {
        self.heard_at(Instant::now(), decoder_ms)
    }

    fn heard_at(&self, now: Instant, decoder_ms: u32) -> u32 {
        let s = self.0.lock().unwrap();
        if let Some(from) = s.refill_from.filter(|f| now.duration_since(*f) < REFILL_WINDOW) {
            return decoder_ms + now.duration_since(from).as_millis() as u32;
        }
        let ahead = s.until.map_or(Duration::ZERO, |u| u.saturating_duration_since(now));
        decoder_ms.saturating_sub(ahead.as_millis() as u32)
    }
}

/// Passes audio through to the real output while keeping an [`OutputClock`], and measures it
/// for the [`Meter`] when that's on.
struct ClockedSink {
    inner: Box<dyn Sink>,
    clock: OutputClock,
    meter: Meter,
    analyser: Analyser,
}

impl Sink for ClockedSink {
    fn start(&mut self) -> SinkResult<()> {
        self.inner.start()
    }

    fn stop(&mut self) -> SinkResult<()> {
        // The rodio sink plays out everything queued before it pauses.
        let r = self.inner.stop();
        self.clock.drained();
        r
    }

    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        if let Ok(samples) = packet.samples() {
            let starts = self.clock.queued(Duration::from_secs_f64(samples.len() as f64 / f64::from(SAMPLES_PER_SECOND)));
            if self.meter.is_on() {
                self.meter.record(starts, self.analyser.measure(samples));
            }
        }
        self.inner.write(packet, converter)
    }
}

async fn forward_events(
    app: AppHandle,
    mut events: librespot_playback::player::PlayerEventChannel,
    clock: OutputClock,
) {
    while let Some(event) = events.recv().await {
        if let Some(ev) = to_local_event(event, &clock) {
            let _ = app.emit("local-player", ev);
        }
    }
}

fn to_local_event(event: PlayerEvent, clock: &OutputClock) -> Option<LocalEvent> {
    use librespot_metadata::audio::UniqueFields;
    Some(match event {
        PlayerEvent::Playing { track_id, position_ms, .. } => {
            LocalEvent::Playing { uri: track_id.to_uri(), position_ms: clock.heard(position_ms) }
        }
        PlayerEvent::Paused { track_id, position_ms, .. } => {
            LocalEvent::Paused { uri: track_id.to_uri(), position_ms: clock.heard(position_ms) }
        }
        PlayerEvent::Loading { track_id, position_ms, .. } => {
            LocalEvent::Loading { uri: track_id.to_uri(), position_ms: clock.heard(position_ms) }
        }
        PlayerEvent::Seeked { track_id, position_ms, .. } => {
            LocalEvent::Seeked { uri: track_id.to_uri(), position_ms: clock.heard(position_ms) }
        }
        PlayerEvent::PositionCorrection { track_id, position_ms, .. }
        | PlayerEvent::PositionChanged { track_id, position_ms, .. } => {
            LocalEvent::Position { uri: track_id.to_uri(), position_ms: clock.heard(position_ms) }
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
            percent: percent_from_volume(volume),
        },
        PlayerEvent::ShuffleChanged { shuffle } => LocalEvent::Shuffle { on: shuffle },
        PlayerEvent::RepeatChanged { context, track } => LocalEvent::Repeat { context, track },
        PlayerEvent::SessionConnected { .. } => LocalEvent::SessionConnected,
        PlayerEvent::SessionDisconnected { .. } => LocalEvent::SessionDisconnected,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use librespot_core::SpotifyUri;
    use serde_json::{json, Value};

    use super::*;

    const TRACK: &str = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    // ---- volume ----------------------------------------------------------------

    #[test]
    fn volume_covers_the_full_mixer_range() {
        assert_eq!(volume_from_percent(0), 0);
        assert_eq!(volume_from_percent(100), u16::MAX);
        assert_eq!(volume_from_percent(255), u16::MAX);
        assert_eq!(percent_from_volume(0), 0);
        assert_eq!(percent_from_volume(u16::MAX), 100);
    }

    #[test]
    fn volume_survives_a_round_trip_through_librespot() {
        for p in 0..=100 {
            assert_eq!(percent_from_volume(volume_from_percent(p)), p, "{p}%");
        }
    }

    #[test]
    fn volume_rounds_to_the_nearest_percent() {
        // Half a percent of the mixer range is 327.675.
        assert_eq!(percent_from_volume(327), 0);
        assert_eq!(percent_from_volume(328), 1);
        assert_eq!(percent_from_volume(u16::MAX / 2), 50);
    }

    // ---- output clock ----------------------------------------------------------

    #[test]
    fn nothing_queued_means_the_decoder_is_audible() {
        assert_eq!(OutputClock::default().heard(1000), 1000);
    }

    #[test]
    fn audio_still_queued_hasnt_been_heard_yet() {
        let t0 = Instant::now();
        let clock = OutputClock::default();
        clock.queued_at(t0, ms(500));
        // Past the refill window, 200 ms of the 500 queued is still ahead of the speakers.
        assert_eq!(clock.heard_at(t0 + ms(300), 10_000), 9_800);
        assert_eq!(clock.heard_at(t0 + ms(450), 10_000), 9_950);
        assert_eq!(clock.heard_at(t0 + ms(600), 10_000), 10_000);
    }

    #[test]
    fn packets_queue_behind_each_other() {
        let t0 = Instant::now();
        let clock = OutputClock::default();
        clock.queued_at(t0, ms(300));
        clock.queued_at(t0 + ms(100), ms(300));
        clock.queued_at(t0 + ms(150), ms(300));
        assert_eq!(clock.heard_at(t0 + ms(400), 5_000), 4_500);
    }

    #[test]
    fn a_packet_starts_playing_when_the_ones_before_it_end() {
        let t0 = Instant::now();
        let clock = OutputClock::default();
        assert_eq!(clock.queued_at(t0, ms(300)), t0);
        assert_eq!(clock.queued_at(t0 + ms(100), ms(300)), t0 + ms(300));
        // Once the queue has run dry, a packet plays as soon as it's written.
        assert_eq!(clock.queued_at(t0 + ms(1_000), ms(300)), t0 + ms(1_000));
    }

    #[test]
    fn events_just_after_a_refill_describe_the_empty_queue() {
        let t0 = Instant::now();
        let clock = OutputClock::default();
        // Starting from silence the player decodes a burst, but the event that started it
        // was reported against the empty queue: playback has only advanced by the time since.
        clock.queued_at(t0, ms(100));
        clock.queued_at(t0 + ms(5), ms(400));
        assert_eq!(clock.heard_at(t0 + ms(50), 2_000), 2_050);
        assert_eq!(clock.heard_at(t0 + ms(199), 2_000), 2_199);
        // After the window, the queue counts.
        assert_eq!(clock.heard_at(t0 + ms(200), 2_000), 1_700);
    }

    #[test]
    fn a_queue_that_ran_dry_starts_a_new_refill() {
        let t0 = Instant::now();
        let clock = OutputClock::default();
        clock.queued_at(t0, ms(100));
        // Underrun: nothing written until well after the queue emptied.
        clock.queued_at(t0 + ms(1_000), ms(300));
        assert_eq!(clock.heard_at(t0 + ms(1_100), 7_000), 7_100);
        assert_eq!(clock.heard_at(t0 + ms(1_250), 7_000), 6_950);
    }

    #[test]
    fn a_drained_queue_is_all_heard() {
        let t0 = Instant::now();
        let clock = OutputClock::default();
        clock.queued_at(t0, ms(800));
        clock.drained();
        assert_eq!(clock.heard_at(t0 + ms(300), 4_000), 4_000);
    }

    #[test]
    fn never_reports_a_negative_position() {
        let t0 = Instant::now();
        let clock = OutputClock::default();
        clock.queued_at(t0, ms(600));
        assert_eq!(clock.heard_at(t0 + ms(250), 100), 0);
    }

    // ---- IPC contract (ipc.ts) -------------------------------------------------

    fn command(v: Value) -> DeviceCommand {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn reads_every_command_the_ui_sends() {
        assert!(matches!(command(json!({ "action": "play" })), DeviceCommand::Play));
        assert!(matches!(command(json!({ "action": "pause" })), DeviceCommand::Pause));
        assert!(matches!(command(json!({ "action": "play_pause" })), DeviceCommand::PlayPause));
        assert!(matches!(command(json!({ "action": "next" })), DeviceCommand::Next));
        assert!(matches!(command(json!({ "action": "prev" })), DeviceCommand::Prev));
        assert!(matches!(
            command(json!({ "action": "seek", "position_ms": 1234 })),
            DeviceCommand::Seek { position_ms: 1234 }
        ));
        assert!(matches!(command(json!({ "action": "volume", "percent": 43 })), DeviceCommand::Volume { percent: 43 }));
        assert!(matches!(command(json!({ "action": "shuffle", "on": true })), DeviceCommand::Shuffle { on: true }));
        assert!(matches!(
            command(json!({ "action": "repeat", "mode": "context" })),
            DeviceCommand::Repeat { mode } if mode == "context"
        ));
    }

    #[test]
    fn rejects_malformed_commands() {
        for v in [
            json!({ "action": "rewind" }),
            json!({ "action": "seek" }),
            json!({ "action": "seek", "position_ms": -1 }),
            json!({ "action": "volume", "percent": 300 }),
            json!({ "percent": 30 }),
        ] {
            assert!(serde_json::from_value::<DeviceCommand>(v.clone()).is_err(), "{v}");
        }
    }

    #[test]
    fn device_states_match_the_ui() {
        let states = [
            (DeviceState::Offline, "offline"),
            (DeviceState::NeedsLogin, "needs_login"),
            (DeviceState::Connecting, "connecting"),
            (DeviceState::Ready, "ready"),
            (DeviceState::PremiumRequired, "premium_required"),
            (DeviceState::Error, "error"),
        ];
        for (state, name) in states {
            assert_eq!(serde_json::to_value(state).unwrap(), name);
        }
    }

    fn uri() -> SpotifyUri {
        SpotifyUri::from_uri(TRACK).unwrap()
    }

    fn local(event: PlayerEvent) -> Value {
        serde_json::to_value(to_local_event(event, &OutputClock::default()).expect("forwarded")).unwrap()
    }

    #[test]
    fn forwards_player_events_in_the_shape_the_ui_reads() {
        assert_eq!(
            local(PlayerEvent::Playing { play_request_id: 1, track_id: uri(), position_ms: 1500 }),
            json!({ "type": "playing", "uri": TRACK, "position_ms": 1500 })
        );
        assert_eq!(
            local(PlayerEvent::PositionChanged { play_request_id: 1, track_id: uri(), position_ms: 9 }),
            json!({ "type": "position", "uri": TRACK, "position_ms": 9 })
        );
        assert_eq!(
            local(PlayerEvent::PositionCorrection { play_request_id: 1, track_id: uri(), position_ms: 9 }),
            json!({ "type": "position", "uri": TRACK, "position_ms": 9 })
        );
        assert_eq!(
            local(PlayerEvent::EndOfTrack { play_request_id: 1, track_id: uri() }),
            json!({ "type": "end_of_track", "uri": TRACK })
        );
        assert_eq!(local(PlayerEvent::VolumeChanged { volume: u16::MAX }), json!({ "type": "volume", "percent": 100 }));
        assert_eq!(
            local(PlayerEvent::RepeatChanged { context: true, track: false }),
            json!({ "type": "repeat", "context": true, "track": false })
        );
        assert_eq!(local(PlayerEvent::ShuffleChanged { shuffle: true }), json!({ "type": "shuffle", "on": true }));
    }

    #[test]
    fn reports_positions_as_heard() {
        let clock = OutputClock::default();
        clock.queued_at(Instant::now() - ms(1_000), ms(10_000));
        let event = PlayerEvent::Seeked { play_request_id: 1, track_id: uri(), position_ms: 30_000 };
        let Some(LocalEvent::Seeked { position_ms, .. }) = to_local_event(event, &clock) else {
            panic!("expected a seek");
        };
        // At most 9 s of audio is still queued ahead of the speakers (less as the test runs).
        assert!((21_000..21_500).contains(&position_ms), "{position_ms}");
    }

    #[test]
    fn drops_events_the_ui_has_no_use_for() {
        let event = PlayerEvent::TimeToPreloadNextTrack { play_request_id: 1, track_id: uri() };
        assert!(to_local_event(event, &OutputClock::default()).is_none());
    }
}
