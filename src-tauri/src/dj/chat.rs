//! Talking to the DJ's language model, wherever it runs: our own llama-server, the user's own server, or a
//! cloud provider (OpenAI, Google Gemini, Anthropic). One request per question: either JSON held to a schema,
//! or a chance to call the DJ's tools (looking songs up) before it answers.
//!
//! OpenAI, Gemini (through Google's OpenAI-compatible endpoint), llama.cpp and the servers people run at home
//! all speak OpenAI's chat completions; Anthropic has its own Messages API.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};

/// Writing one segment's picks and intro, on a CPU.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(240);
/// Room to answer for cloud models, which may think first; only what's used is billed.
const CLOUD_MAX_TOKENS: u32 = 8000;
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Anthropic models that hand a request they decline to another model instead of refusing outright.
const ANTHROPIC_FALLBACK_MODELS: [&str; 4] = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

pub const OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";
pub const GEMINI_URL: &str = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
pub const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: String,
    pub content: String,
}

/// Who answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Api {
    /// Our own llama-server.
    Local,
    /// The user's own OpenAI-compatible server.
    Own,
    OpenAi,
    Gemini,
    Anthropic,
}

impl Api {
    pub fn cloud(self) -> bool {
        matches!(self, Api::OpenAi | Api::Gemini | Api::Anthropic)
    }

    /// The provider as the user knows it, for messages.
    pub fn name(self) -> &'static str {
        match self {
            Api::Local => "The DJ's model",
            Api::Own => "Your model server",
            Api::OpenAi => "OpenAI",
            Api::Gemini => "Google Gemini",
            Api::Anthropic => "Anthropic",
        }
    }
}

/// Where to send chat requests.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub api: Api,
    /// The full chat URL.
    pub url: String,
    pub key: Option<String>,
    pub model: String,
    /// The model can call tools.
    pub tools: bool,
    /// Anthropic: the model takes `effort`, so it can be asked to think briefly.
    pub effort: bool,
}

/// A tool the model may call, described for it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// JSON Schema of its arguments.
    pub parameters: Value,
}

/// What to ask for.
pub enum Ask<'a> {
    /// An answer in JSON fitting this schema.
    Json(&'a Value),
    /// Any calls to these tools the model wants to make first.
    LookUp(&'a [Tool]),
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
}

/// The model's answer: the JSON asked for, the tools it called, or (looking up) what it said instead.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Answer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
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

/// Asks the model.
pub async fn chat(http: &reqwest::Client, target: &Target, messages: &[Message], ask: Ask<'_>, max_tokens: u32) -> Result<Answer> {
    if let Some(bad) = messages.iter().find(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant")) {
        return Err(AppError::Other(format!("Unknown chat role {}", bad.role)));
    }
    if let (Ask::LookUp(_), false) = (&ask, target.tools) {
        return Err(AppError::Other(format!("{} can't look things up", target.api.name())));
    }
    let body = match target.api {
        Api::Anthropic => anthropic_body(target, messages, &ask),
        _ => openai_body(target, messages, &ask, max_tokens),
    };
    let mut request = http.post(&target.url).json(&body).timeout(ANSWER_TIMEOUT);
    if let Some(key) = &target.key {
        request = match target.api {
            Api::Anthropic => request.header("x-api-key", key).header("anthropic-version", ANTHROPIC_VERSION),
            _ => request.bearer_auth(key),
        };
    }
    if target.api == Api::Anthropic && ANTHROPIC_FALLBACK_MODELS.contains(&target.model.as_str()) {
        request = request.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let key = target.key.as_deref();
    let resp = request.send().await.map_err(|e| match target.api {
        Api::Local => AppError::Http(e),
        Api::Own => AppError::Other(masked(&format!("Couldn't reach your model server at {}: {e}", target.url), key)),
        api => AppError::Other(masked(&format!("Couldn't reach {}: {e}", api.name()), key)),
    })?;
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if !(200..300).contains(&status) {
        return Err(refused(target.api, status, &masked(&error_message(&text), key)));
    }
    let answer = match target.api {
        Api::Anthropic => anthropic_answer(&text)?,
        _ => openai_answer(&text)?,
    };
    match ask {
        Ask::Json(_) => {
            let said = answer.text.as_deref().unwrap_or_default();
            let json = json_in(said).ok_or_else(|| AppError::Other("The DJ's model didn't answer in JSON".into()))?;
            Ok(Answer { json: Some(json), ..Default::default() })
        }
        Ask::LookUp(_) => Ok(answer),
    }
}

/// An error answer, said the way the user can act on it.
fn refused(api: Api, status: u16, message: &str) -> AppError {
    let who = api.name();
    AppError::Other(match (api.cloud(), status) {
        (true, 401 | 403) => format!("{who} didn't accept your API key: {message}"),
        (true, 402) => format!("Your {who} account is out of credit: {message}"),
        (true, 429) => format!("{who} is limiting your key (too many requests, or out of credit): {message}"),
        (true, 500..) => format!("{who} is having trouble right now ({status}): {message}"),
        _ => format!("{who} answered {status}: {message}"),
    })
}

/// Cloud models are given only the schema features every provider takes; the answer is checked anyway.
fn sanitised(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" | "minLength" | "maxLength"
                            | "minItems" | "maxItems"
                    )
                })
                .map(|(k, v)| (k.clone(), sanitised(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(sanitised).collect()),
        v => v.clone(),
    }
}

