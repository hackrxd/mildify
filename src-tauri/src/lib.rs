mod auth;
mod config;
mod device;
mod error;
mod lyrics;
mod webapi;

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, RunEvent, State};
use tokio::sync::oneshot;

use config::{Config, Paths};
use device::{ConnectDevice, DeviceCommand, DeviceState, DeviceStatus};
use error::{AppError, Result};
use lyrics::LyricsClient;
use webapi::WebApi;

struct AppState {
    config: Mutex<Config>,
    paths: Paths,
    webapi: WebApi,
    device: Arc<ConnectDevice>,
    lyrics: LyricsClient,
    /// Cancels the browser sign-in currently waiting for its redirect, if any.
    sign_in_cancel: Mutex<Option<oneshot::Sender<()>>>,
}

impl AppState {
    fn config(&self) -> Config {
        self.config.lock().unwrap().clone()
    }

    fn cancel_channel(&self) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        *self.sign_in_cancel.lock().unwrap() = Some(tx);
        rx
    }

    /// Where lyrics come from: the lyrics server if one is set, else a Spicy Lyrics
    /// key from Settings, else one from the environment. Returns the server URL or key,
    /// plus a label for the UI.
    fn lyrics_source(&self) -> Option<(LyricsSource, &'static str)> {
        let cfg = self.config.lock().unwrap();
        if let Some(url) = cfg.lyrics_server_url.clone() {
            return Some((LyricsSource::Server(url), "server"));
        }
        cfg.spicy_lyrics_key
            .clone()
            .map(|k| (LyricsSource::Key(k), "settings"))
            .or_else(|| LyricsClient::env_key().map(|k| (LyricsSource::Key(k), "environment")))
    }

    async fn status(&self) -> AppStatus {
        let mut config = self.config();
        // The key is a secret: report only where lyrics come from.
        config.spicy_lyrics_key = None;
        let lyrics_source = self.lyrics_source().map(|(_, label)| label);
        let signed_in = match &config.client_id {
            Some(id) => self.webapi.is_signed_in(id).await,
            None => false,
        };
        AppStatus {
            redirect_uri: auth::WEBAPI_REDIRECT.uri(),
            signed_in,
            device: self.device.status(),
            lyrics_source,
            config,
        }
    }
}

#[derive(Serialize)]
struct AppStatus {
    config: Config,
    /// The redirect URI the user must register in their Spotify developer app.
    redirect_uri: String,
    signed_in: bool,
    device: DeviceStatus,
    /// Where lyrics come from: "server", "settings" (API key) or "environment" (API key).
    lyrics_source: Option<&'static str>,
}

enum LyricsSource {
    Server(String),
    Key(String),
}

#[derive(Deserialize)]
struct SettingsInput {
    client_id: Option<String>,
    device_name: Option<String>,
    bitrate: Option<u16>,
    normalisation: Option<bool>,
    /// Empty string clears it.
    spicy_lyrics_key: Option<String>,
    /// Empty string clears it.
    lyrics_server_url: Option<String>,
}

#[tauri::command]
async fn app_status(state: State<'_, AppState>) -> Result<AppStatus> {
    Ok(state.status().await)
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: SettingsInput,
) -> Result<AppStatus> {
    let (old, new) = {
        let mut cfg = state.config.lock().unwrap();
        let old = cfg.clone();
        if let Some(id) = settings.client_id {
            let id = id.trim().to_owned();
            cfg.client_id = (!id.is_empty()).then_some(id);
        }
        if let Some(name) = settings.device_name {
            let name = name.trim().to_owned();
            if !name.is_empty() {
                cfg.device_name = name;
            }
        }
        if let Some(b) = settings.bitrate {
            cfg.bitrate = b;
        }
        if let Some(n) = settings.normalisation {
            cfg.normalisation = n;
        }
        if let Some(key) = settings.spicy_lyrics_key {
            let key = key.trim().to_owned();
            cfg.spicy_lyrics_key = (!key.is_empty()).then_some(key);
        }
        if let Some(url) = settings.lyrics_server_url {
            let url = url.trim().trim_end_matches('/').to_owned();
            if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(AppError::Other("The lyrics server URL must start with http:// or https://".into()));
            }
            cfg.lyrics_server_url = (!url.is_empty()).then_some(url);
        }
        cfg.save(&state.paths.config_file)?;
        (old, cfg.clone())
    };

    if old.client_id != new.client_id {
        state.webapi.sign_out().await;
    }
    if old.lyrics_server_url != new.lyrics_server_url {
        // A token only belongs to the server that issued it.
        state.lyrics.logout().await;
    }
    if old.spicy_lyrics_key != new.spicy_lyrics_key || old.lyrics_server_url != new.lyrics_server_url {
        state.lyrics.clear_cache().await;
    }
    let device_changed = old.device_name != new.device_name
        || old.bitrate != new.bitrate
        || old.normalisation != new.normalisation;
    if device_changed && !matches!(state.device.status().state, DeviceState::Offline | DeviceState::NeedsLogin) {
        state.device.start(app, new, None);
    }
    Ok(state.status().await)
}

