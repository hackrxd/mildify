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

    async fn status(&self) -> AppStatus {
        let config = self.config();
        let signed_in = match &config.client_id {
            Some(id) => self.webapi.is_signed_in(id).await,
            None => false,
        };
        AppStatus {
            redirect_uri: auth::WEBAPI_REDIRECT.uri(),
            signed_in,
            device: self.device.status(),
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
}

#[derive(Deserialize)]
struct SettingsInput {
    client_id: Option<String>,
    device_name: Option<String>,
    bitrate: Option<u16>,
    normalisation: Option<bool>,
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
        cfg.save(&state.paths.config_file)?;
        (old, cfg.clone())
    };

    if old.client_id != new.client_id {
        state.webapi.sign_out().await;
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

/// Fetches lyrics (Spicy Lyrics v1 response) for a Spotify track id from the Nativify
/// lyrics service. Returns `null` when the track has no lyrics.
#[tauri::command]
async fn spicy_lyrics(state: State<'_, AppState>, track_id: String) -> Result<Value> {
    Ok(state.lyrics.get(&track_id).await?.unwrap_or(Value::Null))
}

/// Health and sign-in state of the lyrics service.
#[tauri::command]
async fn lyrics_server_status(state: State<'_, AppState>) -> Result<lyrics::ServerStatus> {
    Ok(state.lyrics.status().await)
}

/// Signs in to the lyrics service. The password is forwarded once and never stored.
#[tauri::command]
async fn lyrics_server_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<lyrics::ServerStatus> {
    state.lyrics.login(username.trim(), &password).await?;
    Ok(state.lyrics.status().await)
}

#[tauri::command]
async fn lyrics_server_logout(state: State<'_, AppState>) -> Result<lyrics::ServerStatus> {
    state.lyrics.logout().await;
    Ok(state.lyrics.status().await)
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
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