/// An OpenAI-style chat completion. llama-server takes `chat_template_kwargs`; the user's own server might
/// refuse fields it doesn't know, so it only gets the standard ones; OpenAI's reasoning models take neither
/// `temperature` nor `max_tokens`.
fn openai_body(target: &Target, messages: &[Message], ask: &Ask, max_tokens: u32) -> Value {
    let mut body = json!({ "model": target.model, "messages": messages, "stream": false });
    match target.api {
        Api::OpenAi => body["max_completion_tokens"] = json!(CLOUD_MAX_TOKENS),
        Api::Gemini => body["max_tokens"] = json!(CLOUD_MAX_TOKENS),
        _ => {
            body["temperature"] = json!(0.8);
            body["max_tokens"] = json!(max_tokens);
        }
    }
    let cloud = target.api.cloud();
    let schema_for = |s: &Value| if cloud { sanitised(s) } else { s.clone() };
    match ask {
        Ask::Json(schema) => {
            body["response_format"] = json!({
                "type": "json_schema",
                "json_schema": { "name": "dj_segment", "strict": true, "schema": schema_for(schema) },
            });
        }
        Ask::LookUp(tools) => {
            body["tools"] = tools
                .iter()
                .map(|t| {
                    json!({ "type": "function", "function": {
                        "name": t.name, "description": t.description, "parameters": schema_for(&t.parameters),
                    }})
                })
                .collect();
            body["tool_choice"] = json!("auto");
        }
    }
    if target.api == Api::Local {
        // Qwen3 thinks out loud by default; a DJ line doesn't need it.
        body["chat_template_kwargs"] = json!({ "enable_thinking": false });
    }
    body
}

/// An Anthropic Messages API request: system text goes on its own, and the answer's format and the tools are
/// part of the request. Forcing a tool call isn't allowed on current models, so the model is offered them.
fn anthropic_body(target: &Target, messages: &[Message], ask: &Ask) -> Value {
    let system: Vec<&str> = messages.iter().filter(|m| m.role == "system").map(|m| m.content.as_str()).collect();
    let chat: Vec<Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({ "model": target.model, "max_tokens": CLOUD_MAX_TOKENS, "messages": chat });
    if !system.is_empty() {
        body["system"] = json!(system.join("\n\n"));
    }
    let mut output = serde_json::Map::new();
    if target.effort {
        // A DJ line is short work.
        output.insert("effort".into(), json!("low"));
    }
    match ask {
        Ask::Json(schema) => {
            output.insert("format".into(), json!({ "type": "json_schema", "schema": sanitised(schema) }));
        }
        Ask::LookUp(tools) => {
            body["tools"] = tools
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": sanitised(&t.parameters) }))
                .collect();
            body["tool_choice"] = json!({ "type": "auto" });
        }
    }
    if !output.is_empty() {
        body["output_config"] = Value::Object(output);
    }
    if ANTHROPIC_FALLBACK_MODELS.contains(&target.model.as_str()) {
        body["fallbacks"] = json!("default");
    }
    body
}