/// Signs in to whatever still needs it: first the Web API (user's client ID),
/// then the Connect device (librespot's client ID), then starts the device.
#[tauri::command]
async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<AppStatus> {
    let config = state.config();
    let client_id = config.client_id.clone().ok_or(AppError::NoClientId)?;

    if !state.webapi.is_signed_in(&client_id).await {
        let cancel = state.cancel_channel();
        state.webapi.sign_in(&app, &client_id, cancel).await?;
    }

    if state.device.has_credentials() {
        if !matches!(state.device.status().state, DeviceState::Ready | DeviceState::Connecting) {
            state.device.start(app, config, None);
        }
    } else {
        let cancel = state.cancel_channel();
        let credentials = state.device.sign_in(&app, cancel).await?;
        state.device.start(app, config, Some(credentials));
    }
    Ok(state.status().await)
}

#[tauri::command]
fn cancel_sign_in(state: State<'_, AppState>) {
    if let Some(tx) = state.sign_in_cancel.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

#[tauri::command]
async fn sign_out(app: AppHandle, state: State<'_, AppState>) -> Result<AppStatus> {
    state.webapi.sign_out().await;
    state.device.stop();
    state.device.forget_credentials();
    state.device.mark(&app, DeviceState::Offline);
    Ok(state.status().await)
}

/// Proxies a Spotify Web API request; the access token never reaches the UI.
#[tauri::command]
async fn api(
    state: State<'_, AppState>,
    method: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
) -> Result<Value> {
    state.webapi.request(&method, &path, query, body).await
}

/// Fetches lyrics (Spicy Lyrics v1 response) for a Spotify track id, from the lyrics
/// server or the Spicy Lyrics API. Returns `null` when the track has no lyrics.
#[tauri::command]
async fn spicy_lyrics(state: State<'_, AppState>, track_id: String) -> Result<Value> {
    let (source, _) = state.lyrics_source().ok_or_else(|| {
        AppError::Auth("Lyrics aren't set up. Add a lyrics server or a Spicy Lyrics API key in Settings.".into())
    })?;
    let source = match &source {
        LyricsSource::Server(base) => lyrics::Source::Server { base },
        LyricsSource::Key(key) => lyrics::Source::Direct { key },
    };
    Ok(state.lyrics.get(source, &track_id).await?.unwrap_or(Value::Null))
}

fn lyrics_server_url(state: &AppState) -> Result<String> {
    state
        .config()
        .lyrics_server_url
        .ok_or_else(|| AppError::Other("No lyrics server is set".into()))
}

/// Health and sign-in state of the configured lyrics server (`null` if none is set).
#[tauri::command]
async fn lyrics_server_status(state: State<'_, AppState>) -> Result<Option<lyrics::ServerStatus>> {
    match state.config().lyrics_server_url {
        Some(url) => Ok(Some(state.lyrics.server_status(&url).await)),
        None => Ok(None),
    }
}

/// Signs in to the lyrics server. The password is forwarded once and never stored.
#[tauri::command]
async fn lyrics_server_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<lyrics::ServerStatus> {
    let url = lyrics_server_url(&state)?;
    state.lyrics.login(&url, username.trim(), &password).await?;
    Ok(state.lyrics.server_status(&url).await)
}

#[tauri::command]
async fn lyrics_server_logout(state: State<'_, AppState>) -> Result<Option<lyrics::ServerStatus>> {
    state.lyrics.logout().await;
    match state.config().lyrics_server_url {
        Some(url) => Ok(Some(state.lyrics.server_status(&url).await)),
        None => Ok(None),
    }
}

#[tauri::command]
fn device_command(state: State<'_, AppState>, command: DeviceCommand) -> Result<()> {
    state.device.command(command)
}

#[tauri::command]
fn restart_device(app: AppHandle, state: State<'_, AppState>) {
    let config = state.config();
    state.device.start(app, config, None);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    LyricsClient::load_dev_env();
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app.path();
            let paths = Paths::new(path.app_config_dir()?, path.app_data_dir()?, path.app_cache_dir()?);
            let config = Config::load(&paths.config_file);
            let http = reqwest::Client::builder()
                .user_agent(concat!("NativeSpotify/", env!("CARGO_PKG_VERSION")))
                .build()?;
            let webapi = WebApi::new(http.clone(), paths.token_file.clone());
            let device = Arc::new(ConnectDevice::new(paths.clone(), http.clone(), &config));
            let lyrics = LyricsClient::new(http, paths.lyrics_session_file.clone());

            app.manage(AppState {
                config: Mutex::new(config),
                paths,
                webapi,
                device,
                lyrics,
                sign_in_cancel: Mutex::new(None),
            });

            // Bring the Connect device up right away if we're already signed in.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let config = state.config();
                if let Some(id) = &config.client_id {
                    if state.webapi.is_signed_in(id).await {
                        state.device.start(handle.clone(), config, None);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            save_settings,
            sign_in,
            cancel_sign_in,
            sign_out,
            api,
            spicy_lyrics,
            lyrics_server_status,
            lyrics_server_login,
            lyrics_server_logout,
            device_command,
            restart_device,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                state.device.stop();
            }
        }
    });
}
