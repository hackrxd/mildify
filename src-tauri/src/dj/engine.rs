//! The DJ's own language model: llama.cpp's `llama-server` running the downloaded model on a loopback port.
//! What's asked of it, and of other servers, is in `chat.rs`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use super::chat::{Api, Target};
use crate::error::{AppError, Result};

/// Loading a model from a slow disk can take a while; past this, something is wrong.
const LOAD_TIMEOUT: Duration = Duration::from_secs(240);
/// The model is unloaded after this long without a request, freeing its memory.
pub const IDLE: Duration = Duration::from_secs(10 * 60);
/// Enough for the prompt (a few dozen songs) and the answer.
const CONTEXT: &str = "4096";

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
    let started = Instant::now();
    let deadline = started + LOAD_TIMEOUT;
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
    log::info!("DJ model loaded from {} in {:.1} s", model.display(), started.elapsed().as_secs_f64());
    Ok(Running {
        child,
        model: model.to_owned(),
        target: Target {
            api: Api::Local,
            url: format!("{base}/v1/chat/completions"),
            key: Some(key),
            model: "dj".into(),
            tools: false,
            effort: false,
        },
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
        // The model's own chat template, which is what understands tool calls and `chat_template_kwargs`.
        "--jinja",
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(args.contains(&"--jinja".to_owned()));
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
}