fn parse(body: &str) -> Result<Value> {
    serde_json::from_str(body).map_err(|_| AppError::Other("The model's answer wasn't JSON".into()))
}

/// `choices[0].message` of a chat completion: its text, and any tool calls (whose arguments are a JSON string).
/// A refusal, or an answer cut off at the token limit, is no answer.
fn openai_answer(body: &str) -> Result<Answer> {
    let v = parse(body)?;
    let message = &v["choices"][0]["message"];
    if message["refusal"].as_str().is_some_and(|r| !r.trim().is_empty()) {
        return Err(AppError::Other("The model declined to answer".into()));
    }
    match v["choices"][0]["finish_reason"].as_str() {
        Some("length") => return Err(AppError::Other("The model ran out of room to answer".into())),
        Some("content_filter") => return Err(AppError::Other("The model declined to answer".into())),
        _ => {}
    }
    let calls: Vec<ToolCall> = message["tool_calls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let f = &c["function"];
            let arguments = match &f["arguments"] {
                Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                other => other.clone(),
            };
            Some(ToolCall { name: f["name"].as_str()?.to_owned(), arguments })
        })
        .collect();
    let text = message["content"].as_str().filter(|s| !s.trim().is_empty()).map(str::to_owned);
    if calls.is_empty() && text.is_none() {
        return Err(AppError::Other("The model's answer had no text".into()));
    }
    Ok(Answer { json: None, calls, text })
}

/// An Anthropic message: its text blocks and tool calls. Thinking blocks aren't for us. A refusal, or an answer
/// cut off at the token limit, is no answer.
fn anthropic_answer(body: &str) -> Result<Answer> {
    let v = parse(body)?;
    match v["stop_reason"].as_str() {
        Some("refusal") => return Err(AppError::Other("Anthropic's model declined to answer".into())),
        Some("max_tokens") => return Err(AppError::Other("Anthropic's model ran out of room to answer".into())),
        _ => {}
    }
    let mut answer = Answer::default();
    let mut text = String::new();
    for block in v["content"].as_array().into_iter().flatten() {
        match block["type"].as_str() {
            Some("text") => text.push_str(block["text"].as_str().unwrap_or_default()),
            Some("tool_use") => {
                if let Some(name) = block["name"].as_str() {
                    answer.calls.push(ToolCall { name: name.to_owned(), arguments: block["input"].clone() });
                }
            }
            _ => {}
        }
    }
    if !text.trim().is_empty() {
        answer.text = Some(text);
    }
    if answer.calls.is_empty() && answer.text.is_none() {
        return Err(AppError::Other("The model's answer had no text".into()));
    }
    Ok(answer)
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

/// `text` with the key, and anything shaped like a provider's API key, shown only by its last four characters.
fn masked(text: &str, key: Option<&str>) -> String {
    let mut out = text.to_owned();
    if let Some(key) = key.filter(|k| k.len() >= 8) {
        out = out.replace(key, &hidden(key));
    }
    out.split_inclusive(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .map(|piece| {
            let word = piece.trim_end_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'));
            let looks_like_key =
                word.len() >= 20 && ["sk-", "sk_", "AIza", "xai-", "gsk_"].iter().any(|p| word.starts_with(p));
            if looks_like_key { piece.replacen(word, &hidden(word), 1) } else { piece.to_owned() }
        })
        .collect()
}

fn hidden(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

/// The message in an error body: `{"error": {"message"}}`, `{"error": "…"}`, or Gemini's `[{"error": …}]`.
fn error_message(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            let v = v.as_array().and_then(|a| a.first().cloned()).unwrap_or(v);
            let e = v.get("error").cloned().unwrap_or(v);
            e.get("message").and_then(Value::as_str).or_else(|| e.as_str()).map(str::to_owned)
        })
        .unwrap_or_else(|| text.chars().take(200).collect())
}

/// A model a provider offers.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelChoice {
    pub id: String,
    pub label: String,
}

