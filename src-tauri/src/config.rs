use std::fs;
use std::path::{Path, PathBuf};

use rand::RngCore;
use serde::{Deserialize, Serialize};

/// User-editable settings, persisted as JSON in the app config dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Client ID of the user's own Spotify developer app (required for the Web API).
    pub client_id: Option<String>,
    /// Name the Connect device shows up as in every Spotify client.
    pub device_name: String,
    /// Stable Connect device id, generated once so the device keeps its identity across launches.
    pub device_id: String,
    /// Streaming bitrate in kbps: 96, 160 or 320.
    pub bitrate: u16,
    /// Volume (0-100) the device starts at when no volume has been cached yet.
    pub initial_volume: u8,
    /// Apply ReplayGain-style volume normalisation.
    pub normalisation: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            client_id: None,
            device_name: "Native Spotify".into(),
            device_id: random_hex(20),
            bitrate: 320,
            initial_volume: 50,
            normalisation: false,
        }
    }
}

impl Config {
    /// Loads the config, falling back to defaults, and writes it back so generated fields persist.
    pub fn load(path: &Path) -> Self {
        let cfg: Config = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if let Err(e) = cfg.save(path) {
            log::warn!("couldn't write config to {}: {e}", path.display());
        }
        cfg
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(path, serde_json::to_string_pretty(self)?)
    }
}

/// On-disk locations for everything the app persists.
#[derive(Debug, Clone)]
pub struct Paths {
    pub config_file: PathBuf,
    pub token_file: PathBuf,
    /// librespot credentials + volume cache.
    pub librespot_dir: PathBuf,
    /// librespot's (encrypted) audio file cache.
    pub audio_cache_dir: PathBuf,
}

impl Paths {
    pub fn new(config_dir: PathBuf, data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            config_file: config_dir.join("config.json"),
            token_file: data_dir.join("webapi_token.json"),
            librespot_dir: data_dir.join("librespot"),
            audio_cache_dir: cache_dir.join("audio"),
        }
    }
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
