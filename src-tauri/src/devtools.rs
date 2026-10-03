//! The Spotify desktop app's `--remote-debugging-port`, as far as mild-lyrics uses it to follow
//! the player.
//!
//! Spotify is a Chromium app: started with that flag it serves the Chrome DevTools Protocol on
//! 127.0.0.1:9222, where `/json` lists its pages and a page's websocket runs `Runtime.evaluate` in
//! the window. mild-lyrics (github.com/gcooll/mild-lyrics) reads the player that way, with scripts
//! against Spicetify's globals. This serves the same endpoint with one page target, but runs none of
//! what it's sent: it recognises mild-lyrics' player scripts ([`recognise`]), asks the window for
//! the player state or control they stand for (`src/lib/devtools.ts`), and answers with the value
//! the script would have returned in Spotify. Any other script gets a JavaScript error back.
//!
//! It's off unless the user turns it on, listens on loopback only, and refuses what Chromium
//! refuses: requests that carry an Origin (a web page) or name a host that isn't an IP or localhost
//! (DNS rebinding).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// The port Spotify's flag is given in every guide, mild-lyrics' included.
pub const DEFAULT_PORT: u16 = 9222;

/// Spotify's own launch flag, accepted here to turn the endpoint on for one launch.
const PORT_FLAG: &str = "--remote-debugging-port";

/// The URL of Spotify's main window. Tools pick that window out of the targets by its `xpui`.
const PAGE_URL: &str = "https://xpui.app.spotify.com/index.html";

/// How long the window may take to answer before the caller gets an error. Chromium has no limit,
/// but an answer can be lost here with the window (a reload) and nothing else would end the wait.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);

/// What the error for a script that isn't recognised says.
const UNRECOGNISED: &str = "Mildify doesn't run scripts. It answers mild-lyrics' player reads and controls only.";

/// Asks the window for something; it answers through [`DevTools::answer`] with the same id.
pub type Asker = Arc<dyn Fn(u64, &Ask) + Send + Sync>;

/// What the window is asked for. Mirrored by `DevtoolsAsk` in `src/lib/devtools.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Ask {
    /// The player's state, answered as a [`Snapshot`].
    Snapshot,
    Seek { position_ms: u64 },
    /// 0 to 1, as Spicetify takes it.
    Volume { fraction: f64 },
    TogglePlay,
    Next,
    Back,
}

/// A recognised script.
#[derive(Debug, Clone, PartialEq)]
enum Script {
    /// Reads the player, and returns it in the shape the script builds.
    Read(Shape),
    /// Calls a `Spicetify.Player` control, which returns nothing.
    Control(Ask),
}

#[derive(Debug, Clone, PartialEq)]
enum Shape {
    /// lyrics_gui.py's `JS_STATE`: the playing track, its clocks and the volume.
    State,
    /// spicy_lyrics.py's `JS_WHERE`: track uri, position and whether it's playing.
    Where,
    /// lyrics_gui.py's `JS_ARTISTS`: the playing track's artists and album, if it's still `track_id`.
    Artists { track_id: String },
}

/// The player as the window reports it.
#[derive(Debug, Default, Deserialize)]
pub struct Snapshot {
    track: Option<SnapshotTrack>,
    position_ms: f64,
    playing: bool,
    /// 0 to 100.
    volume: f64,
}

#[derive(Debug, Deserialize)]
struct SnapshotTrack {
    uri: String,
    name: String,
    artists: Vec<Named>,
    album: Named,
    /// The largest cover there is.
    art: Option<String>,
    duration_ms: f64,
    explicit: bool,
}

#[derive(Debug, Deserialize)]
struct Named {
    name: String,
    uri: Option<String>,
}

