use serde::ser::SerializeStruct;
use serde::Serialize;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Spotify API error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("Rate limited, retry in {retry_after}s")]
    RateLimited { retry_after: u64 },
    #[error("Not signed in to Spotify")]
    NotSignedIn,
    #[error("No Spotify client ID configured")]
    NoClientId,
    #[error("Sign-in was cancelled")]
    Cancelled,
    #[error("{0}")]
    Auth(String),
    #[error("Playback device: {0}")]
    Device(String),
    #[error("Network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::Api { .. } => "api",
            AppError::RateLimited { .. } => "rate_limited",
            AppError::NotSignedIn => "not_signed_in",
            AppError::NoClientId => "no_client_id",
            AppError::Cancelled => "cancelled",
            AppError::Auth(_) => "auth",
            AppError::Device(_) => "device",
            AppError::Http(_) => "network",
            AppError::Io(_) => "io",
            AppError::Other(_) => "other",
        }
    }

    fn status(&self) -> Option<u16> {
        match self {
            AppError::Api { status, .. } => Some(*status),
            AppError::RateLimited { .. } => Some(429),
            _ => None,
        }
    }
}

/// Errors cross the IPC boundary as `{ kind, message, status }` so the UI can branch on `kind`.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("AppError", 3)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("status", &self.status())?;
        st.end()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn ipc(e: AppError) -> Value {
        serde_json::to_value(e).unwrap()
    }

    // `ipc.ts` mirrors this shape; the UI branches on `kind`.
    #[test]
    fn crosses_ipc_as_kind_message_status() {
        assert_eq!(
            ipc(AppError::Api { status: 404, message: "Not found".into() }),
            json!({ "kind": "api", "message": "Spotify API error 404: Not found", "status": 404 })
        );
        assert_eq!(
            ipc(AppError::NotSignedIn),
            json!({ "kind": "not_signed_in", "message": "Not signed in to Spotify", "status": null })
        );
    }

    #[test]
    fn rate_limits_carry_429_and_the_wait() {
        let v = ipc(AppError::RateLimited { retry_after: 20 });
        assert_eq!(v["kind"], "rate_limited");
        assert_eq!(v["status"], 429);
        // player.svelte.ts reads the wait back out of the message with /(\d+)s/.
        assert_eq!(v["message"], "Rate limited, retry in 20s");
    }

    #[test]
    fn every_kind_is_one_ipc_ts_knows() {
        let known = [
            "api", "rate_limited", "not_signed_in", "no_client_id", "cancelled", "auth", "device", "network", "io",
            "other",
        ];
        let errors = [
            AppError::Api { status: 500, message: String::new() },
            AppError::RateLimited { retry_after: 1 },
            AppError::NotSignedIn,
            AppError::NoClientId,
            AppError::Cancelled,
            AppError::Auth("x".into()),
            AppError::Device("x".into()),
            AppError::Io(std::io::Error::other("x")),
            AppError::Other("x".into()),
        ];
        for e in errors {
            let v = ipc(e);
            assert!(known.contains(&v["kind"].as_str().unwrap()), "unknown kind in {v}");
        }
    }

    #[test]
    fn messages_pass_through_unprefixed() {
        assert_eq!(ipc(AppError::Auth("Wrong username or password".into()))["message"], "Wrong username or password");
        assert_eq!(ipc(AppError::Other("Bad".into()))["message"], "Bad");
        assert_eq!(ipc(AppError::Device("not running".into()))["message"], "Playback device: not running");
    }
}
