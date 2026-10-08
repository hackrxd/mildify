//! Spotify Web API client. Holds the user's token (never exposed to the UI)
//! and proxies requests made by the frontend.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// Spotify counts requests over a rolling 30 seconds and, past its (unpublished) limit, can lock
/// the app out for close to an hour. We stay well under it: at most this many per window, and
/// any more wait their turn.
const WINDOW: Duration = Duration::from_secs(30);
const WINDOW_MAX: usize = 40;
/// A rate limit this short is waited out; a longer one fails every request at once until it's
/// over, so nothing we send in the meantime extends it.
const MAX_WAIT: Duration = Duration::from_secs(5);

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

/// A long rate limit, kept on disk so restarting the app doesn't walk straight back into it.
#[derive(Serialize, Deserialize)]
struct Cooldown {
    client_id: String,
    /// Unix seconds.
    until: u64,
}

enum Admit {
    Go,
    Wait(Duration),
    Blocked(Duration),
}

/// Decides when each request may go out: never during a rate limit, and never more than
/// `WINDOW_MAX` in any `WINDOW`.
#[derive(Default)]
struct Limiter {
    sent: VecDeque<Instant>,
    blocked_until: Option<Instant>,
}

impl Limiter {
    /// Counts the request as sent when it may go now.
    fn admit(&mut self, now: Instant) -> Admit {
        if let Some(until) = self.blocked_until {
            if until > now {
                let left = until - now;
                return if left <= MAX_WAIT { Admit::Wait(left) } else { Admit::Blocked(left) };
            }
            self.blocked_until = None;
        }
        while self.sent.front().is_some_and(|&t| now.duration_since(t) >= WINDOW) {
            self.sent.pop_front();
        }
        if self.sent.len() >= WINDOW_MAX {
            return Admit::Wait(self.sent[0] + WINDOW - now);
        }
        self.sent.push_back(now);
        Admit::Go
    }

    fn block(&mut self, now: Instant, wait: Duration) {
        let until = now + wait;
        if self.blocked_until.is_none_or(|b| b < until) {
            self.blocked_until = Some(until);
        }
    }
}

pub struct WebApi {
    http: reqwest::Client,
    token: Mutex<Option<StoredToken>>,
    token_file: PathBuf,
    limiter: std::sync::Mutex<Limiter>,
    cooldown_file: PathBuf,
    /// `API_BASE`, but for tests.
    base: String,
}

