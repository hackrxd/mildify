//! API keys for the DJ's cloud models. They're kept in the system's keychain (macOS Keychain, Windows
//! Credential Manager, the Secret Service on Linux); where there isn't one that works, in a file in the app
//! data dir that only the user can read, as the app's other secrets are. Keys never go to the UI.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::{AppError, Result};

/// The keychain's service name; each key is the entry `dj-<provider>`.
const SERVICE: &str = "Mildify";

/// Somewhere keys can live.
pub trait Keychain: Send + Sync {
    fn get(&self, name: &str) -> std::result::Result<Option<String>, String>;
    fn set(&self, name: &str, secret: &str) -> std::result::Result<(), String>;
    fn delete(&self, name: &str) -> std::result::Result<(), String>;
}

/// The system's keychain.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub struct SystemKeychain;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
impl Keychain for SystemKeychain {
    fn get(&self, name: &str) -> std::result::Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, name: &str, secret: &str) -> std::result::Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
        entry.set_password(secret).map_err(|e| e.to_string())
    }

    fn delete(&self, name: &str) -> std::result::Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// No keychain on this system: everything goes to the file.
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub struct SystemKeychain;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
impl Keychain for SystemKeychain {
    fn get(&self, _: &str) -> std::result::Result<Option<String>, String> {
        Err("no keychain on this system".into())
    }
    fn set(&self, _: &str, _: &str) -> std::result::Result<(), String> {
        Err("no keychain on this system".into())
    }
    fn delete(&self, _: &str) -> std::result::Result<(), String> {
        Ok(())
    }
}

/// A keychain that forgets everything when the app stops, for tests that mustn't touch the real one.
#[cfg(test)]
#[derive(Default)]
pub struct Memory(Mutex<HashMap<String, String>>, std::sync::atomic::AtomicUsize);