/// The models `api` offers with `key`, newest first where the list says.
pub async fn models(http: &reqwest::Client, api: Api, key: &str) -> Result<Vec<ModelChoice>> {
    let request = match api {
        Api::OpenAi => http.get("https://api.openai.com/v1/models").bearer_auth(key),
        Api::Gemini => http.get("https://generativelanguage.googleapis.com/v1beta/openai/models").bearer_auth(key),
        Api::Anthropic => http
            .get("https://api.anthropic.com/v1/models?limit=100")
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        _ => return Ok(Vec::new()),
    };
    let resp = request
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Couldn't reach {}: {e}", api.name())))?;
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if !(200..300).contains(&status) {
        return Err(refused(api, status, &error_message(&text)));
    }
    Ok(model_list(api, &parse(&text)?))
}

/// Whether an OpenAI model takes the JSON schema the DJ asks for its answer against: the ones from before
/// Structured Outputs turn it down.
fn answers_in_json(id: &str) -> bool {
    !(id.starts_with("gpt-3")
        || id == "gpt-4"
        || id.starts_with("gpt-4-")
        || id == "gpt-4o-2024-05-13"
        || id.starts_with("o1-mini")
        || id.starts_with("o1-preview"))
}

/// The chat models in a provider's model list.
fn model_list(api: Api, list: &Value) -> Vec<ModelChoice> {
    let mut found: Vec<(i64, ModelChoice)> = list["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["id"].as_str()?.trim_start_matches("models/").to_owned();
            let chat = match api {
                Api::OpenAi => {
                    (id.starts_with("gpt-") || id.starts_with('o') && id[1..].starts_with(char::is_numeric))
                        // Nor the ones only OpenAI's Responses API serves.
                        && !["audio", "realtime", "transcribe", "tts", "image", "search", "embedding", "instruct", "codex", "-pro", "deep-research"]
                            .iter()
                            .any(|w| id.contains(w))
                        && answers_in_json(&id)
                }
                Api::Gemini => {
                    id.starts_with("gemini")
                        && !["embedding", "tts", "image", "live", "audio"].iter().any(|w| id.contains(w))
                }
                // The DJ asks for its answer as JSON fitting a schema; models that can't do that are left out. A
                // list without capabilities says nothing either way.
                Api::Anthropic => m["capabilities"]["structured_outputs"]["supported"].as_bool() != Some(false),
                _ => true,
            };
            let label = m["display_name"].as_str().map(str::to_owned).unwrap_or_else(|| id.clone());
            let created = m["created"].as_i64().unwrap_or(0);
            chat.then_some((created, ModelChoice { id, label }))
        })
        .collect();
    // OpenAI's list isn't in order and Gemini's has no dates; Anthropic's is newest first already.
    match api {
        Api::OpenAi => found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id))),
        Api::Gemini => found.sort_by(|a, b| {
            let rank = |id: &str| (gemini_version(id), !id.contains("preview") && !id.contains("exp"));
            rank(&b.1.id).partial_cmp(&rank(&a.1.id)).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.id.cmp(&b.1.id))
        }),
        _ => {}
    }
    found.into_iter().map(|(_, m)| m).collect()
}

/// The version in a Gemini model's name: 2.5 for gemini-2.5-flash; 0 without one.
fn gemini_version(id: &str) -> f64 {
    id.trim_start_matches("gemini-").split('-').next().and_then(|v| v.parse().ok()).unwrap_or(0.0)
}

/// Whether an Anthropic model takes `effort`, from its entry in the Models API.
pub async fn anthropic_effort(http: &reqwest::Client, key: &str, model: &str) -> Result<bool> {
    let resp = http
        .get(format!("https://api.anthropic.com/v1/models/{model}"))
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Couldn't reach Anthropic: {e}")))?;
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if !(200..300).contains(&status) {
        return Err(refused(Api::Anthropic, status, &error_message(&text)));
    }
    Ok(takes_effort(&parse(&text)?))
}

