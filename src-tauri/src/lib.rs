mod auth;
mod config;
mod device;
mod devtools;
mod dj;
mod duck;
mod error;
mod lyrics;
mod meter;
mod mods;
mod ui;
mod webapi;
#[cfg(target_os = "linux")]
mod webkit;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::sync::oneshot;

use config::{Config, Paths};
use device::{ConnectDevice, DeviceCommand, DeviceState, DeviceStatus};
use devtools::{DevTools, DevToolsStatus};
use dj::Dj;
use error::{AppError, Result};
use lyrics::LyricsClient;
use webapi::WebApi;

struct AppState {
    config: Mutex<Config>,
    paths: Paths,
    webapi: WebApi,
    device: Arc<ConnectDevice>,
    lyrics: LyricsClient,
    /// The AI DJ's downloads, model and voice.
    dj: Dj,
    http: reqwest::Client,
    /// Downloaded interface updates, and which UI the window is served.
    ui: Arc<ui::UiStore>,
    devtools: Arc<DevTools>,
    /// Started with `--remote-debugging-port=N`: serve DevTools there whatever the setting says.
    devtools_flag: Option<u16>,
    /// Started with `--safe-mode`: no theme or extension loads.
    safe_mode: bool,
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

    /// Where the DevTools endpoint should be served: the launch flag's port, else 9222 if it's turned on.
    fn devtools_port(&self, config: &Config) -> Option<u16> {
        self.devtools_flag.or(config.devtools.then_some(devtools::DEFAULT_PORT))
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
            devtools: self.devtools.status(),
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
    devtools: DevToolsStatus,
}

#[derive(Deserialize)]
struct SettingsInput {
    client_id: Option<String>,
    device_name: Option<String>,
    bitrate: Option<u16>,
    normalisation: Option<bool>,
    devtools: Option<bool>,
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
        if let Some(d) = settings.devtools {
            cfg.devtools = d;
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
    if device_changed
        && !matches!(
            state.device.status().state,
            DeviceState::Offline | DeviceState::NeedsLogin | DeviceState::PremiumRequired
        )
    {
        state.device.start(app.clone(), new.clone(), None);
    }
    state.devtools.serve(state.devtools_port(&new), window_asker(app)).await;
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

/// Fetches lyrics for upcoming tracks into the backend's cache, without returning them.
#[tauri::command]
async fn warm_lyrics(state: State<'_, AppState>, track_ids: Vec<String>) -> Result<usize> {
    Ok(state.lyrics.warm(&track_ids).await)
}

/// Drops a played track's cached lyrics, so its next play gets the latest version.
#[tauri::command]
async fn forget_lyrics(state: State<'_, AppState>, track_id: String) -> Result<()> {
    state.lyrics.forget(&track_id).await;
    Ok(())
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

/// Installed themes and extensions, re-read from disk on every call.
#[tauri::command]
fn list_mods(state: State<'_, AppState>) -> mods::ModList {
    let paths = &state.paths;
    mods::ModList {
        themes_dir: paths.themes_dir.clone(),
        extensions_dir: paths.extensions_dir.clone(),
        base_url: mods::base_url(),
        safe_mode: state.safe_mode,
        themes: mods::scan(&paths.themes_dir, mods::Kind::Theme),
        extensions: mods::scan(&paths.extensions_dir, mods::Kind::Extension),
    }
}

/// Opens the themes or extensions folder in the file manager, creating it first.
#[tauri::command]
fn open_mods_folder(state: State<'_, AppState>, kind: String) -> Result<()> {
    let dir = match kind.as_str() {
        "themes" => &state.paths.themes_dir,
        "extensions" => &state.paths.extensions_dir,
        _ => return Err(AppError::Other(format!("unknown mods folder {kind}"))),
    };
    std::fs::create_dir_all(dir)?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| AppError::Other(e.to_string()))
}

/// The window's answer to a DevTools ask (devtools.rs).
#[tauri::command]
fn devtools_answer(state: State<'_, AppState>, id: u64, value: Value) {
    state.devtools.answer(id, value);
}

/// Asks the main window for the player state or a control, as `devtools-ask` events.
fn window_asker(app: AppHandle) -> devtools::Asker {
    Arc::new(move |id, ask| {
        if let Err(e) = app.emit_to("main", "devtools-ask", serde_json::json!({ "id": id, "ask": ask })) {
            log::warn!("couldn't ask the window for DevTools: {e}");
        }
    })
}

/// The AI DJ's settings, downloads and disk use.
#[tauri::command]
async fn dj_status(state: State<'_, AppState>) -> Result<dj::DjStatus> {
    Ok(state.dj.status(&state.config().dj))
}

/// Changes the DJ's settings. Turning it on downloads what it needs; turning it off stops that, and
/// unloads the model.
#[tauri::command]
async fn dj_configure(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: dj::DjSettingsInput,
) -> Result<dj::DjStatus> {
    let (old, new) = {
        let mut cfg = state.config.lock().unwrap();
        let old = cfg.dj.clone();
        let mut next = old.clone();
        next.apply(settings)?;
        cfg.dj = next;
        cfg.save(&state.paths.config_file)?;
        (old, cfg.dj.clone())
    };
    if old != new {
        // What's downloading may not be what's needed any more; partial downloads are kept.
        state.dj.cancel_install();
        state.dj.release().await;
    }
    if new.enabled {
        state.dj.start_install(&app, new.clone())?;
    }
    Ok(state.dj.status(&new))
}

/// Retries the DJ's downloads after a failure.
#[tauri::command]
fn dj_install(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    state.dj.start_install(&app, state.config().dj)
}

#[tauri::command]
fn dj_cancel(state: State<'_, AppState>) {
    state.dj.cancel_install();
}

/// Turns the DJ off and deletes everything it downloaded.
#[tauri::command]
async fn dj_remove(state: State<'_, AppState>) -> Result<dj::DjStatus> {
    let cfg = {
        let mut cfg = state.config.lock().unwrap();
        cfg.dj.enabled = false;
        cfg.save(&state.paths.config_file)?;
        cfg.dj.clone()
    };
    state.dj.remove().await?;
    Ok(state.dj.status(&cfg))
}

/// Loads the DJ's model ahead of its first request.
#[tauri::command]
async fn dj_warm(state: State<'_, AppState>) -> Result<()> {
    state.dj.warm(&state.config().dj).await
}

/// Asks the DJ's model: with a JSON schema, for JSON that fits it; offered tools, for the calls it wants to
/// make before answering.
#[tauri::command]
async fn dj_generate(
    state: State<'_, AppState>,
    messages: Vec<dj::chat::Message>,
    schema: Option<Value>,
    tools: Option<Vec<dj::chat::Tool>>,
    max_tokens: Option<u32>,
) -> Result<dj::chat::Answer> {
    let cfg = state.config().dj;
    let max_tokens = max_tokens.unwrap_or(400).min(2000);
    state.dj.generate(&cfg, &messages, schema.as_ref(), tools.as_deref(), max_tokens).await
}

/// Saves the API key for a cloud model provider in the system keychain, or removes it with `None`. The key
/// never comes back to the UI; the status says only whether one is saved.
#[tauri::command]
async fn dj_set_key(state: State<'_, AppState>, provider: String, key: Option<String>) -> Result<dj::DjStatus> {
    state.dj.set_key(&provider, key.as_deref())?;
    Ok(state.dj.status(&state.config().dj))
}

/// The models a cloud provider offers with the saved key.
#[tauri::command]
async fn dj_models(state: State<'_, AppState>, provider: String) -> Result<Vec<dj::chat::ModelChoice>> {
    state.dj.models(&provider).await
}

/// Reads a line in the DJ's voice; `dj_voice` plays it.
#[tauri::command]
async fn dj_speak(state: State<'_, AppState>, text: String) -> Result<dj::voice::Speech> {
    state.dj.speak(&state.config().dj, &text).await
}

/// Plays, pauses or stops the DJ's lines on this computer's audio output, as the music plays.
#[tauri::command]
fn dj_voice(app: AppHandle, state: State<'_, AppState>, command: dj::speaker::VoiceCommand) -> Result<()> {
    state.dj.voice(&app, command)
}

/// Turns the music on the embedded player down to `level` (0-1) while the DJ talks, or back up.
#[tauri::command]
fn dj_duck(state: State<'_, AppState>, level: f32, delay_ms: u32, ramp_ms: u32) {
    state.device.duck().set(
        level,
        Duration::from_millis(u64::from(delay_ms.min(10_000))),
        Duration::from_millis(u64::from(ramp_ms.min(10_000))),
    );
}

/// Unloads the DJ's model, freeing its memory.
#[tauri::command]
async fn dj_release(state: State<'_, AppState>) -> Result<()> {
    state.dj.close_voice();
    state.dj.release().await;
    Ok(())
}

#[tauri::command]
fn device_command(state: State<'_, AppState>, command: DeviceCommand) -> Result<()> {
    state.device.command(command)
}

/// Turns the `audio-level` events for audio-responsive effects on or off.
#[tauri::command]
fn audio_meter(app: AppHandle, state: State<'_, AppState>, on: bool) {
    state.device.meter().set_on(&app, on);
}

/// Looks for a newer UI, downloading it when this binary can run it; otherwise the release needs the
/// full updater and a restart.
#[tauri::command]
async fn ui_update(app: AppHandle, state: State<'_, AppState>) -> Result<ui::UiUpdate> {
    let source = ui::Source::from_updater(app.config().plugins.0.get("updater"))?;
    state.ui.check(&state.http, &source).await
}

/// Serves the downloaded UI from now on; the window reloads right after, and playback carries on.
#[tauri::command]
fn apply_ui_update(state: State<'_, AppState>) -> bool {
    state.ui.apply()
}

#[tauri::command]
fn restart_device(app: AppHandle, state: State<'_, AppState>) {
    let config = state.config();
    state.device.start(app, config, None);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    #[cfg(target_os = "linux")]
    webkit::configure();

    let safe_mode = mods::safe_mode(std::env::args());
    let mut context = tauri::generate_context!();
    let ui = ui::serve(&mut context, safe_mode);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_uri_scheme_protocol(mods::SCHEME, |ctx, request| {
            let state = ctx.app_handle().state::<AppState>();
            mods::serve(&state.paths.themes_dir, &state.paths.extensions_dir, &request)
        })
        .setup(move |app| {
            let path = app.path();
            let paths = Paths::new(path.app_config_dir()?, path.app_data_dir()?, path.app_cache_dir()?);
            let config = Config::load(&paths.config_file);
            let http = reqwest::Client::builder()
                .user_agent(concat!("Mildify/", env!("CARGO_PKG_VERSION")))
                .build()?;
            let webapi = WebApi::new(http.clone(), paths.token_file.clone());
            let device = Arc::new(ConnectDevice::new(paths.clone(), http.clone(), &config));
            let lyrics = LyricsClient::new(http.clone(), paths.lyrics_session_file.clone());
            let dj = Dj::new(paths.dj_dir.clone(), paths.dj_scratch_dir.clone(), http.clone());
            dj.watch_idle();
            // Downloads cut short by quitting carry on, but only while the DJ is on.
            let resume_dj = config.dj.enabled.then(|| config.dj.clone());
            let devtools = DevTools::new();
            let devtools_flag = devtools::port_flag(std::env::args());

            app.manage(AppState {
                config: Mutex::new(config),
                paths,
                webapi,
                device,
                lyrics,
                dj,
                http,
                ui,
                devtools,
                devtools_flag,
                safe_mode,
                sign_in_cancel: Mutex::new(None),
            });

            if let Some(cfg) = resume_dj {
                let state = app.state::<AppState>();
                if let Err(e) = state.dj.start_install(app.handle(), cfg) {
                    log::warn!("DJ: {e}");
                }
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let port = state.devtools_port(&state.config());
                state.devtools.serve(port, window_asker(handle.clone())).await;
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
            warm_lyrics,
            forget_lyrics,
            lyrics_server_status,
            lyrics_server_login,
            lyrics_server_logout,
            device_command,
            restart_device,
            audio_meter,
            ui_update,
            apply_ui_update,
            devtools_answer,
            list_mods,
            open_mods_folder,
            dj_status,
            dj_configure,
            dj_install,
            dj_cancel,
            dj_remove,
            dj_warm,
            dj_generate,
            dj_set_key,
            dj_models,
            dj_speak,
            dj_voice,
            dj_duck,
            dj_release,
        ])
        .build(context)
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                state.device.stop();
                state.dj.shutdown();
            }
        }
    });
}