/// Which of mild-lyrics' scripts `expression` is, if any.
///
/// Controls are matched whole, so nothing can ride along with them. Reads are matched by what's
/// particular to each, since they're long and embed a timeout or track id; whatever else such a
/// script says is never run, so matching one only ever gets the player state back.
fn recognise(expression: &str) -> Option<Script> {
    let call = expression.trim().trim_end_matches(';').trim_end();
    if let Some(control) = call.strip_prefix("Spicetify.Player.") {
        let (name, arg) = control.strip_suffix(')')?.split_once('(')?;
        let number = || arg.trim().parse::<f64>().ok().filter(|n| n.is_finite());
        let ask = match name {
            "seek" => Ask::Seek { position_ms: number()?.max(0.0) as u64 },
            "setVolume" => Ask::Volume { fraction: number()?.clamp(0.0, 1.0) },
            "togglePlay" if arg.is_empty() => Ask::TogglePlay,
            "next" if arg.is_empty() => Ask::Next,
            "back" if arg.is_empty() => Ask::Back,
            _ => return None,
        };
        return Some(Script::Control(ask));
    }
    let has = |s: &str| expression.contains(s);
    if !has("Spicetify.Player") {
        return None;
    }
    if has("getPositionState") && has("album_artist:") {
        return Some(Script::Read(Shape::State));
    }
    if has("artist_name:") && has(".split(\":\").pop() !== ") {
        let quoted = expression.split(".split(\":\").pop() !== ").nth(1)?;
        let track_id = quoted.strip_prefix('"')?.split('"').next()?;
        return Some(Script::Read(Shape::Artists { track_id: track_id.to_owned() }));
    }
    if has("getProgress") && has("pos:") && has("playing:") {
        return Some(Script::Read(Shape::Where));
    }
    None
}

