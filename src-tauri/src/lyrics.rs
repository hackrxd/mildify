//! Lyrics fetching, from one of two sources:
//!
//! - A Native Spotify lyrics server (`native-spotify-backend`), which holds the
//!   Spicy Lyrics key itself and may require a username/password sign-in.
//! - The Spicy Lyrics API directly (https://developers.spicylyrics.org/docs), with
//!   a secret key from Settings or the `SL_DEVKEY` / `SPICY_LYRICS_KEY` environment
//!   variables (a `.env` file is loaded in debug builds).
//!
//! Both return the same v1 body. Keys and server tokens stay in the backend and are
//! never sent to the webview.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::RETRY_AFTER;
use reqwest::{RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::error::{AppError, Result};

const SPICY_API: &str = "https://api.spicylyrics.org/v1";
const ENV_KEYS: &[&str] = &["SL_DEVKEY", "SPICY_LYRICS_KEY"];

/// The API terms cap caching at 30 days; a day keeps us well inside that and still
/// spares repeat requests while a track is replayed.
const HIT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// "No lyrics" can change as the community uploads syncs, so remember it briefly.
const MISS_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_ENTRIES: usize = 300;

/// Where lyrics come from for a request.
pub enum Source<'a> {
    Server { base: &'a str },
    Direct { key: &'a str },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServerSession {
    /// The server this token was issued by; a different URL invalidates it.
    base_url: String,
    token: String,
    username: String,
    expires_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct Health {
    #[serde(default)]
    auth_required: bool,
    #[serde(default)]
    version: Option<String>,
}

/// What the UI needs to know about the configured lyrics server.
#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub reachable: bool,
    pub auth_required: bool,
    pub version: Option<String>,
    /// Signed-in username, if we hold a token for this server.
    pub username: Option<String>,
    pub error: Option<String>,
}

pub struct LyricsClient {
    http: reqwest::Client,
    cache: Mutex<HashMap<String, (Instant, Option<Value>)>>,
    session: Mutex<Option<ServerSession>>,
    session_file: PathBuf,
}

impl LyricsClient {
    pub fn new(http: reqwest::Client, session_file: PathBuf) -> Self {
        let session = std::fs::read_to_string(&session_file)
            .ok()
            .and_then(|s| serde_json::from_str::<ServerSession>(&s).ok())
            .filter(|s| s.expires_at > now());
        Self {
            http,
            cache: Mutex::new(HashMap::new()),
            session: Mutex::new(session),
            session_file,
        }
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

    // ---- lyrics server session -------------------------------------------------

    /// Health check plus our sign-in state for `base`.
    pub async fn server_status(&self, base: &str) -> ServerStatus {
        let username = self.session_for(base).await.map(|s| s.username);
        match self.health(base).await {
            Ok(h) => ServerStatus {
                reachable: true,
                auth_required: h.auth_required,
                version: h.version,
                username,
                error: None,
            },
            Err(e) => ServerStatus {
                reachable: false,
                auth_required: false,
                version: None,
                username,
                error: Some(e.to_string()),
            },
        }
    }

    async fn health(&self, base: &str) -> Result<Health> {
        let resp = self
            .http
            .get(format!("{base}/v1/health"))
            .timeout(Duration::from_secs(8))
            .send()
            .await?;
        let resp = check(resp).await?;
        Ok(resp.json().await?)
    }

    pub async fn login(&self, base: &str, username: &str, password: &str) -> Result<String> {
        let resp = self
            .http
            .post(format!("{base}/v1/auth/login"))
            .json(&serde_json::json!({ "username": username, "password": password }))
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        if resp.status().as_u16() == 401 {
            return Err(AppError::Auth("Wrong username or password".into()));
        }
        let body: Value = check(resp).await?.json().await?;
        let session = ServerSession {
            base_url: base.to_owned(),
            token: body["token"]
                .as_str()
                .ok_or_else(|| AppError::Other("Lyrics server returned no token".into()))?
                .to_owned(),
            username: body["username"].as_str().unwrap_or(username).to_owned(),
            expires_at: body["expires_at"].as_u64().unwrap_or(now() + 30 * 24 * 3600),
        };
        let name = session.username.clone();
        self.persist(Some(&session));
        *self.session.lock().await = Some(session);
        self.clear_cache().await;
        Ok(name)
    }

    pub async fn logout(&self) {
        let session = self.session.lock().await.take();
        if let Some(s) = session {
            // Best effort: revoke server-side, then forget locally regardless.
            let _ = self
                .http
                .post(format!("{}/v1/auth/logout", s.base_url))
                .bearer_auth(&s.token)
                .timeout(Duration::from_secs(8))
                .send()
                .await;
        }
        self.persist(None);
    }

    async fn session_for(&self, base: &str) -> Option<ServerSession> {
        self.session
            .lock()
            .await
            .clone()
            .filter(|s| s.base_url == base && s.expires_at > now())
    }

    async fn drop_session(&self) {
        *self.session.lock().await = None;
        self.persist(None);
    }

    fn persist(&self, session: Option<&ServerSession>) {
        let result = match session {
            Some(s) => self
                .session_file
                .parent()
                .map(std::fs::create_dir_all)
                .unwrap_or(Ok(()))
                .and_then(|_| std::fs::write(&self.session_file, serde_json::to_vec(s)?)),
            None => match std::fs::remove_file(&self.session_file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            },
        };
        if let Err(e) = result {
            log::warn!("couldn't persist lyrics server session: {e}");
        }
    }

    // ---- lyrics ----------------------------------------------------------------

    /// Returns the v1 response for a track, or `None` when there are no lyrics.
    pub async fn get(&self, source: Source<'_>, track_id: &str) -> Result<Option<Value>> {
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

        let request: RequestBuilder = match &source {
            Source::Direct { key } => self.http.get(format!("{SPICY_API}/lyrics/{track_id}")).bearer_auth(key),
            Source::Server { base } => {
                let req = self.http.get(format!("{base}/v1/lyrics/{track_id}"));
                match self.session_for(base).await {
                    Some(s) => req.bearer_auth(s.token),
                    None => req,
                }
            }
        };
        let resp = request.timeout(Duration::from_secs(20)).send().await?;

        let value = match resp.status().as_u16() {
            200..=299 => Some(resp.json::<Value>().await.map_err(|e| {
                AppError::Other(format!("Unexpected lyrics response: {e}"))
            })?),
            404 => None,
            401 if matches!(source, Source::Server { .. }) => {
                self.drop_session().await;
                return Err(AppError::Api {
                    status: 401,
                    message: "Sign in to the lyrics server to see lyrics".into(),
                });
            }
            _ => {
                check(resp).await?;
                unreachable!("check() returns an error for non-success statuses");
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

/// Passes a success response through; turns anything else into an `AppError`,
/// reading `{"error":{"code","message"}}` (lyrics server) or similar shapes.
async fn check(resp: Response) -> Result<Response> {
    let status = resp.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(resp);
    }
    let retry_after = resp
        .headers()
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    if status == 429 {
        return Err(AppError::RateLimited { retry_after: retry_after.unwrap_or(30) });
    }
    let text = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| {
            let e = v.get("error").unwrap_or(&v);
            e.get("message")
                .and_then(Value::as_str)
                .or_else(|| e.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| text.chars().take(200).collect());
    Err(AppError::Api { status, message })
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
