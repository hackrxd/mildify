//! The DJ's own language model: llama.cpp's `llama-server` running the downloaded model on a loopback port.
//! What's asked of it, and of other servers, is in `chat.rs`.
//!
//! It runs on the graphics card when llama.cpp finds one it can use (`--list-devices`) and the settings allow, with
//! as much of the model on it as fits. A card that fails to load the model, or stops while running it, is left out
//! for the rest of the app's run: the model loads again on the processor.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::process::Child;
use tokio::sync::Mutex;

use serde::Serialize;

use super::chat::{Api, Target};
use crate::error::{AppError, Result};

/// Loading a model from a slow disk can take a while; past this, something is wrong.
const LOAD_TIMEOUT: Duration = Duration::from_secs(240);
/// A graphics card that hasn't loaded the model by now is stuck, and the processor gets its turn.
const CARD_LOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// How long llama.cpp may take to list the graphics cards it can use.
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// The model is unloaded after this long without a request, freeing its memory.
pub const IDLE: Duration = Duration::from_secs(10 * 60);
/// Enough for the prompt (a few dozen songs) and the answer.
const CONTEXT: &str = "4096";
/// How many ports a server is started on, when the one picked is taken before it can listen on it.
const PORT_TRIES: usize = 3;

/// What the model runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    /// The graphics card, with as much of the model on it as fits.
    Gpu,
    Cpu,
}

/// Where the model runs, once it has loaded.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunsOn {
    /// The graphics card, by name; none for the processor.
    pub card: Option<String>,
    /// Why the processor runs it although the card was to: the card failed to.
    pub card_failed: Option<String>,
}

/// Why a server didn't load.
#[derive(Debug)]
enum NotLoaded {
    /// It stopped while loading, or took too long: what the device it was loading on may be to blame for.
    Failed(AppError),
    /// Anything else: the DJ stopped it, there was no port, it couldn't be started.
    Other(AppError),
}

impl std::fmt::Display for NotLoaded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NotLoaded::Failed(e) | NotLoaded::Other(e) => e.fmt(f),
        }
    }
}

impl From<NotLoaded> for AppError {
    fn from(e: NotLoaded) -> Self {
        match e {
            NotLoaded::Failed(e) | NotLoaded::Other(e) => e,
        }
    }
}

/// The server, from the moment it's started.
struct Server {
    id: u64,
    child: Child,
    model: PathBuf,
    device: Device,
    target: Target,
    loaded: bool,
    started: Instant,
    log: PathBuf,
}

pub struct Engine {
    /// Held by whoever is starting a server, so there's one at a time. Stopping one never needs it.
    starting: Mutex<()>,
    /// The server, loading or loaded. Never held across an await, so nothing waits on a load to stop it.
    server: StdMutex<Option<Server>>,
    next_id: AtomicU64,
    /// Bumped by `stop` and `kill_now`, so a load still waiting its turn gives up rather than start a server nobody
    /// wants any more.
    stops: AtomicU64,
    /// `CARD_LOAD_TIMEOUT`, but for tests.
    card_load_timeout: Duration,
    /// For checking on it: straight to the loopback port, never through a proxy.
    http: reqwest::Client,
    last_used: StdMutex<Option<Instant>>,
    /// The graphics card each `llama-server` found, asked once: its path, and the card's name if there's one.
    card: StdMutex<Option<(PathBuf, Option<String>)>>,
    /// Why the graphics card is left out, once it failed.
    card_failed: StdMutex<Option<String>>,
    runs_on: StdMutex<Option<RunsOn>>,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            starting: Mutex::default(),
            server: StdMutex::default(),
            next_id: AtomicU64::new(1),
            stops: AtomicU64::new(0),
            card_load_timeout: CARD_LOAD_TIMEOUT,
            http: reqwest::Client::builder().no_proxy().build().unwrap_or_default(),
            last_used: StdMutex::default(),
            card: StdMutex::default(),
            card_failed: StdMutex::default(),
            runs_on: StdMutex::default(),
        }
    }
}

impl Engine {
    /// The local server for `model`, started (or restarted with a different model) if need be: on the graphics card
    /// when `gpu` allows and there's one it can use, on the processor otherwise.
    pub async fn local(&self, server: &Path, model: &Path, log: &Path, gpu: bool) -> Result<Target> {
        if !server.is_file() || !model.is_file() {
            return Err(AppError::Other("The DJ's model isn't downloaded yet".into()));
        }
        let card = if gpu { self.card(server).await } else { None };
        self.run(model, log, card, |port, key, device| spawn(server, model, port, key, log, device)).await
    }

