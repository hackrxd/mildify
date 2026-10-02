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
    /// Lyrics service sign-in token (kept out of config.json).
    pub lyrics_session_file: PathBuf,
    /// librespot credentials + volume cache.
    pub librespot_dir: PathBuf,
    /// librespot's (encrypted) audio file cache.
    pub audio_cache_dir: PathBuf,
    /// User CSS themes and JS extensions (see mods.rs).
    pub themes_dir: PathBuf,
    pub extensions_dir: PathBuf,
}

impl Paths {
    pub fn new(config_dir: PathBuf, data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            config_file: config_dir.join("config.json"),
            token_file: data_dir.join("webapi_token.json"),
            lyrics_session_file: data_dir.join("lyrics_server_session.json"),
            librespot_dir: data_dir.join("librespot"),
            audio_cache_dir: cache_dir.join("audio"),
            themes_dir: config_dir.join("themes"),
            extensions_dir: config_dir.join("extensions"),
        }
    }
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch file path, unique per test, under the system temp dir.
    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nativespotify-test-{}", random_hex(8))).join(name)
    }

    #[test]
    fn random_hex_is_lowercase_hex_of_twice_the_length() {
        let h = random_hex(20);
        assert_eq!(h.len(), 40);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(random_hex(20), h);
        assert_eq!(random_hex(0), "");
    }

    #[test]
    fn defaults() {
        let c = Config::default();
        assert_eq!(c.client_id, None);
        assert_eq!(c.device_name, "Native Spotify");
        assert_eq!(c.device_id.len(), 40);
        assert_eq!(c.bitrate, 320);
        assert_eq!(c.initial_volume, 50);
        assert!(!c.normalisation);
    }

    #[test]
    fn older_configs_keep_their_fields_and_gain_new_ones() {
        let c: Config = serde_json::from_str(r#"{ "client_id": "abc", "device_name": "Desk", "unknown": 1 }"#).unwrap();
        assert_eq!(c.client_id.as_deref(), Some("abc"));
        assert_eq!(c.device_name, "Desk");
        assert_eq!(c.bitrate, 320);
        assert_eq!(c.device_id.len(), 40);
    }

    #[test]
    fn load_persists_the_generated_device_id() {
        let path = scratch("config.json");
        let first = Config::load(&path);
        assert!(path.exists(), "load writes the config back");
        let second = Config::load(&path);
        assert_eq!(first.device_id, second.device_id);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn load_falls_back_to_defaults_for_a_corrupt_file() {
        let path = scratch("config.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        let c = Config::load(&path);
        assert_eq!(c.device_name, "Native Spotify");
        let reread: Config = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(reread.device_id, c.device_id);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn save_round_trips() {
        let path = scratch("nested/config.json");
        let c = Config { client_id: Some("id".into()), bitrate: 160, normalisation: true, ..Config::default() };
        c.save(&path).unwrap();
        let back: Config = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.client_id.as_deref(), Some("id"));
        assert_eq!(back.bitrate, 160);
        assert!(back.normalisation);
        assert_eq!(back.device_id, c.device_id);
        std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }

    #[test]
    fn paths_keep_secrets_out_of_the_config_dir() {
        let p = Paths::new("/cfg".into(), "/data".into(), "/cache".into());
        assert_eq!(p.config_file, Path::new("/cfg/config.json"));
        assert!(p.token_file.starts_with("/data"));
        assert!(p.lyrics_session_file.starts_with("/data"));
        assert!(p.librespot_dir.starts_with("/data"));
        assert!(p.audio_cache_dir.starts_with("/cache"));
        assert_eq!(p.themes_dir, Path::new("/cfg/themes"));
        assert_eq!(p.extensions_dir, Path::new("/cfg/extensions"));
    }
}
