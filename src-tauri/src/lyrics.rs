//! Lyrics come exclusively from the Nativify lyrics service (native-spotify-backend),
//! which holds the Spicy Lyrics API key and may require a username/password sign-in.
//! It returns the Spicy Lyrics v1 body unchanged. The sign-in token stays in the
//! backend and is never sent to the webview.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::RETRY_AFTER;
use reqwest::Response;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::error::{AppError, Result};

/// The lyrics service. Not user-configurable.
pub const LYRICS_SERVER: &str = "https://nativify.hackrvt.xyz";

/// The service caches for 24h too; this just spares repeat requests while a track
/// is replayed. Well inside the Spicy Lyrics API's 30-day caching cap.
const HIT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// "No lyrics" can change as the community uploads syncs, so remember it briefly.
const MISS_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_ENTRIES: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServerSession {
    /// The server this token was issued by; a different server invalidates it.
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

/// What the UI needs to know about the lyrics service.
#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub url: &'static str,
    pub reachable: bool,
    pub auth_required: bool,
    pub version: Option<String>,
    /// Signed-in username, if we hold a token.
    pub username: Option<String>,
    pub error: Option<String>,
}

pub struct LyricsClient {
    http: reqwest::Client,
    cache: Mutex<Cache>,
    session: Mutex<Option<ServerSession>>,
    session_file: PathBuf,
}

impl LyricsClient {
    pub fn new(http: reqwest::Client, session_file: PathBuf) -> Self {
        let session = std::fs::read_to_string(&session_file)
            .ok()
            .and_then(|s| serde_json::from_str::<ServerSession>(&s).ok())
            .filter(|s| s.base_url == LYRICS_SERVER && s.expires_at > now());
        Self {
            http,
            cache: Mutex::new(HashMap::new()),
            session: Mutex::new(session),
            session_file,
        }
    }

    // ---- sign-in ---------------------------------------------------------------

    /// Health check plus our sign-in state.
    pub async fn status(&self) -> ServerStatus {
        let username = self.session().await.map(|s| s.username);
        match self.health().await {
            Ok(h) => ServerStatus {
                url: LYRICS_SERVER,
                reachable: true,
                auth_required: h.auth_required,
                version: h.version,
                username,
                error: None,
            },
            Err(e) => ServerStatus {
                url: LYRICS_SERVER,
                reachable: false,
                auth_required: false,
                version: None,
                username,
                error: Some(e.to_string()),
            },
        }
    }

    async fn health(&self) -> Result<Health> {
        let resp = self
            .http
            .get(format!("{LYRICS_SERVER}/v1/health"))
            .timeout(Duration::from_secs(8))
            .send()
            .await?;
        Ok(check(resp).await?.json().await?)
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<String> {
        let resp = self
            .http
            .post(format!("{LYRICS_SERVER}/v1/auth/login"))
            .json(&serde_json::json!({ "username": username, "password": password }))
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        if resp.status().as_u16() == 401 {
            return Err(AppError::Auth("Wrong username or password".into()));
        }
        let body: Value = check(resp).await?.json().await?;
        let session = ServerSession {
            base_url: LYRICS_SERVER.to_owned(),
            token: body["token"]
                .as_str()
                .ok_or_else(|| AppError::Other("The lyrics service returned no token".into()))?
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
                .post(format!("{LYRICS_SERVER}/v1/auth/logout"))
                .bearer_auth(&s.token)
                .timeout(Duration::from_secs(8))
                .send()
                .await;
        }
        self.persist(None);
    }

    async fn session(&self) -> Option<ServerSession> {
        self.session.lock().await.clone().filter(|s| s.expires_at > now())
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
            log::warn!("couldn't persist lyrics service session: {e}");
        }
    }

    // ---- lyrics ----------------------------------------------------------------