    /// Loads `model` on `card`, unless there's none or it failed before, and on the processor otherwise, or once the
    /// card fails to load it.
    async fn run(
        &self,
        model: &Path,
        log: &Path,
        card: Option<String>,
        mut spawn: impl FnMut(u16, &str, Device) -> Result<Child>,
    ) -> Result<Target> {
        self.notice_card_stopped();
        if let Some(name) = card.filter(|_| self.card_failed().is_none()) {
            let on_card = |port: u16, key: &str| spawn(port, key, Device::Gpu);
            match self.load(model, log, Device::Gpu, self.card_load_timeout, on_card).await {
                Ok(target) => {
                    *self.runs_on.lock().unwrap() = Some(RunsOn { card: Some(name), card_failed: None });
                    return Ok(target);
                }
                Err(NotLoaded::Failed(e)) => {
                    log::warn!("DJ: the model couldn't load on {name}, so it loads on the processor: {e}");
                    *self.card_failed.lock().unwrap() = Some(e.to_string());
                }
                Err(NotLoaded::Other(e)) => return Err(e),
            }
        }
        let card_failed = self.card_failed();
        match self.load(model, log, Device::Cpu, LOAD_TIMEOUT, |port, key| spawn(port, key, Device::Cpu)).await {
            Ok(target) => {
                *self.runs_on.lock().unwrap() = Some(RunsOn { card: None, card_failed });
                Ok(target)
            }
            Err(NotLoaded::Failed(e)) if card_failed.is_some() => Err(AppError::Other(format!(
                "The DJ's model couldn't load on the graphics card ({}) or on the processor ({e})",
                card_failed.unwrap_or_default()
            ))),
            Err(e) => Err(e.into()),
        }
    }

    /// A server that stopped on its own while it ran on the graphics card leaves the card out from now on.
    fn notice_card_stopped(&self) {
        let mut slot = self.slot();
        let Some(s) = slot.as_mut().filter(|s| s.device == Device::Gpu && s.loaded) else { return };
        if let Ok(Some(status)) = s.child.try_wait() {
            let said = last_line(&s.log).map(|l| format!(". {l}")).unwrap_or_default();
            let why = format!("The DJ's model stopped on the graphics card ({status}){said}");
            *self.card_failed.lock().unwrap() = Some(why);
        }
    }

    fn card_failed(&self) -> Option<String> {
        self.card_failed.lock().unwrap().clone()
    }

    /// The graphics card `server` would run the model on, by name: asked once (`--list-devices`), and none when it
    /// finds none it can use.
    async fn card(&self, server: &Path) -> Option<String> {
        if let Some((asked, card)) = self.card.lock().unwrap().as_ref() {
            if asked == server {
                return card.clone();
            }
        }
        let card = list_devices(server).await.and_then(|said| first_card(&said));
        log::info!("DJ: the model's runtime can use {}", card.as_deref().unwrap_or("no graphics card"));
        *self.card.lock().unwrap() = Some((server.to_owned(), card.clone()));
        card
    }

    /// Where the model runs, since it last loaded.
    pub fn runs_on(&self) -> Option<RunsOn> {
        self.runs_on.lock().unwrap().clone()
    }

    #[cfg(test)]
    pub(crate) fn ran_on(&self, runs_on: RunsOn) {
        *self.runs_on.lock().unwrap() = Some(runs_on);
    }

    /// Has the next load choose where the model runs anew, as the setting to use the graphics card changes: a card
    /// that failed gets another chance, and where the model ran is forgotten.
    pub fn reset_device(&self) {
        *self.card_failed.lock().unwrap() = None;
        *self.runs_on.lock().unwrap() = None;
    }

    /// The server for `model` on `device`, loaded. One still loading for it, which its caller stopped waiting for, is
    /// waited for here rather than started again; anything else is replaced by one `spawn` starts.
    async fn load(
        &self,
        model: &Path,
        log: &Path,
        device: Device,
        timeout: Duration,
        mut spawn: impl FnMut(u16, &str) -> Result<Child>,
    ) -> std::result::Result<Target, NotLoaded> {
        self.touch();
        let stops = self.stops.load(Ordering::SeqCst);
        let _one_at_a_time = self.starting.lock().await;
        if self.stops.load(Ordering::SeqCst) != stops {
            return Err(NotLoaded::Other(unloaded()));
        }
        let mut found = {
            let mut slot = self.slot();
            let same = slot
                .as_mut()
                .is_some_and(|s| s.model == model && s.device == device && matches!(s.child.try_wait(), Ok(None)));
            match slot.as_mut() {
                Some(s) if same => {
                    if s.loaded {
                        return Ok(s.target.clone());
                    }
                    Some((s.id, s.target.clone()))
                }
                Some(s) => {
                    let _ = s.child.start_kill();
                    *slot = None;
                    None
                }
                None => None,
            }
        };
        // The free port found can be taken before the server binds it.
        for _ in 0..PORT_TRIES {
            let (id, target) = match found.take() {
                Some(found) => found,
                None => self.start(model, device, log, stops, &mut spawn).map_err(NotLoaded::Other)?,
            };
            if self.wait_until_loaded(id, &target, log, timeout).await? {
                return Ok(target);
            }
        }
        Err(NotLoaded::Other(AppError::Other("The DJ's model couldn't get a port to listen on".into())))
    }

