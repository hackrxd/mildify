//! OAuth 2.0 authorization code flow with PKCE against accounts.spotify.com.
//!
//! Used twice: once with the user's own client ID (Web API), and once with
//! librespot's client ID (to obtain credentials for the Connect device).
//! The redirect lands on a short-lived loopback listener.

use std::collections::HashMap;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use url::Url;

use crate::config::random_hex;
use crate::error::{AppError, Result};

const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

pub struct Redirect {
    pub port: u16,
    pub path: &'static str,
}

impl Redirect {
    pub fn uri(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.port, self.path)
    }
}

/// Must be registered as a Redirect URI in the user's Spotify developer app.
pub const WEBAPI_REDIRECT: Redirect = Redirect { port: 8898, path: "/callback" };
/// librespot's client ID accepts loopback redirects; this mirrors librespot's own default.
pub const LIBRESPOT_REDIRECT: Redirect = Redirect { port: 5588, path: "/login" };

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

/// Runs the full browser sign-in and returns the exchanged token.
/// Resolves early with [`AppError::Cancelled`] if `cancel` fires.
pub async fn authorize(
    app: &AppHandle,
    http: &reqwest::Client,
    client_id: &str,
    redirect: &Redirect,
    scopes: &[&str],
    cancel: oneshot::Receiver<()>,
) -> Result<TokenResponse> {
    let verifier = URL_SAFE_NO_PAD.encode(random_hex(48));
    let challenge = code_challenge(&verifier);
    let state = random_hex(16);
    let redirect_uri = redirect.uri();

    let listener = TcpListener::bind(("127.0.0.1", redirect.port)).await.map_err(|e| {
        AppError::Auth(format!(
            "Couldn't listen on 127.0.0.1:{} for the sign-in redirect ({e}). Is another app using that port?",
            redirect.port
        ))
    })?;

    let url = Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id),
            ("response_type", "code"),
            ("redirect_uri", &redirect_uri),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
            ("state", &state),
            ("scope", &scopes.join(" ")),
        ],
    )
    .map_err(|e| AppError::Other(e.to_string()))?;

    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| AppError::Auth(format!("Couldn't open the browser: {e}")))?;

    let code = tokio::select! {
        r = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(&listener, redirect.path, &state)) => {
            r.map_err(|_| AppError::Auth("Timed out waiting for the browser sign-in".into()))??
        }
        _ = cancel => return Err(AppError::Cancelled),
    };
    drop(listener);

    token_request(
        http,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect_uri),
            ("client_id", client_id),
            ("code_verifier", &verifier),
        ],
    )
    .await
}

/// The PKCE S256 challenge for a code verifier (RFC 7636 §4.2).
fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Exchanges a refresh token. A revoked/invalid grant maps to [`AppError::NotSignedIn`].
pub async fn refresh(
    http: &reqwest::Client,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenResponse> {
    token_request(
        http,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ],
    )
    .await
}

async fn token_request(http: &reqwest::Client, form: &[(&str, &str)]) -> Result<TokenResponse> {
    let resp = http.post(TOKEN_URL).form(form).send().await?;
    let status = resp.status();
    if status.is_success() {
        return Ok(resp.json().await?);
    }
    let body = resp.text().await.unwrap_or_default();
    if status.as_u16() == 400 && body.contains("invalid_grant") {
        return Err(AppError::NotSignedIn);
    }
    Err(AppError::Auth(format!("Token request failed ({status}): {body}")))
}

async fn wait_for_code(listener: &TcpListener, path: &str, state: &str) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let Some(target) = read_request_target(&mut stream).await else {
            continue;
        };
        let url = match Url::parse(&format!("http://127.0.0.1{target}")) {
            Ok(u) if u.path() == path => u,
            _ => {
                respond(&mut stream, "404 Not Found", "Not found").await;
                continue;
            }
        };
        let q: HashMap<String, String> = url.query_pairs().into_owned().collect();

        if q.get("state").map(String::as_str) != Some(state) {
            respond(&mut stream, "400 Bad Request", &page("Sign-in failed", "The response didn't match this sign-in attempt. Try again from the app.")).await;
            continue;
        }
        if let Some(err) = q.get("error") {
            respond(&mut stream, "200 OK", &page("Sign-in cancelled", "You can close this tab and return to Native Spotify.")).await;
            return Err(AppError::Auth(format!("Spotify sign-in was not completed: {err}")));
        }
        if let Some(code) = q.get("code") {
            respond(&mut stream, "200 OK", &page("You're signed in", "You can close this tab and return to Native Spotify.")).await;
            return Ok(code.clone());
        }
        respond(&mut stream, "400 Bad Request", "Missing code").await;
    }
}

/// Reads the HTTP request head and returns the request target (path + query).
async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = vec![0u8; 8192];
    let mut n = 0;
    while n < buf.len() {
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf[n..]))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            break;
        }
        n += read;
        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    head.lines().next()?.split_whitespace().nth(1).map(str::to_owned)
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn page(title: &str, message: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>
<style>body{{margin:0;height:100vh;display:grid;place-items:center;background:#0e0f11;color:#e8e6e3;font:16px system-ui,sans-serif}}
main{{text-align:center}}h1{{font-size:22px;margin:0 0 8px}}p{{color:#9a9894;margin:0}}</style></head>
<body><main><h1>{title}</h1><p>{message}</p></main></body></html>"#
    )
}
