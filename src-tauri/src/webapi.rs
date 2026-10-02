//! Spotify Web API client. Holds the user's token (never exposed to the UI)
//! and proxies requests made by the frontend.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{CONTENT_LENGTH, RETRY_AFTER};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::{oneshot, Mutex};
use url::Url;

use crate::auth::{self, WEBAPI_REDIRECT};
use crate::error::{AppError, Result};

const API_BASE: &str = "https://api.spotify.com/v1";

pub const SCOPES: &[&str] = &[
    "user-read-private",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "user-read-recently-played",
    "user-top-read",
    "user-library-read",
    "user-library-modify",
    "user-follow-read",
    "user-follow-modify",
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-public",
    "playlist-modify-private",
];

#[derive(Clone, Serialize, Deserialize)]
struct StoredToken {
    client_id: String,
    access_token: String,
    refresh_token: String,
    /// Unix seconds.
    expires_at: u64,
}

pub struct WebApi {
    http: reqwest::Client,
    token: Mutex<Option<StoredToken>>,
    token_file: PathBuf,
}

impl WebApi {
    pub fn new(http: reqwest::Client, token_file: PathBuf) -> Self {
        let token = std::fs::read_to_string(&token_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        Self { http, token: Mutex::new(token), token_file }
    }

    /// True if we hold a token issued for `client_id`.
    pub async fn is_signed_in(&self, client_id: &str) -> bool {
        self.token.lock().await.as_ref().is_some_and(|t| t.client_id == client_id)
    }

    pub async fn sign_in(
        &self,
        app: &AppHandle,
        client_id: &str,
        cancel: oneshot::Receiver<()>,
    ) -> Result<()> {
        let resp = auth::authorize(app, &self.http, client_id, &WEBAPI_REDIRECT, SCOPES, cancel).await?;
        let refresh_token = resp
            .refresh_token
            .ok_or_else(|| AppError::Auth("Spotify didn't return a refresh token".into()))?;
        let token = StoredToken {
            client_id: client_id.to_owned(),
            access_token: resp.access_token,
            refresh_token,
            expires_at: now() + resp.expires_in,
        };
        self.persist(&token);
        *self.token.lock().await = Some(token);
        Ok(())
    }

    pub async fn sign_out(&self) {
        *self.token.lock().await = None;
        let _ = std::fs::remove_file(&self.token_file);
    }

    fn persist(&self, token: &StoredToken) {
        let write = || -> std::io::Result<()> {
            if let Some(dir) = self.token_file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&self.token_file, serde_json::to_vec(token)?)
        };
        if let Err(e) = write() {
            log::warn!("couldn't persist Web API token: {e}");
        }
    }

    /// Returns a valid access token, refreshing it when close to expiry (or when forced).
    /// The lock is held across the refresh so concurrent requests don't refresh twice.
    async fn access_token(&self, force_refresh: bool) -> Result<String> {
        let mut guard = self.token.lock().await;
        let token = guard.as_mut().ok_or(AppError::NotSignedIn)?;
        if force_refresh || now() + 60 >= token.expires_at {
            match auth::refresh(&self.http, &token.client_id, &token.refresh_token).await {
                Ok(resp) => {
                    token.access_token = resp.access_token;
                    if let Some(rt) = resp.refresh_token {
                        token.refresh_token = rt;
                    }
                    token.expires_at = now() + resp.expires_in;
                    let snapshot = token.clone();
                    self.persist(&snapshot);
                }
                Err(AppError::NotSignedIn) => {
                    *guard = None;
                    let _ = std::fs::remove_file(&self.token_file);
                    return Err(AppError::NotSignedIn);
                }
                Err(e) => return Err(e),
            }
        }
        Ok(guard.as_ref().map(|t| t.access_token.clone()).unwrap_or_default())
    }

    /// Performs a Web API request. `path` is either relative to `/v1` (e.g. `/me/player`)
    /// or an absolute `https://api.spotify.com/v1/...` URL such as a paging `next` link.
    /// Returns `null` for empty responses.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        query: Option<Vec<(String, String)>>,
        body: Option<Value>,
    ) -> Result<Value> {
        let url = api_url(path, query)?;
        let method = Method::from_bytes(method.to_ascii_uppercase().as_bytes())
            .map_err(|_| AppError::Other(format!("Bad HTTP method {method}")))?;

        let mut refreshed = false;
        let mut attempt = 0;
        loop {
            attempt += 1;
            let token = self.access_token(false).await?;
            let mut req = self.http.request(method.clone(), url.clone()).bearer_auth(token);
            req = match &body {
                Some(b) => req.json(b),
                // Spotify answers 411 to body-less PUT/POST without an explicit length.
                None if method != Method::GET => req.header(CONTENT_LENGTH, 0),
                None => req,
            };
            let resp = req.send().await?;
            let status = resp.status().as_u16();

            match status {
                401 if !refreshed => {
                    refreshed = true;
                    self.access_token(true).await?;
                    continue;
                }
                429 => {
                    let retry_after = resp
                        .headers()
                        .get(RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(1);
                    if retry_after <= 5 && attempt < 3 {
                        tokio::time::sleep(Duration::from_secs(retry_after)).await;
                        continue;
                    }
                    return Err(AppError::RateLimited { retry_after });
                }
                500..=599 if attempt < 2 => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                _ => {}
            }

            let text = resp.text().await?;
            if (200..300).contains(&status) {
                if text.trim().is_empty() {
                    return Ok(Value::Null);
                }
                return Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)));
            }
            return Err(AppError::Api { status, message: error_message(text) });
        }
    }
}

/// Resolves a path relative to `/v1`, or an absolute URL that must be under it.
fn api_url(path: &str, query: Option<Vec<(String, String)>>) -> Result<Url> {
    let mut url = if path.starts_with("https://") {
        if !path.starts_with(API_BASE) {
            return Err(AppError::Other(format!("Refusing to send credentials to {path}")));
        }
        Url::parse(path)
    } else {
        Url::parse(&format!("{API_BASE}{path}"))
    }
    .map_err(|e| AppError::Other(format!("Bad API path {path}: {e}")))?;
    if let Some(q) = query {
        url.query_pairs_mut().extend_pairs(q);
    }
    Ok(url)
}

/// Spotify's `{"error":{"status","message"}}` message, or the raw body.
fn error_message(text: String) -> String {
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or(text)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