fn takes_effort(model: &Value) -> bool {
    model["capabilities"]["effort"]["low"]["supported"].as_bool().unwrap_or(false)
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

    fn target(api: Api) -> Target {
        Target {
            api,
            url: "http://127.0.0.1:1/v1/chat/completions".into(),
            key: Some("k".into()),
            model: "dj".into(),
            tools: true,
            effort: false,
        }
    }

    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "songs": { "type": "array", "items": { "type": "integer", "minimum": 1, "maximum": 9 }, "maxItems": 5 },
                "talk": { "type": "string", "maxLength": 400 },
            },
            "required": ["songs", "talk"],
            "additionalProperties": false,
        })
    }

    fn tools() -> Vec<Tool> {
        vec![Tool {
            name: "look_up_songs".into(),
            description: "Look songs up.".into(),
            parameters: json!({ "type": "object", "properties": { "songs": { "type": "array", "maxItems": 5 } } }),
        }]
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
    fn asks_the_local_model_for_json_that_fits_the_schema() {
        let s = schema();
        let body = openai_body(&target(Api::Local), &msgs(), &Ask::Json(&s), 300);
        assert_eq!(body["response_format"]["type"], "json_schema");
        // Our own llama-server enforces every constraint.
        assert_eq!(body["response_format"]["json_schema"]["schema"], s);
        assert_eq!(body["max_tokens"], 300);
        assert_eq!(body["temperature"], 0.8);
        assert_eq!(body["messages"][1]["content"], "Pick songs.");
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn other_servers_get_only_standard_fields() {
        let own = Target { api: Api::Own, key: None, model: "llama3.2".into(), ..target(Api::Own) };
        let tools = tools();
        let body = openai_body(&own, &msgs(), &Ask::LookUp(&tools), 100);
        assert_eq!(body["model"], "llama3.2");
        assert!(body.get("chat_template_kwargs").is_none());
        assert!(body.get("response_format").is_none());
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "look_up_songs");
        assert_eq!(body["tool_choice"], "auto");
    }

    #[test]
    fn cloud_models_get_room_to_think_and_a_schema_they_all_take() {
        let s = schema();
        let openai = openai_body(&target(Api::OpenAi), &msgs(), &Ask::Json(&s), 300);
        assert_eq!(openai["max_completion_tokens"], CLOUD_MAX_TOKENS);
        assert!(openai.get("max_tokens").is_none());
        assert!(openai.get("temperature").is_none());
        let sent = &openai["response_format"]["json_schema"]["schema"];
        assert!(sent["properties"]["songs"].get("maxItems").is_none());
        assert!(sent["properties"]["songs"]["items"].get("minimum").is_none());
        assert!(sent["properties"]["talk"].get("maxLength").is_none());
        assert_eq!(sent["additionalProperties"], false);
        assert_eq!(sent["required"], json!(["songs", "talk"]));
        let gemini = openai_body(&target(Api::Gemini), &msgs(), &Ask::Json(&s), 300);
        assert_eq!(gemini["max_tokens"], CLOUD_MAX_TOKENS);
        assert!(gemini.get("chat_template_kwargs").is_none());
    }

    #[test]
    fn speaks_anthropics_messages_api() {
        let s = schema();
        let mut t = Target { model: "claude-opus-5-5".into(), effort: true, ..target(Api::Anthropic) };
        let body = anthropic_body(&t, &msgs(), &Ask::Json(&s));
        assert_eq!(body["system"], "You are a DJ.");
        assert_eq!(body["messages"], json!([{ "role": "user", "content": "Pick songs." }]));
        assert_eq!(body["max_tokens"], CLOUD_MAX_TOKENS);
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert!(body["output_config"]["format"]["schema"]["properties"]["talk"].get("maxLength").is_none());
        assert_eq!(body["output_config"]["effort"], "low");
        assert_eq!(body["fallbacks"], "default");
        assert!(body.get("temperature").is_none());
        assert!(body.get("thinking").is_none());

        let tools = tools();
        t.model = "claude-haiku-4-5".into();
        t.effort = false;
        let body = anthropic_body(&t, &msgs(), &Ask::LookUp(&tools));
        assert_eq!(body["tools"][0]["name"], "look_up_songs");
        assert!(body["tools"][0]["input_schema"]["properties"]["songs"].get("maxItems").is_none());
        assert_eq!(body["tool_choice"], json!({ "type": "auto" }));
        assert!(body.get("output_config").is_none());
        assert!(body.get("fallbacks").is_none());
    }

    #[test]
    fn reads_answers_and_tool_calls_out_of_a_completion() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"{\"picks\":[1,2]}"}}]}"#;
        assert_eq!(openai_answer(body).unwrap().text.as_deref(), Some(r#"{"picks":[1,2]}"#));
        let calls = r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
            {"id":"c1","type":"function","function":{"name":"look_up_songs","arguments":"{\"songs\":[2,5]}"}}]}}]}"#;
        let answer = openai_answer(calls).unwrap();
        assert_eq!(answer.calls, vec![ToolCall { name: "look_up_songs".into(), arguments: json!({ "songs": [2, 5] }) }]);
        assert_eq!(answer.text, None);
        assert!(openai_answer(r#"{"choices":[]}"#).is_err());
        assert!(openai_answer("<html>").is_err());
    }

    #[test]
    fn a_cut_off_or_refused_completion_says_so() {
        let cut = r#"{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"{\"songs\":[1,"}}]}"#;
        assert_eq!(openai_answer(cut).unwrap_err().to_string(), "The model ran out of room to answer");
        let refusal = r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":null,"refusal":"I can't help with that."}}]}"#;
        assert_eq!(openai_answer(refusal).unwrap_err().to_string(), "The model declined to answer");
        let filtered = r#"{"choices":[{"finish_reason":"content_filter","message":{"role":"assistant","content":"x"}}]}"#;
        assert_eq!(openai_answer(filtered).unwrap_err().to_string(), "The model declined to answer");
        let fine = r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"{}","refusal":null}}]}"#;
        assert!(openai_answer(fine).is_ok());
    }

    #[test]
    fn hides_keys_in_what_a_provider_says() {
        let key = "sk-proj-abcdefghijklmnopqrstuvwxyz1234";
        assert_eq!(masked(&format!("Incorrect API key provided: {key}."), Some(key)), "Incorrect API key provided: …1234.");
        // A key the provider names that isn't the one sent, by its shape.
        assert_eq!(masked("bad key AIzaSyA1234567890abcdefghijklmnop here", None), "bad key …mnop here");
        assert_eq!(masked("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX", None), "…UVWX");
        // Ordinary words and short ids stay.
        assert_eq!(masked("model sk-1 not found (request req_011CfjPXcS9wguPMcLBay9Vv)", None), "model sk-1 not found (request req_011CfjPXcS9wguPMcLBay9Vv)");
    }

    #[test]
    fn reads_anthropic_text_and_tool_use_blocks() {
        let body = r#"{"stop_reason":"tool_use","content":[
            {"type":"thinking","thinking":""},
            {"type":"text","text":"Let me check."},
            {"type":"tool_use","id":"t1","name":"look_up_songs","input":{"songs":[3]}}]}"#;
        let answer = anthropic_answer(body).unwrap();
        assert_eq!(answer.text.as_deref(), Some("Let me check."));
        assert_eq!(answer.calls, vec![ToolCall { name: "look_up_songs".into(), arguments: json!({ "songs": [3] }) }]);
        let refusal = r#"{"stop_reason":"refusal","content":[]}"#;
        assert!(matches!(anthropic_answer(refusal), Err(AppError::Other(m)) if m.contains("declined")));
        let cut = r#"{"stop_reason":"max_tokens","content":[{"type":"text","text":"{\"songs\":"}]}"#;
        assert!(anthropic_answer(cut).is_err());
    }

    #[test]
    fn digs_json_out_of_chatty_answers() {
        assert_eq!(json_in(r#"{"a":1}"#), Some(json!({ "a": 1 })));
        assert_eq!(json_in("Sure! ```json\n{\"a\": [1, 2]}\n``` Enjoy."), Some(json!({ "a": [1, 2] })));
        assert_eq!(json_in("[1, 2]"), None);
        assert_eq!(json_in("no json here"), None);
    }

    #[test]
    fn says_what_went_wrong_in_words_the_user_can_act_on() {
        assert_eq!(error_message(r#"{"error":{"message":"model not found"}}"#), "model not found");
        assert_eq!(error_message(r#"[{"error":{"code":400,"message":"API key not valid"}}]"#), "API key not valid");
        assert_eq!(error_message("Bad Gateway"), "Bad Gateway");
        let e = refused(Api::OpenAi, 401, "Incorrect API key").to_string();
        assert!(e.contains("OpenAI didn't accept your API key"), "{e}");
        let e = refused(Api::Anthropic, 429, "rate_limit_error").to_string();
        assert!(e.contains("Anthropic is limiting your key"), "{e}");
        let e = refused(Api::Own, 404, "model not found").to_string();
        assert!(e.contains("Your model server answered 404"), "{e}");
        assert!(!e.contains("Spotify"));
    }

    #[test]
    fn lists_the_chat_models_a_provider_offers() {
        let openai = json!({ "data": [
            { "id": "gpt-old", "created": 1 },
            { "id": "gpt-new", "created": 3 },
            { "id": "o4-mini", "created": 2 },
            { "id": "text-embedding-3-large", "created": 5 },
            { "id": "gpt-realtime", "created": 6 },
            { "id": "omni-moderation-latest", "created": 7 },
            // Only the Responses API serves these, and they're often the newest.
            { "id": "gpt-new-pro", "created": 9 },
            { "id": "gpt-new-codex", "created": 9 },
            { "id": "o3-deep-research", "created": 9 },
            // These turn down the JSON schema the DJ answers against.
            { "id": "gpt-3.5-turbo", "created": 9 },
            { "id": "gpt-4", "created": 9 },
            { "id": "gpt-4-turbo", "created": 9 },
            { "id": "gpt-4o-2024-05-13", "created": 9 },
            { "id": "chatgpt-4o-latest", "created": 9 },
            { "id": "o1-mini", "created": 9 },
            { "id": "gpt-4o", "created": 4 },
        ]});
        let ids: Vec<String> = model_list(Api::OpenAi, &openai).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["gpt-4o", "gpt-new", "o4-mini", "gpt-old"]);
        let gemini = json!({ "data": [
            { "id": "models/gemini-2.0-flash" },
            { "id": "models/gemini-embedding-001" },
            { "id": "models/gemini-3-pro-preview" },
            { "id": "models/gemini-3-flash" },
            { "id": "models/gemini-2.5-pro" },
        ]});
        let ids: Vec<String> = model_list(Api::Gemini, &gemini).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["gemini-3-flash", "gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.0-flash"]);
        let anthropic = json!({ "data": [
            { "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "capabilities": { "structured_outputs": { "supported": true } } },
            { "id": "claude-old", "display_name": "Claude Old", "capabilities": { "structured_outputs": { "supported": false } } },
            { "id": "claude-unknown", "display_name": "Claude Unknown" },
        ]});
        let labels: Vec<String> = model_list(Api::Anthropic, &anthropic).into_iter().map(|m| m.label).collect();
        assert_eq!(labels, ["Claude Opus 5.5", "Claude Unknown"]);
        assert!(takes_effort(&json!({ "capabilities": { "effort": { "low": { "supported": true } } } })));
        assert!(!takes_effort(&json!({ "capabilities": { "effort": { "supported": false } } })));
    }

    #[tokio::test]
    async fn rejects_unknown_roles_and_look_ups_the_model_cant_do() {
        let bad = vec![Message { role: "tool".into(), content: String::new() }];
        let s = schema();
        let err = chat(&reqwest::Client::new(), &target(Api::Local), &bad, Ask::Json(&s), 10).await;
        assert!(matches!(err, Err(AppError::Other(m)) if m.contains("role")));
        let tools = tools();
        let no_tools = Target { tools: false, ..target(Api::Local) };
        let err = chat(&reqwest::Client::new(), &no_tools, &msgs(), Ask::LookUp(&tools), 10).await;
        assert!(matches!(err, Err(AppError::Other(m)) if m.contains("look things up")));
    }

    /// Answers one request over loopback with `status` and `reply`, and hands back the request it got.
    pub(crate) async fn fake_server(status: u16, reply: String) -> (String, tokio::task::JoinHandle<String>) {
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
            let head = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                reply.len()
            );
            sock.write_all(head.as_bytes()).await.unwrap();
            sock.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf).into_owned()
        });
        (format!("http://{addr}/v1/chat/completions"), handle)
    }

    fn completion(content: &str) -> String {
        json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] }).to_string()
    }

    #[tokio::test]
    async fn sends_the_conversation_and_returns_the_json() {
        let (url, server) = fake_server(200, completion(r#"{"picks":[2,1],"intro":"Hi"}"#)).await;
        let t = Target { url, key: Some("secret".into()), ..target(Api::Local) };
        let s = json!({ "type": "object" });
        let answer = chat(&reqwest::Client::new(), &t, &msgs(), Ask::Json(&s), 200).await.unwrap();
        assert_eq!(answer.json, Some(json!({ "picks": [2, 1], "intro": "Hi" })));
        let request = server.await.unwrap();
        assert!(request.to_ascii_lowercase().contains("authorization: bearer secret"));
        assert!(request.contains("You are a DJ."));
    }

    #[tokio::test]
    async fn signs_anthropic_requests_with_its_own_headers() {
        let reply = json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": "{\"talk\":\"Hi\"}" }] });
        let (url, server) = fake_server(200, reply.to_string()).await;
        let t = Target { url, key: Some("sk-ant".into()), model: "claude-opus-5-5".into(), ..target(Api::Anthropic) };
        let s = schema();
        let answer = chat(&reqwest::Client::new(), &t, &msgs(), Ask::Json(&s), 200).await.unwrap();
        assert_eq!(answer.json, Some(json!({ "talk": "Hi" })));
        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.contains("x-api-key: sk-ant"));
        assert!(request.contains("anthropic-version: 2023-06-01"));
        assert!(request.contains("anthropic-beta: server-side-fallback-2026-07-01"));
        assert!(!request.contains("authorization:"));
    }

    #[tokio::test]
    async fn passes_on_tool_calls_when_looking_up() {
        let reply = json!({ "choices": [{ "message": { "role": "assistant", "content": "", "tool_calls": [
            { "id": "c", "type": "function", "function": { "name": "look_up_songs", "arguments": "{\"songs\":[1]}" } },
        ]}}]});
        let (url, _server) = fake_server(200, reply.to_string()).await;
        let t = Target { url, ..target(Api::OpenAi) };
        let tools = tools();
        let answer = chat(&reqwest::Client::new(), &t, &msgs(), Ask::LookUp(&tools), 200).await.unwrap();
        assert_eq!(answer.calls[0].arguments, json!({ "songs": [1] }));
    }

    #[tokio::test]
    async fn turns_a_refused_key_into_a_plain_error() {
        let (url, _server) = fake_server(401, r#"{"error":{"message":"Incorrect API key provided"}}"#.into()).await;
        let t = Target { url, ..target(Api::OpenAi) };
        let s = schema();
        let err = chat(&reqwest::Client::new(), &t, &msgs(), Ask::Json(&s), 200).await.unwrap_err().to_string();
        assert!(err.contains("OpenAI didn't accept your API key: Incorrect API key provided"), "{err}");
    }

    #[tokio::test]
    async fn never_repeats_the_key_a_provider_echoes_back() {
        // No telltale prefix: only knowing the key sent hides it.
        let key = "proj0123456789abcdefghijklmn";
        let (url, _server) = fake_server(401, format!(r#"{{"error":{{"message":"Key {key} is not valid"}}}}"#)).await;
        let t = Target { url, key: Some(key.into()), ..target(Api::OpenAi) };
        let s = schema();
        let err = chat(&reqwest::Client::new(), &t, &msgs(), Ask::Json(&s), 200).await.unwrap_err().to_string();
        assert!(!err.contains(key), "{err}");
        assert!(err.contains("Key …klmn is not valid"), "{err}");
    }
}
