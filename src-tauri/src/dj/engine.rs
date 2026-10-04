//! The DJ's language model: llama.cpp's `llama-server` running the downloaded model on a loopback port, or
//! the user's own OpenAI-compatible server (Ollama, LM Studio, …). Either way, one chat request per segment,
//! with the answer held to a JSON schema.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::error::{AppError, Result};

/// Loading a model from a slow disk can take a while; past this, something is wrong.
const LOAD_TIMEOUT: Duration = Duration::from_secs(240);
/// Writing one segment's picks and intro, on a CPU.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(240);
/// The model is unloaded after this long without a request, freeing its memory.
pub const IDLE: Duration = Duration::from_secs(10 * 60);
/// Enough for the prompt (a few dozen songs) and the answer.
const CONTEXT: &str = "4096";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: String,
    pub content: String,
}

/// Where to send chat requests.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    /// The full chat completions URL.
    pub url: String,
    pub key: Option<String>,
    pub model: String,
    /// Our own llama-server: it understands llama.cpp's extra options.
    pub local: bool,
}

struct Running {
    child: tokio::process::Child,
    model: PathBuf,
    target: Target,
}

#[derive(Default)]
pub struct Engine {
    running: Mutex<Option<Running>>,
    last_used: StdMutex<Option<Instant>>,
}

impl Engine {
    /// The local server for `model`, started (or restarted with a different model) if need be.
    pub async fn local(&self, server: &Path, model: &Path, log: &Path) -> Result<Target> {
        self.touch();
        let mut running = self.running.lock().await;
        if let Some(r) = running.as_mut() {
            if r.model == model && matches!(r.child.try_wait(), Ok(None)) {
                return Ok(r.target.clone());
            }
            let _ = r.child.start_kill();
            *running = None;
        }
        let r = start(server, model, log).await?;
        let target = r.target.clone();
        *running = Some(r);
        Ok(target)
    }

    pub fn touch(&self) {
        *self.last_used.lock().unwrap() = Some(Instant::now());
    }

    /// Stops the local server, if it's running.
    pub async fn stop(&self) {
        if let Some(mut r) = self.running.lock().await.take() {
            let _ = r.child.kill().await;
        }
    }

    /// For app exit, where nothing can wait: asks the server to stop if nobody's starting it right now.
    pub fn kill_now(&self) {
        if let Ok(mut running) = self.running.try_lock() {
            if let Some(r) = running.as_mut() {
                let _ = r.child.start_kill();
            }
        }
    }

    pub async fn is_running(&self) -> bool {
        self.running.lock().await.is_some()
    }

    /// Whether nothing has asked for the model in `IDLE`.
    pub fn idle(&self, now: Instant) -> bool {
        self.last_used.lock().unwrap().is_none_or(|t| now.duration_since(t) >= IDLE)
    }
}

/// Starts `llama-server` on a free loopback port and waits for it to load the model.
async fn start(server: &Path, model: &Path, log: &Path) -> Result<Running> {
    if !server.is_file() || !model.is_file() {
        return Err(AppError::Other("The DJ's model isn't downloaded yet".into()));
    }
    let port = free_port()?;
    let key = crate::config::random_hex(16);
    let log_file = std::fs::File::create(log)?;
    let mut cmd = tokio::process::Command::new(server);
    cmd.args(server_args(model, port, &key))
        .current_dir(server.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file))
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("Couldn't start the DJ's model: {e}")))?;

    let base = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::new();
    let deadline = Instant::now() + LOAD_TIMEOUT;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(AppError::Other(format!(
                "The DJ's model stopped while loading ({status}). {}",
                last_line(log).unwrap_or_default()
            )));
        }
        let health = http.get(format!("{base}/health")).bearer_auth(&key).timeout(Duration::from_secs(2)).send().await;
        if health.is_ok_and(|r| r.status().is_success()) {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill().await;
            return Err(AppError::Other("The DJ's model took too long to load".into()));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    log::info!("DJ model loaded from {}", model.display());
    Ok(Running {
        child,
        model: model.to_owned(),
        target: Target { url: format!("{base}/v1/chat/completions"), key: Some(key), model: "dj".into(), local: true },
    })
}

/// Hides the console window Windows would open for a console program started from a GUI app.
#[cfg(windows)]
pub const NO_WINDOW: u32 = 0x0800_0000;

fn server_args(model: &Path, port: u16, key: &str) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["--model".into(), model.into()];
    for a in [
        "--host", "127.0.0.1",
        "--port", &port.to_string(),
        "--api-key", key,
        "--alias", "dj",
        "--ctx-size", CONTEXT,
        "--parallel", "1",
        "--no-webui",
        // Never reaches out to the network, whatever the model file asks.
        "--offline",
    ] {
        args.push(a.into());
    }
    args
}

fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// The last non-empty line of the server's log, for an error message.
fn last_line(log: &Path) -> Option<String> {
    let text = std::fs::read_to_string(log).ok()?;
    text.lines().rev().map(str::trim).find(|l| !l.is_empty()).map(|l| l.chars().take(200).collect())
}

/// The chat completions URL for what the user typed as their server's address.
pub fn chat_url(server: &str) -> Result<String> {
    let base = server.trim().trim_end_matches('/');
    let url = url::Url::parse(base).map_err(|_| AppError::Other(format!("“{base}” isn't a web address")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::Other(format!("“{base}” isn't an http:// or https:// address")));
    }
    Ok(if base.ends_with("/chat/completions") {
        base.to_owned()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    })
}

/// The request body. llama-server takes `chat_template_kwargs`; other servers might refuse fields they
/// don't know, so they only get the standard ones.
fn request_body(target: &Target, messages: &[Message], schema: Option<&Value>, max_tokens: u32) -> Value {
    let mut body = json!({
        "model": target.model,
        "messages": messages,
        "temperature": 0.8,
        "max_tokens": max_tokens,
        "stream": false,
    });
    if let Some(schema) = schema {
        body["response_format"] =
            json!({ "type": "json_schema", "json_schema": { "name": "dj_segment", "strict": true, "schema": schema } });
    }
    if target.local {
        // Qwen3 thinks out loud by default; a DJ line doesn't need it.
        body["chat_template_kwargs"] = json!({ "enable_thinking": false });
    }
    body
}

/// Asks the model; with a schema, returns the JSON it answered with, else the text.
pub async fn chat(
    http: &reqwest::Client,
    target: &Target,
    messages: &[Message],
    schema: Option<&Value>,
    max_tokens: u32,
) -> Result<Value> {
    if let Some(bad) = messages.iter().find(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant")) {
        return Err(AppError::Other(format!("Unknown chat role {}", bad.role)));
    }
    let mut request = http
        .post(&target.url)
        .json(&request_body(target, messages, schema, max_tokens))
        .timeout(ANSWER_TIMEOUT);
    if let Some(key) = &target.key {
        request = request.bearer_auth(key);
    }
    let resp = request.send().await.map_err(|e| {
        if target.local {
            AppError::Http(e)
        } else {
            AppError::Other(format!("Couldn't reach your model server at {}: {e}", target.url))
        }
    })?;
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if !(200..300).contains(&status) {
        return Err(AppError::Api { status, message: error_message(&text) });
    }
    let content = answer_text(&text)?;
    match schema {
        Some(_) => json_in(&content).ok_or_else(|| AppError::Other("The DJ's model didn't answer in JSON".into())),
        None => Ok(Value::String(content)),
    }
}

/// `choices[0].message.content` of a chat completion.
fn answer_text(body: &str) -> Result<String> {
    let v: Value =
        serde_json::from_str(body).map_err(|_| AppError::Other("The model server's answer wasn't JSON".into()))?;
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::Other("The model server's answer had no text".into()))
}

/// The JSON object in a model's answer, which servers without schema support may wrap in prose or a code fence.
fn json_in(content: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(content.trim()) {
        return v.is_object().then_some(v);
    }
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    serde_json::from_str::<Value>(content.get(start..=end)?).ok().filter(Value::is_object)
}