    /// Starts a server with `spawn` on a free port, as the one in the slot, unless the model was stopped since
    /// `stops` was read.
    fn start(
        &self,
        model: &Path,
        device: Device,
        log: &Path,
        stops: u64,
        spawn: &mut impl FnMut(u16, &str) -> Result<Child>,
    ) -> Result<(u64, Target)> {
        let port = free_port()?;
        let key = crate::config::random_hex(16);
        let child = spawn(port, &key)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let target = Target {
            api: Api::Local,
            url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
            key: Some(key),
            model: "dj".into(),
            tools: false,
            effort: false,
        };
        let server = Server {
            id,
            child,
            model: model.to_owned(),
            device,
            target: target.clone(),
            loaded: false,
            started: Instant::now(),
            log: log.to_owned(),
        };
        let mut slot = self.slot();
        if self.stops.load(Ordering::SeqCst) != stops {
            drop(slot);
            let mut stopped = server.child;
            let _ = stopped.start_kill();
            return Err(unloaded());
        }
        *slot = Some(server);
        Ok((id, target))
    }

    /// Waits for server `id` to answer, for as long as it's the one in the slot and `timeout` allows. False when it
    /// stopped because its port was taken before it could listen on it.
    async fn wait_until_loaded(
        &self,
        id: u64,
        target: &Target,
        log: &Path,
        timeout: Duration,
    ) -> std::result::Result<bool, NotLoaded> {
        let base = target.url.trim_end_matches("/v1/chat/completions");
        let key = target.key.as_deref().unwrap_or_default();
        loop {
            let started = {
                let mut slot = self.slot();
                let Some(s) = slot.as_mut().filter(|s| s.id == id) else { return Err(NotLoaded::Other(unloaded())) };
                if let Ok(Some(status)) = s.child.try_wait() {
                    *slot = None;
                    if port_taken(&std::fs::read_to_string(log).unwrap_or_default()) {
                        log::warn!("DJ: the model's port was taken before it could listen on it; trying another");
                        return Ok(false);
                    }
                    return Err(NotLoaded::Failed(AppError::Other(format!(
                        "The DJ's model stopped while loading ({status}). {}",
                        last_line(log).unwrap_or_default()
                    ))));
                }
                s.started
            };
            if self.answers(base, key).await {
                break;
            }
            if started.elapsed() > timeout {
                let timed_out = {
                    let mut slot = self.slot();
                    if slot.as_ref().is_some_and(|s| s.id == id) { slot.take() } else { None }
                };
                if let Some(mut s) = timed_out {
                    let _ = s.child.kill().await;
                }
                return Err(NotLoaded::Failed(AppError::Other("The DJ's model took too long to load".into())));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let mut slot = self.slot();
        let Some(s) = slot.as_mut().filter(|s| s.id == id) else { return Err(NotLoaded::Other(unloaded())) };
        s.loaded = true;
        let on = if s.device == Device::Gpu { "the graphics card" } else { "the processor" };
        log::info!("DJ model loaded from {} on {on} in {:.1} s", s.model.display(), s.started.elapsed().as_secs_f64());
        Ok(true)
    }

    /// Whether the server at `base` is up, and is ours: `/health` answers anyone, `/props` only its own key.
    async fn answers(&self, base: &str, key: &str) -> bool {
        for path in ["health", "props"] {
            let r = self.http.get(format!("{base}/{path}")).bearer_auth(key).timeout(Duration::from_secs(2)).send().await;
            if !r.is_ok_and(|r| r.status().is_success()) {
                return false;
            }
        }
        true
    }

    fn slot(&self) -> MutexGuard<'_, Option<Server>> {
        self.server.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn touch(&self) {
        *self.last_used.lock().unwrap() = Some(Instant::now());
    }

    /// Stops the local server, loaded or still loading, and waits for it to exit (Windows can't delete its files
    /// before). A caller waiting for it to load is told it was unloaded.
    pub async fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        let taken = self.slot().take();
        if let Some(mut s) = taken {
            let _ = s.child.kill().await;
        }
    }

    /// For app exit, where nothing can wait, and nothing still loading is dropped to kill it: tells the server to
    /// stop, loaded or not.
    pub fn kill_now(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        if let Some(s) = self.slot().as_mut() {
            let _ = s.child.start_kill();
        }
    }

    pub fn is_running(&self) -> bool {
        self.slot().is_some()
    }

    /// Why the server stopped, when it stopped on its own: how it exited, and the last thing it said.
    pub fn died(&self) -> Option<String> {
        let mut slot = self.slot();
        let s = slot.as_mut()?;
        let status = s.child.try_wait().ok().flatten()?;
        let said = last_line(&s.log).map(|l| format!(". {l}")).unwrap_or_default();
        Some(format!("{status}{said}"))
    }

    /// Whether nothing has asked for the model in `IDLE`.
    pub fn idle(&self, now: Instant) -> bool {
        self.last_used.lock().unwrap().is_none_or(|t| now.duration_since(t) >= IDLE)
    }
}

fn unloaded() -> AppError {
    AppError::Other("The DJ's model was unloaded before it finished loading".into())
}

/// Starts `llama-server` for `model` on a loopback `port` and `device`, writing what it says to `log`.
fn spawn(server: &Path, model: &Path, port: u16, key: &str, log: &Path, device: Device) -> Result<Child> {
    let log_file = std::fs::File::create(log)?;
    let mut cmd = tokio::process::Command::new(server);
    cmd.args(server_args(model, port, key, device))
        .current_dir(server.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file))
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    cmd.spawn().map_err(|e| AppError::Other(format!("Couldn't start the DJ's model: {e}")))
}

