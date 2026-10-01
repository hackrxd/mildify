//! Spicy Lyrics API client (https://developers.spicylyrics.org/docs).
//!
//! The key is a secret (`sl_sk_…`) key, so it lives here in the backend and is
//! never sent to the webview. It comes from Settings, or from the `SL_DEVKEY` /
//! `SPICY_LYRICS_KEY` environment variables (a `.env` file is loaded in debug builds).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use reqwest::header::RETRY_AFTER;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::error::{AppError, Result};

const API_BASE: &str = "https://api.spicylyrics.org/v1";
const ENV_KEYS: &[&str] = &["SL_DEVKEY", "SPICY_LYRICS_KEY"];

/// The API terms cap caching at 30 days; a day keeps us well inside that and still
/// spares repeat requests while a track is replayed.
const HIT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// "No lyrics" can change as the community uploads syncs, so remember it briefly.
const MISS_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_ENTRIES: usize = 300;

pub struct LyricsClient {
    http: reqwest::Client,
    cache: Mutex<HashMap<String, (Instant, Option<Value>)>>,
}

impl LyricsClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http, cache: Mutex::new(HashMap::new()) }
    }

    /// Loads `.env` from the working directory or the project root (debug builds only).
    pub fn load_dev_env() {
        if cfg!(debug_assertions) {
            for path in [".env", "../.env"] {
                if dotenvy::from_path(path).is_ok() {
                    log::info!("loaded {path}");
                }
            }
        }
    }

    pub fn env_key() -> Option<String> {
        ENV_KEYS
            .iter()
            .find_map(|k| std::env::var(k).ok())
            .map(|k| k.trim().to_owned())
            .filter(|k| !k.is_empty())
    }

    /// Returns the API response for a track, or `None` when there are no lyrics.
    pub async fn get(&self, key: &str, track_id: &str) -> Result<Option<Value>> {
        if track_id.len() != 22 || !track_id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(AppError::Other(format!("Not a Spotify track id: {track_id}")));
        }

        {
            let cache = self.cache.lock().await;
            if let Some((at, value)) = cache.get(track_id) {
                let ttl = if value.is_some() { HIT_TTL } else { MISS_TTL };
                if at.elapsed() < ttl {
                    return Ok(value.clone());
                }
            }
        }

        let resp = self
            .http
            .get(format!("{API_BASE}/lyrics/{track_id}"))
            .bearer_auth(key)
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        let status = resp.status().as_u16();
        let retry_after = resp
            .headers()
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok());
        let text = resp.text().await?;

        let value = match status {
            200..=299 => Some(serde_json::from_str::<Value>(&text).map_err(|e| {
                AppError::Other(format!("Unexpected lyrics response: {e}"))
            })?),
            404 => None,
            429 => return Err(AppError::RateLimited { retry_after: retry_after.unwrap_or(30) }),
            _ => {
                let message = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("error")
                            .or_else(|| v.get("message"))
                            .or_else(|| v.get("Body").and_then(|b| b.get("message")))
                            .and_then(|m| m.as_str().or_else(|| m.get("message")?.as_str()))
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| text.chars().take(200).collect());
                return Err(AppError::Api { status, message });
            }
        };

        let mut cache = self.cache.lock().await;
        if cache.len() >= MAX_ENTRIES {
            // Drop the oldest entry; the cache is small enough that a scan is fine.
            if let Some(oldest) = cache.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
                cache.remove(&oldest);
            }
        }
        cache.insert(track_id.to_owned(), (Instant::now(), value.clone()));
        Ok(value)
    }

    pub async fn clear_cache(&self) {
        self.cache.lock().await.clear();
    }
}