fn error_message(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            let e = v.get("error").unwrap_or(&v);
            e.get("message").and_then(Value::as_str).or_else(|| e.as_str()).map(str::to_owned)
        })
        .unwrap_or_else(|| text.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs() -> Vec<Message> {
        vec![
            Message { role: "system".into(), content: "You are a DJ.".into() },
            Message { role: "user".into(), content: "Pick songs.".into() },
        ]
    }

    fn local() -> Target {
        Target {
            url: "http://127.0.0.1:1/v1/chat/completions".into(),
            key: Some("k".into()),
            model: "dj".into(),
            local: true,
        }
    }

    #[test]
    fn finds_the_chat_endpoint_from_what_people_type() {
        assert_eq!(chat_url("http://localhost:11434").unwrap(), "http://localhost:11434/v1/chat/completions");
        assert_eq!(chat_url(" http://localhost:1234/v1/ ").unwrap(), "http://localhost:1234/v1/chat/completions");
        assert_eq!(chat_url("http://box:8080/v1/chat/completions").unwrap(), "http://box:8080/v1/chat/completions");
        assert!(chat_url("localhost:11434").is_err());
        assert!(chat_url("file:///etc/passwd").is_err());
        assert!(chat_url("").is_err());
    }

    #[test]
    fn asks_for_json_that_fits_the_schema() {
        let schema = json!({ "type": "object" });
        let body = request_body(&local(), &msgs(), Some(&schema), 300);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["schema"], schema);
        assert_eq!(body["max_tokens"], 300);
        assert_eq!(body["messages"][1]["content"], "Pick songs.");
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
    }

    #[test]
    fn other_servers_get_only_standard_fields() {
        let own = Target { local: false, key: None, model: "llama3.2".into(), ..local() };
        let body = request_body(&own, &msgs(), None, 100);
        assert_eq!(body["model"], "llama3.2");
        assert!(body.get("chat_template_kwargs").is_none());
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn reads_the_answer_out_of_a_completion() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"{\"picks\":[1,2]}"}}]}"#;
        assert_eq!(answer_text(body).unwrap(), r#"{"picks":[1,2]}"#);
        assert!(answer_text(r#"{"choices":[]}"#).is_err());
        assert!(answer_text("<html>").is_err());
    }

    #[test]
    fn digs_json_out_of_chatty_answers() {
        assert_eq!(json_in(r#"{"a":1}"#), Some(json!({ "a": 1 })));
        assert_eq!(json_in("Sure! ```json\n{\"a\": [1, 2]}\n``` Enjoy."), Some(json!({ "a": [1, 2] })));
        assert_eq!(json_in("[1, 2]"), None);
        assert_eq!(json_in("no json here"), None);
    }

    #[test]
    fn reads_server_errors() {
        assert_eq!(error_message(r#"{"error":{"message":"model not found"}}"#), "model not found");
        assert_eq!(error_message("Bad Gateway"), "Bad Gateway");
    }

    #[test]
    fn the_server_stays_on_loopback_and_offline() {
        let args: Vec<String> = server_args(Path::new("/m.gguf"), 5000, "key")
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect();
        let after = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str());
        assert_eq!(after("--host"), Some("127.0.0.1"));
        assert_eq!(after("--port"), Some("5000"));
        assert_eq!(after("--api-key"), Some("key"));
        assert_eq!(after("--model"), Some("/m.gguf"));
        assert!(args.contains(&"--offline".to_owned()));
        assert!(args.contains(&"--no-webui".to_owned()));
    }

    #[test]
    fn a_fresh_engine_is_idle() {
        let e = Engine::default();
        assert!(e.idle(Instant::now()));
        e.touch();
        assert!(!e.idle(Instant::now()));
        assert!(e.idle(Instant::now() + IDLE));
    }

    #[tokio::test]
    async fn refuses_to_start_without_the_files() {
        let e = Engine::default();
        let missing = Path::new("/nonexistent/llama-server");
        let err = e.local(missing, Path::new("/nonexistent/m.gguf"), Path::new("/nonexistent/log")).await;
        assert!(matches!(err, Err(AppError::Other(m)) if m.contains("isn't downloaded")));
        assert!(!e.is_running().await);
    }

    #[tokio::test]
    async fn rejects_unknown_roles_before_sending() {
        let bad = vec![Message { role: "tool".into(), content: String::new() }];
        let err = chat(&reqwest::Client::new(), &local(), &bad, None, 10).await;
        assert!(matches!(err, Err(AppError::Other(m)) if m.contains("role")));
    }

    /// Answers one chat request over loopback with `content`, and hands back the request it got.
    async fn fake_server(content: &'static str) -> (Target, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
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
                        .find_map(|l| l.strip_prefix("content-length: ").map(|v| v.trim().parse().unwrap()))
                        .unwrap_or(0);
                    if buf.len() >= i + 4 + len || n == 0 {
                        break;
                    }
                }
            }
            let reply = json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] }).to_string();
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                reply.len()
            );
            sock.write_all(head.as_bytes()).await.unwrap();
            sock.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf).into_owned()
        });
        let target = Target {
            url: format!("http://{addr}/v1/chat/completions"),
            key: Some("secret".into()),
            model: "dj".into(),
            local: true,
        };
        (target, handle)
    }

    #[tokio::test]
    async fn sends_the_conversation_and_returns_the_json() {
        let (target, server) = fake_server(r#"{"picks":[2,1],"intro":"Hi"}"#).await;
        let schema = json!({ "type": "object" });
        let answer = chat(&reqwest::Client::new(), &target, &msgs(), Some(&schema), 200).await.unwrap();
        assert_eq!(answer, json!({ "picks": [2, 1], "intro": "Hi" }));
        let request = server.await.unwrap();
        assert!(request.to_ascii_lowercase().contains("authorization: bearer secret"));
        assert!(request.contains("You are a DJ."));
    }
}