    /// Returns the v1 response for a track, or `None` when there are no lyrics.
    pub async fn get(&self, track_id: &str) -> Result<Option<Value>> {
        if !is_track_id(track_id) {
            return Err(AppError::Other(format!("Not a Spotify track id: {track_id}")));
        }

        if let Some(value) = cached(&*self.cache.lock().await, track_id, Instant::now()) {
            return Ok(value);
        }

        let mut request = self.http.get(format!("{LYRICS_SERVER}/v1/lyrics/{track_id}"));
        if let Some(s) = self.session().await {
            request = request.bearer_auth(s.token);
        }
        let resp = request.timeout(Duration::from_secs(20)).send().await?;

        let value = match resp.status().as_u16() {
            200..=299 => Some(resp.json::<Value>().await.map_err(|e| {
                AppError::Other(format!("Unexpected lyrics response: {e}"))
            })?),
            404 => None,
            401 => {
                self.drop_session().await;
                return Err(AppError::Api {
                    status: 401,
                    message: "Sign in to the lyrics service to see lyrics".into(),
                });
            }
            _ => {
                check(resp).await?;
                unreachable!("check() returns an error for non-success statuses");
            }
        };

        remember(&mut *self.cache.lock().await, track_id, value.clone(), Instant::now());
        Ok(value)
    }

    pub async fn clear_cache(&self) {
        self.cache.lock().await.clear();
    }
}

type Cache = HashMap<String, (Instant, Option<Value>)>;

fn is_track_id(id: &str) -> bool {
    id.len() == 22 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A cached result still within its TTL: `Some(None)` is a remembered "no lyrics".
fn cached(cache: &Cache, track_id: &str, now: Instant) -> Option<Option<Value>> {
    let (at, value) = cache.get(track_id)?;
    let ttl = if value.is_some() { HIT_TTL } else { MISS_TTL };
    (now.duration_since(*at) < ttl).then(|| value.clone())
}

fn remember(cache: &mut Cache, track_id: &str, value: Option<Value>, now: Instant) {
    if cache.len() >= MAX_ENTRIES {
        // Drop the oldest entry; the cache is small enough that a scan is fine.
        if let Some(oldest) = cache.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
            cache.remove(&oldest);
        }
    }
    cache.insert(track_id.to_owned(), (now, value));
}

/// Passes a success response through; turns anything else into an `AppError`,
/// reading the service's `{"error":{"code","message"}}` shape.
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
    Err(AppError::Api { status, message: error_message(&text) })
}