/// Hides the console window Windows would open for a console program started from a GUI app.
#[cfg(windows)]
pub const NO_WINDOW: u32 = 0x0800_0000;

/// What `llama-server` lists of the devices it can run a model on, without loading one; none when it can't be asked.
async fn list_devices(server: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(server);
    cmd.arg("--list-devices")
        .current_dir(server.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    let out = tokio::time::timeout(LIST_TIMEOUT, cmd.output()).await.ok()?.ok()?;
    Some(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

/// The first graphics card in `--list-devices`' answer, by its description: "  Vulkan0: NVIDIA GeForce RTX 3060
/// (12288 MiB, 11515 MiB free)" is the NVIDIA GeForce RTX 3060. "(none)" lists none.
fn first_card(said: &str) -> Option<String> {
    let listed = &said[said.find("Available devices:")? + "Available devices:".len()..];
    listed.lines().find_map(|line| {
        let (name, rest) = line.trim().split_once(": ")?;
        let description = match rest.rfind(" (") {
            Some(i) if rest.ends_with("MiB free)") => &rest[..i],
            _ => rest,
        };
        Some(if description.trim().is_empty() { name.trim() } else { description.trim() }.to_owned())
    })
}

fn server_args(model: &Path, port: u16, key: &str, device: Device) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["--model".into(), model.into()];
    for a in [
        "--host", "127.0.0.1",
        "--port", &port.to_string(),
        "--api-key", key,
        "--alias", "dj",
        "--ctx-size", CONTEXT,
        // One answer at a time: two would split the context (or need more memory) and share the processor. An ask
        // the DJ stops waiting for hangs up, which frees the slot for the next (`newest` in mod.rs).
        "--parallel", "1",
        "--no-webui",
        // The model's own chat template, which is what understands tool calls and `chat_template_kwargs`.
        "--jinja",
        // Never reaches out to the network, whatever the model file asks.
        "--offline",
    ] {
        args.push(a.into());
    }
    // A graphics card takes as much of the model as fits in its memory, llama.cpp's default; the processor, all of it.
    if device == Device::Cpu {
        args.extend(["--device".into(), "none".into()]);
    }
    args
}

fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// Whether the server's log says its port was taken: llama.cpp's own words, or the system's.
fn port_taken(log: &str) -> bool {
    let log = log.to_lowercase();
    ["couldn't bind http server socket", "address already in use", "only one usage of each socket address"]
        .iter()
        .any(|said| log.contains(said))
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
        let args: Vec<String> = server_args(Path::new("/m.gguf"), 5000, "key", Device::Gpu)
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
        let err = e.local(missing, Path::new("/nonexistent/m.gguf"), Path::new("/nonexistent/log"), true).await;
        assert!(matches!(err, Err(AppError::Other(m)) if m.contains("isn't downloaded")));
        assert!(!e.is_running());
    }

    /// A "server" that never answers: it stays loading until it's stopped.
    #[cfg(unix)]
    fn sleeper() -> Result<Child> {
        Ok(tokio::process::Command::new("sleep").arg("30").kill_on_drop(true).spawn()?)
    }

    #[cfg(unix)]
    fn log_path() -> PathBuf {
        std::env::temp_dir().join(format!("mildify-engine-{}.log", crate::config::random_hex(8)))
    }

    /// Starts loading `model` with a server that never answers, in the background.
    #[cfg(unix)]
    fn loading(e: &std::sync::Arc<Engine>) -> tokio::task::JoinHandle<Result<Target>> {
        let e = e.clone();
        tokio::spawn(async move {
            Ok(e.load(Path::new("/m.gguf"), &log_path(), Device::Cpu, LOAD_TIMEOUT, |_, _| sleeper()).await?)
        })
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_doesnt_wait_for_a_load() {
        let e = std::sync::Arc::new(Engine::default());
        let load = loading(&e);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(e.is_running());
        tokio::time::timeout(Duration::from_secs(1), e.stop()).await.expect("stopping waited for the load");
        assert!(!e.is_running());
        let err = tokio::time::timeout(Duration::from_secs(2), load).await.unwrap().unwrap().unwrap_err();
        assert!(err.to_string().contains("unloaded before it finished loading"), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn quitting_kills_a_server_still_loading() {
        let e = std::sync::Arc::new(Engine::default());
        let load = loading(&e);
        tokio::time::sleep(Duration::from_millis(300)).await;
        e.kill_now();
        let err = tokio::time::timeout(Duration::from_secs(2), load).await.unwrap().unwrap().unwrap_err();
        assert!(err.to_string().contains("stopped while loading"), "{err}");
        assert!(!e.is_running());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_also_stops_a_load_waiting_its_turn() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let e = Arc::new(Engine::default());
        let spawned = Arc::new(AtomicUsize::new(0));
        let load = || {
            let (e, spawned) = (e.clone(), spawned.clone());
            tokio::spawn(async move {
                let spawn = |_: u16, _: &str| {
                    spawned.fetch_add(1, Ordering::SeqCst);
                    sleeper()
                };
                e.load(Path::new("/m.gguf"), &log_path(), Device::Cpu, LOAD_TIMEOUT, spawn).await
            })
        };
        let first = load();
        tokio::time::sleep(Duration::from_millis(300)).await;
        // Another ask, waiting for the first to load the model.
        let waiting = load();
        tokio::time::sleep(Duration::from_millis(100)).await;
        e.stop().await;
        for load in [first, waiting] {
            let err = tokio::time::timeout(Duration::from_secs(2), load).await.unwrap().unwrap().unwrap_err();
            assert!(err.to_string().contains("unloaded before it finished loading"), "{err}");
        }
        assert_eq!(spawned.load(Ordering::SeqCst), 1);
        assert!(!e.is_running());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn quitting_as_a_server_starts_doesnt_leave_it_running() {
        let (e, log) = (Engine::default(), log_path());
        let load = e.load(Path::new("/m.gguf"), &log, Device::Cpu, LOAD_TIMEOUT, |_, _| {
            // The app quits while the server is being started, before it's in the slot to be killed.
            e.kill_now();
            sleeper()
        });
        let err = tokio::time::timeout(Duration::from_secs(2), load).await.unwrap().unwrap_err();
        assert!(err.to_string().contains("unloaded before it finished loading"), "{err}");
        assert!(!e.is_running());
    }

    /// Answers as a loaded server does: `/health` for anyone, and `/props` while `ours` (another server on the port
    /// would turn our key down).
    #[cfg(unix)]
    async fn answer(listener: tokio::net::TcpListener, ours: std::sync::Arc<std::sync::atomic::AtomicBool>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        while let Ok((mut socket, _)) = listener.accept().await {
            let ours = ours.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let props = String::from_utf8_lossy(&buf[..n]).starts_with("GET /props");
                let status = if props && !ours.load(Ordering::SeqCst) { "401 Unauthorized" } else { "200 OK" };
                let reply = format!("HTTP/1.1 {status}\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    }

    #[cfg(unix)]
    async fn answer_ok(listener: tokio::net::TcpListener) {
        answer(listener, std::sync::Arc::new(true.into())).await;
    }

    /// A server on `port` that answers, as `answer` does.
    #[cfg(unix)]
    fn answering(port: u16, ours: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Result<Child> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", port))?;
        listener.set_nonblocking(true)?;
        tokio::spawn(answer(tokio::net::TcpListener::from_std(listener)?, ours));
        sleeper()
    }

    /// A server that stops at once, having said `said`.
    #[cfg(unix)]
    fn failing(log: &Path, said: &str) -> Result<Child> {
        std::fs::write(log, said)?;
        Ok(tokio::process::Command::new("sh").args(["-c", "exit 1"]).kill_on_drop(true).spawn()?)
    }

    #[test]
    fn knows_a_taken_port_from_the_servers_log() {
        assert!(port_taken("main: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8080"));
        assert!(port_taken("bind: Address already in use"));
        assert!(port_taken("Only one usage of each socket address (protocol/network address/port) is normally permitted."));
        assert!(!port_taken("llama_model_load: error loading model: failed to load model"));
        assert!(!port_taken(""));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tries_another_port_when_its_taken() {
        let e = Engine::default();
        let log = log_path();
        let mut ports = Vec::new();
        let load = e.load(Path::new("/m.gguf"), &log, Device::Cpu, LOAD_TIMEOUT, |port, _| {
            ports.push(port);
            if ports.len() < 3 {
                return failing(&log, "main: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8080");
            }
            answering(port, std::sync::Arc::new(true.into()))
        });
        let target = tokio::time::timeout(Duration::from_secs(10), load).await.unwrap().unwrap();
        assert_eq!(ports.len(), 3);
        assert!(target.url.contains(&format!(":{}/", ports[2])), "{}", target.url);
        e.stop().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gives_up_on_ports_after_a_few_and_on_anything_else_at_once() {
        let e = Engine::default();
        let log = log_path();
        let mut spawns = 0;
        let taken = e.load(Path::new("/m.gguf"), &log, Device::Cpu, LOAD_TIMEOUT, |_, _| {
            spawns += 1;
            failing(&log, "bind: Address already in use")
        });
        let err = tokio::time::timeout(Duration::from_secs(10), taken).await.unwrap().unwrap_err();
        assert_eq!(spawns, PORT_TRIES);
        assert!(err.to_string().contains("couldn't get a port"), "{err}");
        let mut spawns = 0;
        let broken = e.load(Path::new("/m.gguf"), &log, Device::Cpu, LOAD_TIMEOUT, |_, _| {
            spawns += 1;
            failing(&log, "llama_model_load: error loading model: failed to load model")
        });
        let err = tokio::time::timeout(Duration::from_secs(5), broken).await.unwrap().unwrap_err();
        assert_eq!(spawns, 1);
        assert!(err.to_string().contains("failed to load model"), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn waits_for_its_own_server_not_another_on_its_port() {
        let e = std::sync::Arc::new(Engine::default());
        let ours = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let load = tokio::spawn({
            let (e, ours) = (e.clone(), ours.clone());
            async move {
                let spawn = |port, _: &str| answering(port, ours.clone());
                e.load(Path::new("/m.gguf"), &log_path(), Device::Cpu, LOAD_TIMEOUT, spawn).await
            }
        });
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(!load.is_finished(), "taken for loaded by another server's /health");
        ours.store(true, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(2), load).await.unwrap().unwrap().unwrap();
        e.stop().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn says_why_a_loaded_server_stopped() {
        let e = Engine::default();
        let log = log_path();
        let load = e.load(Path::new("/m.gguf"), &log, Device::Cpu, LOAD_TIMEOUT, |port, _| {
            let listener = std::net::TcpListener::bind(("127.0.0.1", port))?;
            listener.set_nonblocking(true)?;
            tokio::spawn(answer(tokio::net::TcpListener::from_std(listener)?, std::sync::Arc::new(true.into())));
            std::fs::write(&log, "ggml_abort: out of memory\n")?;
            Ok(tokio::process::Command::new("sh").args(["-c", "sleep 0.5; exit 3"]).kill_on_drop(true).spawn()?)
        });
        tokio::time::timeout(Duration::from_secs(2), load).await.unwrap().unwrap();
        assert_eq!(e.died(), None);
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert_eq!(e.died().as_deref(), Some("exit status: 3. ggml_abort: out of memory"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_load_its_caller_stopped_waiting_for_carries_on_for_the_next() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let e = Engine::default();
        let (model, log) = (Path::new("/m.gguf"), log_path());
        let spawned = Arc::new(AtomicUsize::new(0));
        let port = Arc::new(StdMutex::new(None));
        let first = e.load(model, &log, Device::Cpu, LOAD_TIMEOUT, |p, _| {
            spawned.fetch_add(1, Ordering::SeqCst);
            *port.lock().unwrap() = Some(p);
            sleeper()
        });
        // Given up on, as a newer request would.
        assert!(tokio::time::timeout(Duration::from_millis(300), first).await.is_err());
        assert!(e.is_running());
        let p = port.lock().unwrap().unwrap();
        tokio::spawn(answer_ok(tokio::net::TcpListener::bind(("127.0.0.1", p)).await.unwrap()));
        let next = e.load(model, &log, Device::Cpu, LOAD_TIMEOUT, |_, _| {
            spawned.fetch_add(1, Ordering::SeqCst);
            sleeper()
        });
        let target = tokio::time::timeout(Duration::from_secs(5), next).await.unwrap().unwrap();
        assert_eq!(spawned.load(Ordering::SeqCst), 1);
        assert!(target.url.contains(&format!(":{p}/")), "{}", target.url);
        e.stop().await;
    }

    #[test]
    fn finds_the_graphics_card_llama_cpp_would_use() {
        let listed = concat!(
            "load_backend: loaded CPU backend\n",
            "Available devices:\n",
            "  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11515 MiB free)\n",
            "  Vulkan1: AMD Radeon Graphics (RADV RENOIR) (2048 MiB, 1900 MiB free)\n",
        );
        assert_eq!(first_card(listed).as_deref(), Some("NVIDIA GeForce RTX 3060"));
        let second = "Available devices:\n  Vulkan0: AMD Radeon Graphics (RADV RENOIR) (2048 MiB, 1900 MiB free)\n";
        assert_eq!(first_card(second).as_deref(), Some("AMD Radeon Graphics (RADV RENOIR)"));
        assert_eq!(first_card("Available devices:\n  MTL0: Apple M2\n").as_deref(), Some("Apple M2"));
        // What this build says without one, and something else entirely.
        assert_eq!(first_card("Available devices:\n  (none)\n"), None);
        assert_eq!(first_card("error: unknown argument: --list-devices"), None);
    }

    #[test]
    fn keeps_the_model_off_the_graphics_card_when_it_runs_on_the_processor() {
        let args = |device| -> Vec<String> {
            server_args(Path::new("/m.gguf"), 5000, "key", device).into_iter().map(|a| a.into_string().unwrap()).collect()
        };
        assert!(args(Device::Cpu).windows(2).any(|w| w == ["--device", "none"]), "{:?}", args(Device::Cpu));
        assert!(!args(Device::Gpu).iter().any(|a| a == "--device"));
    }

    /// Loads with `run`, starting the server for each device as `on` says, and the devices it was started on.
    #[cfg(unix)]
    async fn run_with(
        e: &Engine,
        card: Option<&str>,
        mut on: impl FnMut(Device, u16, &Path) -> Result<Child>,
    ) -> (Result<Target>, Vec<Device>) {
        let log = log_path();
        let mut tried = Vec::new();
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            e.run(Path::new("/m.gguf"), &log, card.map(str::to_owned), |port, _, device| {
                tried.push(device);
                on(device, port, &log)
            }),
        )
        .await
        .unwrap();
        (result, tried)
    }

    #[cfg(unix)]
    fn answers_on(port: u16) -> Result<Child> {
        answering(port, std::sync::Arc::new(true.into()))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_on_the_graphics_card_it_finds_or_the_processor_without_one() {
        let e = Engine::default();
        let (loaded, tried) = run_with(&e, Some("NVIDIA GeForce RTX 3060"), |_, port, _| answers_on(port)).await;
        loaded.unwrap();
        assert_eq!(tried, [Device::Gpu]);
        assert_eq!(e.runs_on(), Some(RunsOn { card: Some("NVIDIA GeForce RTX 3060".into()), card_failed: None }));
        e.stop().await;
        let (loaded, tried) = run_with(&e, None, |_, port, _| answers_on(port)).await;
        loaded.unwrap();
        assert_eq!(tried, [Device::Cpu]);
        assert_eq!(e.runs_on(), Some(RunsOn { card: None, card_failed: None }));
        // The model loaded on the processor isn't kept for a card.
        let (loaded, tried) = run_with(&e, Some("Card"), |_, port, _| answers_on(port)).await;
        loaded.unwrap();
        assert_eq!(tried, [Device::Gpu]);
        e.stop().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_load_stopped_on_the_card_doesnt_go_on_to_the_processor() {
        let e = std::sync::Arc::new(Engine::default());
        let tried = std::sync::Arc::new(StdMutex::new(Vec::new()));
        let load = tokio::spawn({
            let (e, tried) = (e.clone(), tried.clone());
            async move {
                e.run(Path::new("/m.gguf"), &log_path(), Some("Card".into()), |_, _, device| {
                    tried.lock().unwrap().push(device);
                    sleeper()
                })
                .await
            }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        e.stop().await;
        let err = tokio::time::timeout(Duration::from_secs(2), load).await.unwrap().unwrap().unwrap_err();
        assert!(err.to_string().contains("unloaded before it finished loading"), "{err}");
        assert_eq!(*tried.lock().unwrap(), [Device::Gpu]);
        assert_eq!(e.card_failed(), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn loads_on_the_processor_when_the_card_fails_and_leaves_the_card_out_after() {
        let e = Engine::default();
        let (loaded, tried) = run_with(&e, Some("Card"), |device, port, log| match device {
            Device::Gpu => failing(log, "ggml_vulkan: vk::Device::createComputePipeline: ErrorDeviceLost"),
            Device::Cpu => answers_on(port),
        })
        .await;
        loaded.unwrap();
        assert_eq!(tried, [Device::Gpu, Device::Cpu]);
        let failed = e.runs_on().unwrap().card_failed.unwrap();
        assert!(failed.contains("ErrorDeviceLost"), "{failed}");
        e.stop().await;
        // Not tried again, until it's given another chance.
        let (_, tried) = run_with(&e, Some("Card"), |_, port, _| answers_on(port)).await;
        assert_eq!(tried, [Device::Cpu]);
        e.stop().await;
        e.reset_device();
        assert_eq!(e.runs_on(), None);
        let (_, tried) = run_with(&e, Some("Card"), |_, port, _| answers_on(port)).await;
        assert_eq!(tried, [Device::Gpu]);
        e.stop().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gives_a_stuck_card_up_for_the_processor() {
        let e = Engine { card_load_timeout: Duration::from_millis(600), ..Engine::default() };
        let (loaded, tried) = run_with(&e, Some("Card"), |device, port, _| match device {
            Device::Gpu => sleeper(),
            Device::Cpu => answers_on(port),
        })
        .await;
        loaded.unwrap();
        assert_eq!(tried, [Device::Gpu, Device::Cpu]);
        assert!(e.runs_on().unwrap().card_failed.unwrap().contains("too long"));
        e.stop().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn says_why_neither_the_card_nor_the_processor_loaded_it() {
        let e = Engine::default();
        let (loaded, tried) = run_with(&e, Some("Card"), |device, _, log| match device {
            Device::Gpu => failing(log, "ggml_vulkan: out of device memory"),
            Device::Cpu => failing(log, "llama_model_load: error loading model"),
        })
        .await;
        let err = loaded.unwrap_err().to_string();
        assert_eq!(tried, [Device::Gpu, Device::Cpu]);
        assert!(err.contains("graphics card") && err.contains("out of device memory"), "{err}");
        assert!(err.contains("processor") && err.contains("error loading model"), "{err}");
        // Only the processor's trouble without a card to blame.
        let e = Engine::default();
        let (loaded, _) = run_with(&e, None, |_, _, log| failing(log, "llama_model_load: error loading model")).await;
        let err = loaded.unwrap_err().to_string();
        assert!(!err.contains("graphics card") && err.contains("error loading model"), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_card_that_stops_running_the_model_is_left_out_next_time() {
        let e = Engine::default();
        let (loaded, _) = run_with(&e, Some("Card"), |device, port, log| {
            assert_eq!(device, Device::Gpu);
            let listener = std::net::TcpListener::bind(("127.0.0.1", port))?;
            listener.set_nonblocking(true)?;
            tokio::spawn(answer(tokio::net::TcpListener::from_std(listener)?, std::sync::Arc::new(true.into())));
            std::fs::write(log, "ggml_vulkan: device lost\n")?;
            Ok(tokio::process::Command::new("sh").args(["-c", "sleep 0.5; exit 3"]).kill_on_drop(true).spawn()?)
        })
        .await;
        loaded.unwrap();
        tokio::time::sleep(Duration::from_millis(900)).await;
        let (loaded, tried) = run_with(&e, Some("Card"), |_, port, _| answers_on(port)).await;
        loaded.unwrap();
        assert_eq!(tried, [Device::Cpu]);
        let failed = e.runs_on().unwrap().card_failed.unwrap();
        assert!(failed.contains("stopped on the graphics card") && failed.contains("device lost"), "{failed}");
        e.stop().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn asks_the_runtime_once_which_card_it_can_use() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("mildify-engine-{}", crate::config::random_hex(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let server = dir.join("llama-server");
        const SERVER: &str = r#"#!/bin/sh
echo asked >> "$(dirname "$0")/asked"
printf 'Available devices:\n  Vulkan0: Test Card (100 MiB, 90 MiB free)\n'
"#;
        std::fs::write(&server, SERVER).unwrap();
        std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = Engine::default();
        let mut card = None;
        // The program was just written: another test's process may still hold it open for writing for a moment.
        for _ in 0..100 {
            card = e.card(&server).await;
            if card.is_some() {
                break;
            }
            *e.card.lock().unwrap() = None;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(card.as_deref(), Some("Test Card"));
        let asked = std::fs::read_to_string(dir.join("asked")).unwrap().lines().count();
        assert_eq!(e.card(&server).await.as_deref(), Some("Test Card"));
        assert_eq!(std::fs::read_to_string(dir.join("asked")).unwrap().lines().count(), asked, "asked again");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
