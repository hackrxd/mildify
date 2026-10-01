use serde::ser::SerializeStruct;
use serde::Serialize;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Spotify API error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("Rate limited by Spotify, retry in {retry_after}s")]
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