/// The message in an error body: `{"error":{"message"}}`, `{"error":"..."}`, `{"message"}`,
/// or else the start of the raw text.
fn error_message(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            let e = v.get("error").unwrap_or(&v);
            e.get("message")
                .and_then(Value::as_str)
                .or_else(|| e.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| text.chars().take(200).collect())
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const ID: &str = "4uLU6hMCjMI75M1A2tKUQC";

    // ---- cache -----------------------------------------------------------------

    #[test]
    fn hits_are_kept_for_a_day() {
        let t0 = Instant::now();
        let mut cache = Cache::new();
        remember(&mut cache, ID, Some(json!({ "Type": "Line" })), t0);
        assert_eq!(cached(&cache, ID, t0), Some(Some(json!({ "Type": "Line" }))));
        assert!(cached(&cache, ID, t0 + HIT_TTL - Duration::from_secs(1)).is_some());
        assert_eq!(cached(&cache, ID, t0 + HIT_TTL), None);
    }

    #[test]
    fn misses_are_kept_for_an_hour() {
        let t0 = Instant::now();
        let mut cache = Cache::new();
        remember(&mut cache, ID, None, t0);
        assert_eq!(cached(&cache, ID, t0 + MISS_TTL - Duration::from_secs(1)), Some(None));
        assert_eq!(cached(&cache, ID, t0 + MISS_TTL), None);
    }

    #[test]
    fn unknown_tracks_arent_cached() {
        assert_eq!(cached(&Cache::new(), ID, Instant::now()), None);
    }

    #[test]
    fn a_full_cache_drops_its_oldest_entry() {
        let t0 = Instant::now();
        let mut cache = Cache::new();
        for i in 0..MAX_ENTRIES {
            remember(&mut cache, &format!("track{i}"), None, t0 + Duration::from_secs(i as u64));
        }
        assert_eq!(cache.len(), MAX_ENTRIES);
        remember(&mut cache, ID, None, t0 + Duration::from_secs(1_000));
        assert_eq!(cache.len(), MAX_ENTRIES);
        assert!(!cache.contains_key("track0"));
        assert!(cache.contains_key("track1"));
        assert!(cache.contains_key(ID));
    }

    #[test]
    fn track_ids_are_22_base62_characters() {
        assert!(is_track_id(ID));
        for bad in ["", "4uLU6hMCjMI75M1A2tKUQ", "4uLU6hMCjMI75M1A2tKUQCC", "4uLU6hMCjMI75M1A2tKU/C", "../../v1/auth/logout00"] {
            assert!(!is_track_id(bad), "{bad}");
        }
    }

    // ---- errors ----------------------------------------------------------------

    #[test]
    fn reads_error_messages_in_every_shape_the_service_uses() {
        assert_eq!(error_message(r#"{"error":{"code":"x","message":"Slow down"}}"#), "Slow down");
        assert_eq!(error_message(r#"{"error":"Bad token"}"#), "Bad token");
        assert_eq!(error_message(r#"{"message":"Nope"}"#), "Nope");
    }

    #[test]
    fn falls_back_to_the_start_of_the_body() {
        assert_eq!(error_message("Bad Gateway"), "Bad Gateway");
        assert_eq!(error_message(r#"{"error":{"code":"x"}}"#), r#"{"error":{"code":"x"}}"#);
        let html = "é".repeat(500);
        assert_eq!(error_message(&html).chars().count(), 200);
    }

    // ---- client ----------------------------------------------------------------

    fn scratch() -> PathBuf {
        std::env::temp_dir()
            .join(format!("nativespotify-test-{}", crate::config::random_hex(8)))
            .join("lyrics_server_session.json")
    }

    fn client_with(session: Option<Value>) -> (LyricsClient, PathBuf) {
        let file = scratch();
        if let Some(s) = session {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, s.to_string()).unwrap();
        }
        (LyricsClient::new(reqwest::Client::new(), file.clone()), file)
    }

    fn session(base_url: &str, expires_at: u64) -> Value {
        json!({ "base_url": base_url, "token": "t", "username": "me", "expires_at": expires_at })
    }

    fn cleanup(file: &std::path::Path) {
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[tokio::test]
    async fn restores_a_saved_session() {
        let (client, file) = client_with(Some(session(LYRICS_SERVER, now() + 3600)));
        assert_eq!(client.session().await.map(|s| s.username).as_deref(), Some("me"));
        cleanup(&file);
    }

    #[tokio::test]
    async fn ignores_an_expired_session() {
        let (client, file) = client_with(Some(session(LYRICS_SERVER, now() - 1)));
        assert!(client.session().await.is_none());
        cleanup(&file);
    }

    #[tokio::test]
    async fn ignores_a_session_from_another_server() {
        let (client, file) = client_with(Some(session("https://example.com", now() + 3600)));
        assert!(client.session().await.is_none());
        cleanup(&file);
    }

    #[tokio::test]
    async fn ignores_a_corrupt_session_file() {
        let (client, file) = client_with(Some(json!("not a session")));
        assert!(client.session().await.is_none());
        cleanup(&file);
    }

    #[tokio::test]
    async fn dropping_the_session_forgets_it_on_disk() {
        let (client, file) = client_with(Some(session(LYRICS_SERVER, now() + 3600)));
        client.drop_session().await;
        assert!(client.session().await.is_none());
        assert!(!file.exists());
        // And again with nothing left to delete.
        client.drop_session().await;
        cleanup(&file);
    }

    #[tokio::test]
    async fn rejects_bad_track_ids_before_any_request() {
        let (client, file) = client_with(None);
        match client.get("../auth/logout").await {
            Err(AppError::Other(msg)) => assert!(msg.contains("Not a Spotify track id"), "{msg}"),
            other => panic!("expected a validation error, got {other:?}"),
        }
        cleanup(&file);
    }

    #[tokio::test]
    async fn serves_cached_lyrics_without_a_request() {
        let (client, file) = client_with(None);
        remember(&mut *client.cache.lock().await, ID, Some(json!({ "Type": "Static" })), Instant::now());
        assert_eq!(client.get(ID).await.unwrap(), Some(json!({ "Type": "Static" })));
        client.clear_cache().await;
        assert!(client.cache.lock().await.is_empty());
        cleanup(&file);
    }
}