impl WebApi {
    pub fn new(http: reqwest::Client, token_file: PathBuf) -> Self {
        let token: Option<StoredToken> = std::fs::read_to_string(&token_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        let cooldown_file = token_file.with_file_name("webapi_cooldown.json");
        let mut limiter = Limiter::default();
        let cooldown: Option<Cooldown> = std::fs::read_to_string(&cooldown_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        if let Some(c) = cooldown {
            // Only the app that was limited is still limited.
            if token.as_ref().is_some_and(|t| t.client_id == c.client_id) && c.until > now() {
                limiter.block(Instant::now(), Duration::from_secs(c.until - now()));
            }
        }
        Self {
            http,
            token: Mutex::new(token),
            token_file,
            limiter: std::sync::Mutex::new(limiter),
            cooldown_file,
            base: API_BASE.into(),
        }
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
        let switched = self.token.lock().await.as_ref().is_none_or(|t| t.client_id != client_id);
        if switched {
            // A different app has a rate limit of its own.
            *self.limiter.lock().unwrap() = Limiter::default();
            let _ = std::fs::remove_file(&self.cooldown_file);
        }
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

    /// Waits until a request may go out, or fails at once during a long rate limit.
    async fn admit(&self) -> Result<()> {
        loop {
            let verdict = self.limiter.lock().unwrap().admit(Instant::now());
            match verdict {
                Admit::Go => return Ok(()),
                Admit::Wait(wait) => tokio::time::sleep(wait).await,
                Admit::Blocked(left) => return Err(AppError::RateLimited { retry_after: left.as_secs().max(1) }),
            }
        }
    }

    /// Holds every request back for `retry_after` seconds; a long wait outlives a restart.
    async fn rate_limited(&self, retry_after: u64) {
        let wait = Duration::from_secs(retry_after);
        self.limiter.lock().unwrap().block(Instant::now(), wait);
        if wait <= MAX_WAIT {
            return;
        }
        log::warn!("Spotify rate limited the Web API for {retry_after}s");
        let Some(client_id) = self.token.lock().await.as_ref().map(|t| t.client_id.clone()) else { return };
        let cooldown = Cooldown { client_id, until: now() + retry_after };
        if let Err(e) = std::fs::write(&self.cooldown_file, serde_json::to_vec(&cooldown).unwrap_or_default()) {
            log::warn!("couldn't persist the rate limit: {e}");
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
        self.send(method, path, query, body, false).await
    }

    /// As `request`, but not sent again after a server error, which may have come after Spotify did what was
    /// asked: adding songs to a playlist twice would leave them in it twice. Refused and rate-limited requests,
    /// which Spotify didn't act on, are still sent again.
    pub async fn request_once(
        &self,
        method: &str,
        path: &str,
        query: Option<Vec<(String, String)>>,
        body: Option<Value>,
    ) -> Result<Value> {
        self.send(method, path, query, body, true).await
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        query: Option<Vec<(String, String)>>,
        body: Option<Value>,
        once: bool,
    ) -> Result<Value> {
        let url = api_url(&self.base, path, query)?;
        let method = Method::from_bytes(method.to_ascii_uppercase().as_bytes())
            .map_err(|_| AppError::Other(format!("Bad HTTP method {method}")))?;

        let mut refreshed = false;
        let mut attempt = 0;
        loop {
            attempt += 1;
            self.admit().await?;
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
                        .unwrap_or(1)
                        .max(1);
                    self.rate_limited(retry_after).await;
                    // `admit` sleeps through a short limit before the retry.
                    if Duration::from_secs(retry_after) <= MAX_WAIT && attempt < 3 {
                        continue;
                    }
                    return Err(AppError::RateLimited { retry_after });
                }
                500..=599 if attempt < 2 && !once => {
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

/// Resolves a path relative to `base` (`/v1`), or an absolute URL that must be under it.
fn api_url(base: &str, path: &str, query: Option<Vec<(String, String)>>) -> Result<Url> {
    let mut url = if path.starts_with("https://") {
        if !path.starts_with(base) {
            return Err(AppError::Other(format!("Refusing to send credentials to {path}")));
        }
        Url::parse(path)
    } else {
        Url::parse(&format!("{base}{path}"))
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn url(path: &str) -> Url {
        api_url(API_BASE, path, None).unwrap()
    }

    #[test]
    fn resolves_paths_under_v1() {
        assert_eq!(url("/me/player").as_str(), "https://api.spotify.com/v1/me/player");
    }

    #[test]
    fn follows_absolute_paging_links() {
        let next = "https://api.spotify.com/v1/me/tracks?offset=50&limit=50";
        assert_eq!(url(next).as_str(), next);
    }

    #[test]
    fn appends_and_encodes_the_query() {
        let u = api_url(
            API_BASE,
            "/search",
            Some(vec![("q".into(), "AC/DC & co".into()), ("limit".into(), "10".into())]),
        )
        .unwrap();
        assert_eq!(u.as_str(), "https://api.spotify.com/v1/search?q=AC%2FDC+%26+co&limit=10");
        let u = api_url(API_BASE, "https://api.spotify.com/v1/me/tracks?offset=50", Some(vec![("limit".into(), "50".into())])).unwrap();
        assert_eq!(u.query(), Some("offset=50&limit=50"));
    }

    #[test]
    fn never_sends_the_token_to_another_host() {
        for path in [
            "https://evil.example/v1/me",
            "https://api.spotify.com.evil.example/v1/me",
            "https://accounts.spotify.com/api/token",
        ] {
            assert!(matches!(api_url(API_BASE, path, None), Err(AppError::Other(_))), "{path}");
        }
        // Paths that try to smuggle in another host stay on api.spotify.com.
        for path in ["@evil.example/me", ".evil.example/me", "https://api.spotify.com/v1@evil.example/", "/../../x"] {
            if let Ok(u) = api_url(API_BASE, path, None) {
                assert_eq!(u.host_str(), Some("api.spotify.com"), "{path} → {u}");
            }
        }
    }

    #[test]
    fn reads_spotify_error_messages() {
        let body = json!({ "error": { "status": 400, "message": "Invalid limit" } }).to_string();
        assert_eq!(error_message(body), "Invalid limit");
        assert_eq!(error_message("upstream connect error".into()), "upstream connect error");
        assert_eq!(error_message(r#"{"error":"invalid_client"}"#.into()), r#"{"error":"invalid_client"}"#);
    }

    // ---- limiter ---------------------------------------------------------------

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn bursts_past_the_window_wait_for_the_oldest_request_to_age_out() {
        let t0 = Instant::now();
        let mut l = Limiter::default();
        for i in 0..WINDOW_MAX {
            assert!(matches!(l.admit(t0 + Duration::from_millis(i as u64)), Admit::Go), "request {i}");
        }
        match l.admit(t0 + secs(10)) {
            Admit::Wait(w) => assert_eq!(w, secs(20)),
            _ => panic!("the window is full"),
        }
        assert!(matches!(l.admit(t0 + WINDOW), Admit::Go));
    }

    #[test]
    fn a_long_rate_limit_fails_requests_without_sending_them() {
        let t0 = Instant::now();
        let mut l = Limiter::default();
        l.block(t0, secs(2916));
        match l.admit(t0 + secs(16)) {
            Admit::Blocked(left) => assert_eq!(left, secs(2900)),
            _ => panic!("still limited"),
        }
        assert!(l.sent.is_empty(), "a refused request isn't counted");
        assert!(matches!(l.admit(t0 + secs(2916)), Admit::Go));
    }

    #[test]
    fn a_short_rate_limit_is_waited_out() {
        let t0 = Instant::now();
        let mut l = Limiter::default();
        l.block(t0, secs(3));
        assert!(matches!(l.admit(t0 + secs(1)), Admit::Wait(w) if w == secs(2)));
        // A shorter limit arriving later doesn't cut a longer one short.
        l.block(t0 + secs(1), secs(1));
        assert!(matches!(l.admit(t0 + secs(2)), Admit::Wait(w) if w == secs(1)));
    }

    #[tokio::test]
    async fn a_long_rate_limit_outlives_a_restart_for_the_same_app_only() {
        let (api, file) = with_token("mine");
        api.rate_limited(600).await;
        let cooldown = file.with_file_name("webapi_cooldown.json");
        assert!(cooldown.exists());

        let again = WebApi::new(reqwest::Client::new(), file.clone());
        assert!(matches!(again.request("GET", "/me", None, None).await, Err(AppError::RateLimited { retry_after }) if retry_after > 590));

        // Another app's token isn't held back by it.
        let token = json!({ "client_id": "other", "access_token": "a", "refresh_token": "r", "expires_at": now() + 3600 });
        std::fs::write(&file, token.to_string()).unwrap();
        let other = WebApi::new(reqwest::Client::new(), file.clone());
        assert!(matches!(other.limiter.lock().unwrap().admit(Instant::now()), Admit::Go));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[tokio::test]
    async fn short_rate_limits_stay_in_memory() {
        let (api, file) = with_token("mine");
        api.rate_limited(2).await;
        assert!(!file.with_file_name("webapi_cooldown.json").exists());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    // ---- token -----------------------------------------------------------------

    fn scratch() -> PathBuf {
        std::env::temp_dir()
            .join(format!("mildify-test-{}", crate::config::random_hex(8)))
            .join("webapi_token.json")
    }

    fn with_token(client_id: &str) -> (WebApi, PathBuf) {
        let file = scratch();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let token = json!({
            "client_id": client_id,
            "access_token": "a",
            "refresh_token": "r",
            "expires_at": now() + 3600,
        });
        std::fs::write(&file, token.to_string()).unwrap();
        (WebApi::new(reqwest::Client::new(), file.clone()), file)
    }

    #[tokio::test]
    async fn a_token_belongs_to_the_client_id_it_was_issued_for() {
        let (api, file) = with_token("mine");
        assert!(api.is_signed_in("mine").await);
        assert!(!api.is_signed_in("someone-elses").await);
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[tokio::test]
    async fn signing_out_forgets_the_token_on_disk() {
        let (api, file) = with_token("mine");
        api.sign_out().await;
        assert!(!api.is_signed_in("mine").await);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[tokio::test]
    async fn requests_without_a_token_fail_before_any_network() {
        let api = WebApi::new(reqwest::Client::new(), scratch());
        assert!(matches!(api.request("GET", "/me", None, None).await, Err(AppError::NotSignedIn)));
    }

    #[tokio::test]
    async fn rejects_foreign_hosts_and_bad_methods_before_any_network() {
        let (api, file) = with_token("mine");
        assert!(matches!(api.request("GET", "https://evil.example/v1/me", None, None).await, Err(AppError::Other(_))));
        assert!(matches!(api.request("NOT A METHOD", "/me", None, None).await, Err(AppError::Other(_))));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    /// A Web API stand-in on loopback answering each request in turn with `statuses`, the `WebApi` signed in to it,
    /// and the request lines it got.
    async fn stand_in(statuses: Vec<u16>) -> (WebApi, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut seen = Vec::new();
            for status in statuses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    if let Some(i) = text.find("\r\n\r\n") {
                        let len: usize = text
                            .lines()
                            .map(str::to_ascii_lowercase)
                            .find_map(|l| l.strip_prefix("content-length: ").and_then(|v| v.trim().parse().ok()))
                            .unwrap_or(0);
                        if buf.len() >= i + 4 + len || n == 0 {
                            break;
                        }
                    }
                }
                seen.push(String::from_utf8_lossy(&buf).lines().next().unwrap_or_default().to_owned());
                let reply = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}");
                sock.write_all(reply.as_bytes()).await.unwrap();
            }
            seen
        });
        let (mut api, _) = with_token("mine");
        api.base = base;
        (api, server)
    }

    #[tokio::test]
    async fn sends_a_request_again_after_a_server_error_unless_it_must_go_once() {
        let (api, server) = stand_in(vec![500, 200]).await;
        api.request("POST", "/me/player/next", None, None).await.unwrap();
        assert_eq!(server.await.unwrap(), ["POST /v1/me/player/next HTTP/1.1"; 2]);
        // Spotify may have added the songs before it failed: adding them again would add them twice.
        let (api, server) = stand_in(vec![502]).await;
        let songs = json!({ "uris": ["spotify:track:a"] });
        let err = api.request_once("POST", "/playlists/p/items", None, Some(songs)).await.unwrap_err();
        assert!(matches!(err, AppError::Api { status: 502, .. }), "{err:?}");
        assert_eq!(server.await.unwrap().len(), 1);
    }
}