#[cfg(test)]
impl Memory {
    /// How many times it's been read.
    pub fn reads(&self) -> usize {
        self.1.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
impl Keychain for std::sync::Arc<Memory> {
    fn get(&self, name: &str) -> std::result::Result<Option<String>, String> {
        self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, secret: &str) -> std::result::Result<(), String> {
        self.0.lock().unwrap().insert(name.into(), secret.into());
        Ok(())
    }
    fn delete(&self, name: &str) -> std::result::Result<(), String> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

/// The DJ's API keys, by provider id.
pub struct Keys {
    chain: Box<dyn Keychain>,
    /// Where keys go when the keychain won't take them.
    file: PathBuf,
    /// What's been read, so the keychain (which may ask the user) is asked once.
    cache: Mutex<HashMap<String, Slot>>,
}

#[derive(Default)]
struct Slot {
    /// The key as last read or saved; `None` until then.
    known: Option<Option<String>>,
    /// Bumped by every save, so a read that started before it doesn't overwrite it.
    saves: u64,
}

impl Keys {
    pub fn new(file: PathBuf) -> Self {
        Self::with(Box::new(SystemKeychain), file)
    }

    pub fn with(chain: Box<dyn Keychain>, file: PathBuf) -> Self {
        Self { chain, file, cache: Mutex::new(HashMap::new()) }
    }

    fn entry(provider: &str) -> String {
        format!("dj-{provider}")
    }

    /// The key for `provider`, if one is saved. This may wait on the keychain, which may ask the user to unlock
    /// it: call it off the async runtime's workers.
    pub fn get(&self, provider: &str) -> Option<String> {
        let saves = match self.known(provider) {
            Ok(known) => return known,
            Err(saves) => saves,
        };
        let key = match self.chain.get(&Self::entry(provider)) {
            Ok(Some(k)) => Some(k),
            Ok(None) => self.read_file().remove(provider),
            Err(e) => {
                // Not kept: the keychain may answer next time (unlocked, or its service up by then).
                log::warn!("DJ: couldn't read the keychain, looking in the keys file: {e}");
                return self.read_file().remove(provider);
            }
        };
        self.remember(provider, saves, key.clone());
        key
    }

    /// The key as last read or saved; else how many saves there have been, to read it against.
    fn known(&self, provider: &str) -> std::result::Result<Option<String>, u64> {
        let cache = self.cache.lock().unwrap();
        let slot = cache.get(provider);
        match slot.and_then(|s| s.known.clone()) {
            Some(known) => Ok(known),
            None => Err(slot.map_or(0, |s| s.saves)),
        }
    }

    /// Keeps what a read found, unless a save landed while it waited.
    fn remember(&self, provider: &str, saves: u64, key: Option<String>) {
        let mut cache = self.cache.lock().unwrap();
        let slot = cache.entry(provider.to_owned()).or_default();
        if slot.saves == saves {
            slot.known = Some(key);
        }
    }

    #[cfg(test)]
    fn has(&self, provider: &str) -> bool {
        self.get(provider).is_some()
    }

    /// Saves a key for `provider`, or removes it with `None` or an empty key.
    pub fn set(&self, provider: &str, key: Option<&str>) -> Result<()> {
        let key = key.map(str::trim).filter(|k| !k.is_empty());
        let mut file = self.read_file();
        match key {
            Some(k) => match self.chain.set(&Self::entry(provider), k) {
                Ok(()) => {
                    // Kept in the keychain now: no copy stays in the file.
                    if file.remove(provider).is_some() {
                        self.write_file(&file)?;
                    }
                }
                Err(e) => {
                    log::warn!("DJ: the keychain wouldn't take the key, keeping it in the keys file: {e}");
                    file.insert(provider.to_owned(), k.to_owned());
                    self.write_file(&file)?;
                }
            },
            None => {
                if let Err(e) = self.chain.delete(&Self::entry(provider)) {
                    log::warn!("DJ: couldn't remove the key from the keychain: {e}");
                }
                if file.remove(provider).is_some() {
                    self.write_file(&file)?;
                }
            }
        }
        let mut cache = self.cache.lock().unwrap();
        let slot = cache.entry(provider.to_owned()).or_default();
        slot.saves += 1;
        slot.known = Some(key.map(str::to_owned));
        Ok(())
    }

    fn read_file(&self) -> BTreeMap<String, String> {
        std::fs::read(&self.file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn write_file(&self, keys: &BTreeMap<String, String>) -> Result<()> {
        if keys.is_empty() {
            return match std::fs::remove_file(&self.file) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.into()),
            };
        }
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let body = serde_json::to_vec_pretty(keys).map_err(|e| AppError::Other(e.to_string()))?;
        write_private(&self.file, &body)
    }
}

/// Writes a file only the user can read.
fn write_private(path: &std::path::Path, body: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(path)?;
    #[cfg(unix)]
    {
        // An older file keeps its mode through `open`.
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// A keychain in memory, which can be made to fail.
    #[derive(Default)]
    struct Fake {
        entries: Mutex<HashMap<String, String>>,
        broken: bool,
        /// Reads fail while this is set, as a locked keychain's do.
        locked: std::sync::atomic::AtomicBool,
        reads: Mutex<u32>,
    }

    impl Keychain for Arc<Fake> {
        fn get(&self, name: &str) -> std::result::Result<Option<String>, String> {
            *self.reads.lock().unwrap() += 1;
            if self.broken || self.locked.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("no secret service".into());
            }
            Ok(self.entries.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, secret: &str) -> std::result::Result<(), String> {
            if self.broken {
                return Err("no secret service".into());
            }
            self.entries.lock().unwrap().insert(name.into(), secret.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> std::result::Result<(), String> {
            self.entries.lock().unwrap().remove(name);
            Ok(())
        }
    }

    fn file() -> PathBuf {
        std::env::temp_dir().join(format!("mildify-keys-{}", crate::config::random_hex(8))).join("dj_keys.json")
    }

    #[test]
    fn keeps_keys_in_the_keychain_and_not_the_file() {
        let chain = Arc::new(Fake::default());
        let path = file();
        let keys = Keys::with(Box::new(chain.clone()), path.clone());
        assert!(!keys.has("openai"));
        keys.set("openai", Some("  sk-test  ")).unwrap();
        assert_eq!(chain.entries.lock().unwrap().get("dj-openai").map(String::as_str), Some("sk-test"));
        assert!(!path.exists());
        // A fresh start reads it back from the keychain.
        let again = Keys::with(Box::new(chain.clone()), path.clone());
        assert_eq!(again.get("openai").as_deref(), Some("sk-test"));
        keys.set("openai", None).unwrap();
        assert!(chain.entries.lock().unwrap().is_empty());
        assert!(!keys.has("openai"));
    }

    #[test]
    fn falls_back_to_a_private_file_without_a_keychain() {
        let chain = Arc::new(Fake { broken: true, ..Default::default() });
        let path = file();
        let keys = Keys::with(Box::new(chain.clone()), path.clone());
        keys.set("anthropic", Some("sk-ant")).unwrap();
        assert!(path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let again = Keys::with(Box::new(chain.clone()), path.clone());
        assert_eq!(again.get("anthropic").as_deref(), Some("sk-ant"));
        again.set("anthropic", Some("")).unwrap();
        assert!(!path.exists());
        assert!(!again.has("anthropic"));
    }

    #[test]
    fn moves_a_filed_key_into_the_keychain_once_it_works() {
        let path = file();
        let broken = Arc::new(Fake { broken: true, ..Default::default() });
        Keys::with(Box::new(broken), path.clone()).set("gemini", Some("old")).unwrap();
        let chain = Arc::new(Fake::default());
        let keys = Keys::with(Box::new(chain.clone()), path.clone());
        // Still found in the file.
        assert_eq!(keys.get("gemini").as_deref(), Some("old"));
        keys.set("gemini", Some("new")).unwrap();
        assert!(!path.exists());
        assert_eq!(keys.get("gemini").as_deref(), Some("new"));
    }

    #[test]
    fn asks_a_locked_keychain_again_later() {
        let chain = Arc::new(Fake::default());
        chain.entries.lock().unwrap().insert("dj-anthropic".into(), "sk-ant".into());
        chain.locked.store(true, std::sync::atomic::Ordering::SeqCst);
        let keys = Keys::with(Box::new(chain.clone()), file());
        assert_eq!(keys.get("anthropic"), None);
        chain.locked.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(keys.get("anthropic").as_deref(), Some("sk-ant"));
    }

    #[test]
    fn a_read_that_started_before_a_save_doesnt_undo_it() {
        let chain = Arc::new(Fake::default());
        let keys = Keys::with(Box::new(chain.clone()), file());
        // A read starts and finds nothing, but a save lands while it waits on the keychain.
        let saves = keys.known("openai").unwrap_err();
        keys.set("openai", Some("sk-new")).unwrap();
        keys.remember("openai", saves, None);
        assert_eq!(keys.get("openai").as_deref(), Some("sk-new"));
    }

    #[test]
    fn asks_the_keychain_once() {
        let chain = Arc::new(Fake::default());
        let keys = Keys::with(Box::new(chain.clone()), file());
        keys.get("openai");
        keys.get("openai");
        keys.has("openai");
        assert_eq!(*chain.reads.lock().unwrap(), 1);
    }
}