/// What `shape`'s script returns for the player in `s`, as it builds it in Spotify.
fn shape(shape: &Shape, s: &Snapshot) -> Value {
    let track = s.track.as_ref();
    let uri = track.map_or("", |t| t.uri.as_str());
    match shape {
        Shape::State => json!({
            "uri": uri,
            "title": track.map_or("", |t| t.name.as_str()),
            "artist": track.map_or(String::new(), |t| t.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")),
            "album": track.map_or("", |t| t.album.name.as_str()),
            // Spotify's album artist isn't in our player state; the script falls back to "" too.
            "album_artist": "",
            "art": track.and_then(|t| t.art.as_deref()).unwrap_or_default(),
            "length": track.map_or(0.0, |t| t.duration_ms / 1000.0),
            "explicit": track.map(|t| t.explicit),
            "ctl": s.position_ms / 1000.0,
            // The playback engine's own clock, for local playback in Spotify. Ours is already
            // what's audible (librespot reports it), so there's only the one, as on a Connect device.
            "engine": null,
            "playing": s.playing,
            "volume": s.volume / 100.0,
        }),
        Shape::Where => json!({ "uri": uri, "pos": s.position_ms / 1000.0, "playing": s.playing }),
        Shape::Artists { track_id } => match track {
            Some(t) if t.uri.rsplit(':').next() == Some(track_id) => {
                let named = |n: &Named| json!({ "name": n.name, "uri": n.uri.as_deref().unwrap_or_default() });
                json!({
                    "artists": t.artists.iter().filter(|a| !a.name.is_empty()).map(named).collect::<Vec<_>>(),
                    "album": named(&t.album),
                })
            }
            // The player moved on.
            _ => Value::Null,
        },
    }
}

/// A `Runtime.evaluate` result returning `value` by value.
fn returned(value: Value) -> Value {
    let object = match value {
        Value::Null => json!({ "type": "object", "subtype": "null", "value": null }),
        Value::Bool(_) => json!({ "type": "boolean", "value": value }),
        Value::Number(_) => json!({ "type": "number", "value": value }),
        Value::String(_) => json!({ "type": "string", "value": value }),
        Value::Array(_) => json!({ "type": "object", "subtype": "array", "value": value }),
        Value::Object(_) => json!({ "type": "object", "value": value }),
    };
    json!({ "result": object })
}

/// A `Runtime.evaluate` result for a script that threw `message`.
fn threw(message: &str) -> Value {
    let error = json!({ "type": "object", "subtype": "error", "className": "Error", "description": format!("Error: {message}") });
    json!({
        "result": error,
        "exceptionDetails": { "exceptionId": 1, "text": "Uncaught", "lineNumber": 0, "columnNumber": 0, "exception": error },
    })
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DevToolsStatus {
    /// The port being served, if any.
    pub port: Option<u16>,
    /// Why it isn't being served, such as the port being taken.
    pub error: Option<String>,
}

struct Server {
    port: u16,
    task: JoinHandle<()>,
}

pub struct DevTools {
    /// The page target's id, new each launch as Chromium's are.
    target: String,
    next_ask: AtomicU64,
    /// Asks waiting for the window's answer.
    asks: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    server: Mutex<Option<Server>>,
    error: Mutex<Option<String>>,
}

impl DevTools {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            target: crate::config::random_hex(16).to_uppercase(),
            next_ask: AtomicU64::new(1),
            asks: Mutex::new(HashMap::new()),
            server: Mutex::new(None),
            error: Mutex::new(None),
        })
    }

    pub fn status(&self) -> DevToolsStatus {
        DevToolsStatus {
            port: self.server.lock().unwrap().as_ref().map(|s| s.port),
            error: self.error.lock().unwrap().clone(),
        }
    }

    /// Serves `port` (0 picks a free one), or stops serving for `None`. A server already on that
    /// port is left running, connections and all.
    pub async fn serve(self: &Arc<Self>, port: Option<u16>, ask: Asker) {
        {
            let mut server = self.server.lock().unwrap();
            if port.is_some_and(|p| p != 0) && server.as_ref().map(|s| s.port) == port {
                return;
            }
            if let Some(old) = server.take() {
                old.task.abort();
            }
            *self.error.lock().unwrap() = None;
        }
        let Some(port) = port else { return };
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                let port = listener.local_addr().map_or(port, |a| a.port());
                log::info!("DevTools endpoint on 127.0.0.1:{port}");
                let task = tokio::spawn(Arc::clone(self).accept(listener, ask));
                *self.server.lock().unwrap() = Some(Server { port, task });
            }
            Err(e) => {
                log::warn!("couldn't serve DevTools on port {port}: {e}");
                *self.error.lock().unwrap() = Some(format!("Couldn't listen on port {port}: {e}"));
            }
        }
    }

    /// The window's answer to ask `id`: a [`Snapshot`] for [`Ask::Snapshot`], anything for a control.
    pub fn answer(&self, id: u64, value: Value) {
        if let Some(tx) = self.asks.lock().unwrap().remove(&id) {
            let _ = tx.send(value);
        }
    }

    async fn accept(self: Arc<Self>, listener: TcpListener, ask: Asker) {
        // Owned by this task, so stopping the server drops its connections too.
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                got = listener.accept() => match got {
                    Ok((stream, _)) => {
                        connections.spawn(Arc::clone(&self).connection(stream, ask.clone()));
                    }
                    Err(e) => {
                        log::warn!("DevTools accept failed: {e}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                },
                Some(_) = connections.join_next() => {}
            }
        }
    }

    async fn connection(self: Arc<Self>, mut stream: TcpStream, ask: Asker) {
        let Some((head, rest)) = read_head(&mut stream).await else { return };
        let Some(request) = Request::parse(&head) else {
            return respond(&mut stream, "400 Bad Request", "text/plain", "Bad request").await;
        };
        match self.route(&request) {
            Reply::Http { status, content_type, body } => respond(&mut stream, status, content_type, &body).await,
            Reply::Upgrade { key } => {
                let accept = derive_accept_key(key.as_bytes());
                let head = format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                );
                if stream.write_all(head.as_bytes()).await.is_err() {
                    return;
                }
                let ws = WebSocketStream::from_partially_read(stream, rest, Role::Server, None).await;
                self.session(ws, ask).await;
            }
        }
    }

    fn route(&self, request: &Request) -> Reply {
        if let Some(origin) = request.header("origin") {
            return Reply::text("403 Forbidden", format!("Rejected an incoming connection from the {origin} origin."));
        }
        let Some(host) = request.header("host").filter(|h| is_local_host(h)) else {
            return Reply::text("500 Internal Server Error", "Host header is specified and is not an IP address or localhost.");
        };
        if request.method != "GET" {
            return Reply::text("405 Method Not Allowed", "Use GET.");
        }
        let path = request.target.split('?').next().unwrap_or_default();
        match path.trim_end_matches('/') {
            "/json" | "/json/list" => Reply::json(json!([self.page(host)])),
            "/json/version" => Reply::json(json!({
                "Browser": concat!("Mildify/", env!("CARGO_PKG_VERSION")),
                "Protocol-Version": "1.3",
                "webSocketDebuggerUrl": self.page(host)["webSocketDebuggerUrl"],
            })),
            p if p.strip_prefix("/devtools/page/") == Some(&self.target) => {
                let upgrade = request.header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
                match request.header("sec-websocket-key") {
                    Some(key) if upgrade => Reply::Upgrade { key: key.to_owned() },
                    _ => Reply::text("400 Bad Request", "Expected a WebSocket upgrade."),
                }
            }
            _ => Reply::text("404 Not Found", "Unknown path."),
        }
    }

    /// The one page target, as `/json` lists Spotify's main window.
    fn page(&self, host: &str) -> Value {
        json!({
            "description": "",
            "devtoolsFrontendUrl": "",
            "id": self.target,
            "title": "Mildify",
            "type": "page",
            "url": PAGE_URL,
            "webSocketDebuggerUrl": format!("ws://{host}/devtools/page/{}", self.target),
        })
    }

    /// Answers a websocket's messages concurrently, in whatever order they finish, as Chromium does:
    /// mild-lyrics reads the player on one thread while another seeks.
    async fn session(self: Arc<Self>, ws: WebSocketStream<TcpStream>, ask: Asker) {
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let writer = async move {
            while let Some(text) = rx.recv().await {
                if sink.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
        };
        let reader = async move {
            let mut calls = JoinSet::new();
            while let Some(Ok(message)) = source.next().await {
                match message {
                    Message::Text(text) => {
                        let (this, ask, tx) = (Arc::clone(&self), ask.clone(), tx.clone());
                        calls.spawn(async move {
                            if let Some(reply) = this.reply(&text, &ask).await {
                                let _ = tx.send(reply);
                            }
                        });
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        };
        tokio::select! {
            _ = writer => {}
            _ = reader => {}
        }
    }

    /// The reply to one protocol message, or nothing for one without an id.
    async fn reply(&self, text: &str, ask: &Asker) -> Option<String> {
        let message: Value = serde_json::from_str(text).ok()?;
        let id = message.get("id")?.clone();
        let method = message["method"].as_str().unwrap_or_default();
        let outcome = match method {
            "Runtime.evaluate" => match message["params"]["expression"].as_str() {
                Some(expression) => self.evaluate(expression, ask).await,
                None => Err(json!({ "code": -32602, "message": "Invalid parameters", "data": "expression: string value expected" })),
            },
            _ => Err(json!({ "code": -32601, "message": format!("'{method}' wasn't found") })),
        };
        let reply = match outcome {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        Some(reply.to_string())
    }

    async fn evaluate(&self, expression: &str, ask: &Asker) -> Result<Value, Value> {
        match recognise(expression) {
            None => Ok(threw(UNRECOGNISED)),
            Some(Script::Read(read)) => {
                let snapshot = serde_json::from_value(self.ask(Ask::Snapshot, ask).await?).unwrap_or_default();
                Ok(returned(shape(&read, &snapshot)))
            }
            Some(Script::Control(control)) => {
                self.ask(control, ask).await?;
                Ok(json!({ "result": { "type": "undefined" } }))
            }
        }
    }

    async fn ask(&self, what: Ask, ask: &Asker) -> Result<Value, Value> {
        let id = self.next_ask.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.asks.lock().unwrap().insert(id, tx);
        ask(id, &what);
        let answer = tokio::time::timeout(ANSWER_TIMEOUT, rx).await;
        self.asks.lock().unwrap().remove(&id);
        match answer {
            Ok(Ok(value)) => Ok(value),
            _ => Err(json!({ "code": -32000, "message": "Mildify's window didn't answer." })),
        }
    }
}

/// The port from `--remote-debugging-port=N` (or `… N`), Spotify's flag for the endpoint.
pub fn port_flag(args: impl IntoIterator<Item = String>) -> Option<u16> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == PORT_FLAG {
            return args.next()?.parse().ok();
        }
        if let Some(port) = arg.strip_prefix(PORT_FLAG).and_then(|v| v.strip_prefix('=')) {
            return port.parse().ok();
        }
    }
    None
}

/// Whether a Host header names this machine by IP or as localhost, as Chromium requires: a DNS name
/// could be one a web page has pointed at 127.0.0.1.
fn is_local_host(host: &str) -> bool {
    let name = match host.strip_prefix('[') {
        Some(v6) => match v6.split_once(']') {
            Some((name, _)) => name,
            None => return false,
        },
        None => host.rsplit_once(':').map_or(host, |(name, _)| name),
    };
    name.eq_ignore_ascii_case("localhost") || name.parse::<IpAddr>().is_ok()
}

enum Reply {
    Http { status: &'static str, content_type: &'static str, body: String },
    Upgrade { key: String },
}

impl Reply {
    fn text(status: &'static str, body: impl Into<String>) -> Self {
        Reply::Http { status, content_type: "text/plain; charset=UTF-8", body: body.into() }
    }

    fn json(body: Value) -> Self {
        Reply::Http { status: "200 OK", content_type: "application/json; charset=UTF-8", body: body.to_string() }
    }
}

struct Request {
    method: String,
    target: String,
    /// Names lowercased.
    headers: Vec<(String, String)>,
}

impl Request {
    fn parse(head: &str) -> Option<Self> {
        let mut lines = head.split("\r\n");
        let mut first = lines.next()?.split_whitespace();
        let method = first.next()?.to_owned();
        let target = first.next()?.to_owned();
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        Some(Self { method, target, headers })
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

/// Reads up to the end of the request head. Returns the head and any bytes read past it, which
/// belong to the websocket.
async fn read_head(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(end + 4);
            return Some((String::from_utf8_lossy(&buf[..end]).into_owned(), rest));
        }
        if buf.len() > 16 * 1024 {
            return None;
        }
    }
}

async fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    use super::*;

    // mild-lyrics' scripts as it sends them (lyrics_gui.py, spicy_lyrics.py), cut to what tells them apart.
    const JS_WHERE: &str = r#"(() => {
  const P = Spicetify && Spicetify.Player;
  if (!P) return null;
  const it = (P.data || {}).item || (P.data || {}).track || {};
  return {uri: it.uri || "",
          pos: (P.getProgress ? P.getProgress() : 0) / 1000,
          playing: P.isPlaying ? !!P.isPlaying() : false};
})()"#;
    const JS_STATE: &str = r#"(async () => {
  const P = Spicetify && Spicetify.Player;
  if (!P) return null;
  const ctl = (P.getProgress ? P.getProgress() : 0) / 1000;
  let engine = null;
  try {
    const PA = Spicetify.Platform;
    if (PA && PA.PlaybackAPI && PA.PlaybackAPI._isLocal
        && PA.PlayerAPI && PA.PlayerAPI._contextPlayer
        && PA.PlayerAPI._contextPlayer.getPositionState) {
      const got = await Promise.race([
        PA.PlayerAPI._contextPlayer.getPositionState({}),
        new Promise(r => setTimeout(() => r(null), 400))]);
    }
  } catch (e) { engine = null; }
  return {
    uri: it.uri || "",
    album_artist: alArtist,
    ctl: ctl,
    engine: engine,
    playing: P.isPlaying ? !!P.isPlaying() : false,
    volume: P.getVolume ? P.getVolume() : null};
})()"#;
    const JS_ARTISTS: &str = r#"(() => {
  const d = Spicetify && Spicetify.Player && Spicetify.Player.data;
  const it = d && (d.item || d.track);
  if (!it) return null;
  const uri = it.uri || "";
  if (uri && uri.split(":").pop() !== "4uLU6hMCjMI75M1A2tKUQC") return null;   // player moved on
  for (let i = 0; i < 16; i++) {
    const k = i ? "artist_name:" + i : "artist_name";
  }
  return {artists: list, album: {name: al.name || "", uri: al.uri || ""}};
})()"#;

    fn snapshot() -> Snapshot {
        serde_json::from_value(json!({
            "track": {
                "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
                "name": "Never Gonna Give You Up",
                "artists": [{ "name": "Rick Astley", "uri": "spotify:artist:0gxyHStUsqpMadRV0Di1Qt" }, { "name": "Guest", "uri": null }],
                "album": { "name": "Whenever You Need Somebody", "uri": null },
                "art": "https://i.scdn.co/image/large",
                "duration_ms": 213573.0,
                "explicit": false,
            },
            "position_ms": 61500.0,
            "playing": true,
            "volume": 40.0,
        }))
        .unwrap()
    }

    /// Answers like the window, with `snapshot()`, and records what it was asked.
    fn window(devtools: &Arc<DevTools>, asked: Arc<Mutex<Vec<Ask>>>) -> Asker {
        let devtools = Arc::clone(devtools);
        Arc::new(move |id, what| {
            asked.lock().unwrap().push(what.clone());
            let answer = match what {
                Ask::Snapshot => paused_json(),
                _ => Value::Null,
            };
            devtools.answer(id, answer);
        })
    }

    /// A paused player, as the window sends it.
    fn paused_json() -> Value {
        json!({
            "track": { "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "name": "Song", "artists": [], "album": { "name": "", "uri": null }, "art": null, "duration_ms": 1000.0, "explicit": true },
            "position_ms": 500.0, "playing": false, "volume": 100.0,
        })
    }

    async fn serving() -> (Arc<DevTools>, u16, Arc<Mutex<Vec<Ask>>>) {
        let devtools = DevTools::new();
        let asked = Arc::new(Mutex::new(Vec::new()));
        devtools.serve(Some(0), window(&devtools, asked.clone())).await;
        let port = devtools.status().port.unwrap();
        (devtools, port, asked)
    }

    /// Sends a GET with `headers` and returns the raw response.
    async fn get(port: u16, target: &str, headers: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!("GET {target} HTTP/1.1\r\n{headers}\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    fn body(response: &str) -> Value {
        serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
    }

    #[test]
    fn recognises_mild_lyrics_reads() {
        assert_eq!(recognise(JS_STATE), Some(Script::Read(Shape::State)));
        assert_eq!(recognise(JS_WHERE), Some(Script::Read(Shape::Where)));
        assert_eq!(recognise(JS_ARTISTS), Some(Script::Read(Shape::Artists { track_id: "4uLU6hMCjMI75M1A2tKUQC".into() })));
    }

    #[test]
    fn recognises_whole_control_calls_only() {
        let control = |e: &str| match recognise(e) {
            Some(Script::Control(ask)) => Some(ask),
            _ => None,
        };
        assert_eq!(control("Spicetify.Player.seek(61500)"), Some(Ask::Seek { position_ms: 61500 }));
        assert_eq!(control(" Spicetify.Player.seek(-5); "), Some(Ask::Seek { position_ms: 0 }));
        assert_eq!(control("Spicetify.Player.setVolume(0.35)"), Some(Ask::Volume { fraction: 0.35 }));
        assert_eq!(control("Spicetify.Player.setVolume(7)"), Some(Ask::Volume { fraction: 1.0 }));
        assert_eq!(control("Spicetify.Player.togglePlay()"), Some(Ask::TogglePlay));
        assert_eq!(control("Spicetify.Player.next()"), Some(Ask::Next));
        assert_eq!(control("Spicetify.Player.back()"), Some(Ask::Back));

        for other in [
            "Spicetify.Player.seek(1); fetch('https://evil.example')",
            "Spicetify.Player.seek(1)); fetch('x'",
            "Spicetify.Player.seek(NaN)",
            "Spicetify.Player.seek()",
            "Spicetify.Player.next(1)",
            "Spicetify.Player.pause()",
            "document.title",
            "Spicetify.Platform.Session.accessToken",
            "",
        ] {
            assert_eq!(recognise(other), None, "{other}");
        }
    }

    #[test]
    fn state_reads_as_mild_lyrics_builds_it() {
        let state = shape(&Shape::State, &snapshot());
        assert_eq!(
            state,
            json!({
                "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
                "title": "Never Gonna Give You Up",
                "artist": "Rick Astley, Guest",
                "album": "Whenever You Need Somebody",
                "album_artist": "",
                "art": "https://i.scdn.co/image/large",
                "length": 213.573,
                "explicit": false,
                "ctl": 61.5,
                "engine": null,
                "playing": true,
                "volume": 0.4,
            })
        );
        let idle = shape(&Shape::State, &Snapshot::default());
        assert_eq!((&idle["uri"], &idle["explicit"], &idle["length"]), (&json!(""), &Value::Null, &json!(0.0)));
    }

    #[test]
    fn where_and_artists() {
        assert_eq!(
            shape(&Shape::Where, &snapshot()),
            json!({ "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "pos": 61.5, "playing": true })
        );
        assert_eq!(
            shape(&Shape::Artists { track_id: "4uLU6hMCjMI75M1A2tKUQC".into() }, &snapshot()),
            json!({
                "artists": [{ "name": "Rick Astley", "uri": "spotify:artist:0gxyHStUsqpMadRV0Di1Qt" }, { "name": "Guest", "uri": "" }],
                "album": { "name": "Whenever You Need Somebody", "uri": "" },
            })
        );
        assert_eq!(shape(&Shape::Artists { track_id: "another".into() }, &snapshot()), Value::Null);
        assert_eq!(shape(&Shape::Artists { track_id: "x".into() }, &Snapshot::default()), Value::Null);
    }

    #[test]
    fn port_flag_in_either_spelling() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(port_flag(args(&["app", "--remote-debugging-port=9333"])), Some(9333));
        assert_eq!(port_flag(args(&["app", "--remote-debugging-port", "9222"])), Some(9222));
        assert_eq!(port_flag(args(&["app", "--remote-debugging-port"])), None);
        assert_eq!(port_flag(args(&["app", "--remote-debugging-port=x"])), None);
        assert_eq!(port_flag(args(&["app", "--remote-debugging-portal=1"])), None);
        assert_eq!(port_flag(args(&["app", "--safe-mode"])), None);
    }

    #[test]
    fn local_hosts() {
        for host in ["127.0.0.1:9222", "127.0.0.1", "localhost:9222", "LOCALHOST", "[::1]:9222", "[::1]", "192.168.1.5:9222"] {
            assert!(is_local_host(host), "{host}");
        }
        for host in ["evil.example:9222", "localhost.evil.example", "", "[::1"] {
            assert!(!is_local_host(host), "{host}");
        }
    }

    #[tokio::test]
    async fn lists_one_page_like_spotifys_main_window() {
        let (devtools, port, _) = serving().await;
        let response = get(port, "/json", &format!("Host: 127.0.0.1:{port}\r\n")).await;
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        let targets = body(&response);
        let page = &targets[0];
        assert_eq!(targets.as_array().unwrap().len(), 1);
        assert_eq!(page["type"], "page");
        assert!(page["url"].as_str().unwrap().contains("xpui"));
        assert_eq!(page["webSocketDebuggerUrl"], format!("ws://127.0.0.1:{port}/devtools/page/{}", devtools.target));

        let listed = body(&get(port, "/json/list", &format!("Host: localhost:{port}\r\n")).await);
        assert_eq!(listed, json!([devtools.page(&format!("localhost:{port}"))]));
        let version = body(&get(port, "/json/version", &format!("Host: 127.0.0.1:{port}\r\n")).await);
        assert_eq!(version["Protocol-Version"], "1.3");
    }

    #[tokio::test]
    async fn refuses_web_pages_and_rebound_hosts() {
        let (_devtools, port, _) = serving().await;
        let from_page = get(port, "/json", &format!("Host: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\n")).await;
        assert!(from_page.starts_with("HTTP/1.1 403"), "{from_page}");
        let rebound = get(port, "/json", "Host: evil.example:9222\r\n").await;
        assert!(rebound.starts_with("HTTP/1.1 500"), "{rebound}");
        let no_host = get(port, "/json", "").await;
        assert!(no_host.starts_with("HTTP/1.1 500"), "{no_host}");
        assert!(get(port, "/devtools/page/WRONG", &format!("Host: 127.0.0.1:{port}\r\n")).await.starts_with("HTTP/1.1 404"));
    }

    #[tokio::test]
    async fn answers_over_the_websocket() {
        let (devtools, port, asked) = serving().await;
        let url = format!("ws://127.0.0.1:{port}/devtools/page/{}", devtools.target);
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::client_async(url.as_str(), stream).await.unwrap();

        let evaluate = |id: u64, expression: &str| {
            let params = json!({ "expression": expression, "returnByValue": true, "awaitPromise": true });
            Message::text(json!({ "id": id, "method": "Runtime.evaluate", "params": params }).to_string())
        };
        ws.send(evaluate(1, JS_WHERE)).await.unwrap();
        ws.send(evaluate(2, "Spicetify.Player.seek(1000)")).await.unwrap();
        ws.send(evaluate(3, "document.cookie")).await.unwrap();
        ws.send(Message::text(json!({ "id": 4, "method": "Page.navigate", "params": {} }).to_string())).await.unwrap();

        let mut replies = HashMap::new();
        while replies.len() < 4 {
            let reply: Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            replies.insert(reply["id"].as_u64().unwrap(), reply);
        }
        assert_eq!(
            replies[&1]["result"],
            json!({ "result": { "type": "object", "value": { "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "pos": 0.5, "playing": false } } })
        );
        assert_eq!(replies[&2]["result"], json!({ "result": { "type": "undefined" } }));
        assert_eq!(replies[&3]["result"]["exceptionDetails"]["exception"]["description"], format!("Error: {UNRECOGNISED}"));
        assert_eq!(replies[&4]["error"]["code"], -32601);

        let mut asked = asked.lock().unwrap().clone();
        asked.sort_by_key(|a| format!("{a:?}"));
        assert_eq!(asked, vec![Ask::Seek { position_ms: 1000 }, Ask::Snapshot]);
        assert!(devtools.asks.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_a_websocket_from_a_web_page() {
        let (devtools, port, _) = serving().await;
        let url = format!("ws://127.0.0.1:{port}/devtools/page/{}", devtools.target);
        let mut request = url.into_client_request().unwrap();
        request.headers_mut().insert("Origin", "https://evil.example".parse().unwrap());
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        assert!(tokio_tungstenite::client_async(request, stream).await.is_err());
    }

    #[tokio::test]
    async fn stops_and_reports_a_taken_port() {
        let (devtools, port, asked) = serving().await;
        let other = DevTools::new();
        other.serve(Some(port), window(&other, asked.clone())).await;
        assert_eq!(other.status().port, None);
        assert!(other.status().error.unwrap().contains(&port.to_string()));

        devtools.serve(None, window(&devtools, asked.clone())).await;
        assert_eq!(devtools.status(), DevToolsStatus::default());
        // The listener goes with the aborted task; give the runtime a moment to drop it.
        tokio::time::sleep(Duration::from_millis(50)).await;
        other.serve(Some(port), window(&other, asked)).await;
        assert_eq!(other.status(), DevToolsStatus { port: Some(port), error: None });
    }
}
