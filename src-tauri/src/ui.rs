//! Interface-only updates. Each release also ships its built UI (`dist/`) as a signed
//! `ui-<version>.tar.gz`, announced by `ui.json` next to the updater's `latest.json`. When the release
//! leaves the backend alone, the bundle is unpacked into the app data dir and served in place of the UI
//! compiled into the binary, and a webview reload loads it: librespot runs in this process, so the music
//! carries on. Any other release needs the full updater, which restarts the app and stops playback.
//!
//! Every UI build carries `build.json` (scripts/build-info.ts): its version and a hash of everything under
//! `src-tauri`, the backend id. A downloaded UI is only served by a binary with the same backend id, and
//! only while it's newer than the binary's own UI, so a full update leaves it behind.

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{App, Assets, Context, Manager, Runtime};

use crate::config::random_hex;
use crate::error::{AppError, Result};

/// Names the downloaded UI being served, a folder name under the `ui` dir.
const CURRENT_FILE: &str = "current";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BuildInfo {
    pub version: String,
    pub backend: String,
}

/// `ui.json`. Only `url` is trusted as far as the signature goes: what gets used is the signed bundle's own
/// `build.json`, and it has to agree with `version`.
#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    backend: String,
    url: String,
    signature: String,
}

/// What the UI should offer after a check.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum UiUpdate {
    UpToDate,
    /// Downloaded; a reload loads it.
    Ready { version: String },
    /// The release changes the backend too: the full updater and a restart.
    Restart { version: String },
}

#[derive(Debug, PartialEq)]
enum Plan {
    Answer(UiUpdate),
    Download,
}

#[derive(Debug, Clone)]
struct Bundle {
    dir: PathBuf,
    info: BuildInfo,
}

/// Where to look for interface updates: `ui.json` beside the updater's endpoint, under its key.
pub struct Source {
    manifest: String,
    pubkey: String,
}

impl Source {
    /// From the updater plugin's config in tauri.conf.json.
    pub fn from_updater(updater: Option<&Value>) -> Result<Self> {
        let missing = || AppError::Other("The updater isn't configured".into());
        let updater = updater.ok_or_else(missing)?;
        let pubkey = updater["pubkey"].as_str().ok_or_else(missing)?;
        let endpoint = updater["endpoints"][0].as_str().ok_or_else(missing)?;
        let (base, _) = endpoint.rsplit_once('/').ok_or_else(missing)?;
        Ok(Self { manifest: format!("{base}/ui.json"), pubkey: pubkey.into() })
    }
}

fn version(v: &str) -> Option<semver::Version> {
    semver::Version::parse(v.trim_start_matches('v')).ok()
}

/// Whether `v` is a newer version than `than`; false if either doesn't parse.
fn newer(v: &str, than: &str) -> bool {
    matches!((version(v), version(than)), (Some(a), Some(b)) if a > b)
}

/// `next` is the UI the next page load gets, `staged` whether that's a download still waiting for one.
fn plan(manifest: &Manifest, ours: &BuildInfo, next: &BuildInfo, staged: bool) -> Result<Plan> {
    if version(&manifest.version).is_none() {
        return Err(AppError::Other(format!("Bad version in ui.json: {}", manifest.version)));
    }
    if !newer(&manifest.version, &next.version) {
        return Ok(Plan::Answer(if staged {
            UiUpdate::Ready { version: next.version.clone() }
        } else {
            UiUpdate::UpToDate
        }));
    }
    if manifest.backend != ours.backend {
        return Ok(Plan::Answer(UiUpdate::Restart { version: manifest.version.clone() }));
    }
    Ok(Plan::Download)
}

/// Checks a minisign signature made by `tauri signer sign`, as the updater plugin does: the key and the
/// signature are base64 of minisign's text formats.
fn verify(data: &[u8], signature: &str, pubkey: &str) -> Result<()> {
    let text = |b64: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    };
    let key = text(pubkey)
        .and_then(|k| minisign_verify::PublicKey::decode(&k).ok())
        .ok_or_else(|| AppError::Other("The update key is unreadable".into()))?;
    let signature = text(signature)
        .and_then(|s| minisign_verify::Signature::decode(&s).ok())
        .ok_or_else(|| AppError::Other("The interface update's signature is unreadable".into()))?;
    key.verify(data, &signature, true)
        .map_err(|_| AppError::Other("The interface update's signature doesn't match".into()))
}

/// The file an asset key (`/assets/index-abc.js`) names inside a UI folder, or None for one that would
/// leave it.
fn asset_path(dir: &Path, key: &str) -> Option<PathBuf> {
    let mut path = dir.to_path_buf();
    for part in key.split('/').filter(|p| !p.is_empty()) {
        if part == "." || part == ".." || part.contains(['\\', ':']) {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

fn read_info(dir: &Path) -> Option<BuildInfo> {
    serde_json::from_slice(&fs::read(dir.join("build.json")).ok()?).ok()
}

/// Removes everything in the `ui` dir but `keep` and the file naming it, or everything if there's none to keep.
fn clean(dir: &Path, keep: Option<&Path>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if keep.is_some_and(|k| k == path) || (keep.is_some() && entry.file_name() == CURRENT_FILE) {
            continue;
        }
        let removed = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        if let Err(e) = removed {
            log::warn!("Couldn't remove old interface files at {}: {e}", path.display());
        }
    }
}

/// The downloaded UIs and which one is served.
pub struct UiStore {
    /// The binary's own UI. None in builds without `build.json` (`tauri dev`), which never load a downloaded one.
    embedded: Option<BuildInfo>,
    /// `--safe-mode` serves the binary's own UI and doesn't download one.
    safe_mode: bool,
    /// `<app data>/ui`, once the app knows it.
    dir: OnceLock<PathBuf>,
    /// The downloaded UI being served, or None for the binary's own.
    active: RwLock<Option<Bundle>>,
    /// A downloaded UI that `apply` makes the served one, before the window reloads.
    staged: Mutex<Option<Bundle>>,
    /// Set once the webview has asked for an asset: switching UIs under a loaded page would mix two
    /// builds' files, so from then on only `apply` does.
    serving: AtomicBool,
}

impl UiStore {
    fn new(embedded: Option<BuildInfo>, safe_mode: bool) -> Self {
        Self {
            embedded,
            safe_mode,
            dir: OnceLock::new(),
            active: RwLock::new(None),
            staged: Mutex::new(None),
            serving: AtomicBool::new(false),
        }
    }

    fn ours(&self) -> Option<&BuildInfo> {
        self.embedded.as_ref().filter(|_| !self.safe_mode)
    }

    /// A downloaded UI this binary can serve: built for the same backend, and newer than its own UI.
    fn fits(&self, info: &BuildInfo) -> bool {
        self.ours().is_some_and(|ours| info.backend == ours.backend && newer(&info.version, &ours.version))
    }

    /// Finds the downloaded UI to serve, and clears out older ones and any a full update left behind.
    fn init(&self, data_dir: &Path) {
        let dir = data_dir.join("ui");
        let _ = self.dir.set(dir.clone());
        if self.ours().is_none() {
            return;
        }
        let current = fs::read_to_string(dir.join(CURRENT_FILE)).ok().and_then(|name| {
            let bundle_dir = asset_path(&dir, name.trim()).filter(|p| p.parent() == Some(dir.as_path()))?;
            let info = read_info(&bundle_dir).filter(|info| self.fits(info))?;
            Some(Bundle { dir: bundle_dir, info })
        });
        clean(&dir, current.as_ref().map(|b| b.dir.as_path()));
        if let Some(bundle) = current {
            log::info!("Serving interface {} from {}", bundle.info.version, bundle.dir.display());
            if self.serving.load(Ordering::SeqCst) {
                *self.staged.lock().unwrap() = Some(bundle);
            } else {
                *self.active.write().unwrap() = Some(bundle);
            }
        }
    }

    fn active_dir(&self) -> Option<PathBuf> {
        self.active.read().unwrap().as_ref().map(|b| b.dir.clone())
    }

    /// Unpacks a verified bundle, checks it's the version announced and fits this binary, and stages it.
    fn install(&self, tar_gz: &[u8], announced: &str) -> Result<BuildInfo> {
        let dir = self.dir.get().ok_or_else(|| AppError::Other("The app data folder isn't known yet".into()))?;
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".download-{}", random_hex(4)));
        let unpacked = tar::Archive::new(flate2::read::GzDecoder::new(tar_gz))
            .unpack(&tmp)
            .map_err(AppError::from)
            .and_then(|()| {
                read_info(&tmp).ok_or_else(|| AppError::Other("The interface update has no build.json".into()))
            })
            .and_then(|info| {
                if info.version == announced && self.fits(&info) {
                    Ok(info)
                } else {
                    Err(AppError::Other(format!("The interface update ({}) doesn't fit this version of Mildify", info.version)))
                }
            });
        let info = match unpacked {
            Ok(info) => info,
            Err(e) => {
                let _ = fs::remove_dir_all(&tmp);
                return Err(e);
            }
        };

        let bundle_dir = dir.join(&info.version);
        if bundle_dir.exists() {
            fs::remove_dir_all(&bundle_dir)?;
        }
        fs::rename(&tmp, &bundle_dir)?;
        let pointer = dir.join(format!("{CURRENT_FILE}.tmp"));
        fs::write(&pointer, &info.version)?;
        fs::rename(&pointer, dir.join(CURRENT_FILE))?;
        *self.staged.lock().unwrap() = Some(Bundle { dir: bundle_dir, info: info.clone() });
        Ok(info)
    }

    /// Looks for a newer UI and downloads it if this binary can serve it.
    pub async fn check(&self, http: &reqwest::Client, source: &Source) -> Result<UiUpdate> {
        let ours = self.ours().ok_or_else(|| AppError::Other("This build doesn't take interface updates".into()))?;
        let staged = self.staged.lock().unwrap().as_ref().map(|b| b.info.clone());
        let next = staged
            .clone()
            .or_else(|| self.active.read().unwrap().as_ref().map(|b| b.info.clone()))
            .unwrap_or_else(|| ours.clone());

        let manifest: Manifest = http.get(&source.manifest).send().await?.error_for_status()?.json().await?;
        if let Plan::Answer(answer) = plan(&manifest, ours, &next, staged.is_some())? {
            return Ok(answer);
        }
        log::info!("Downloading interface {}", manifest.version);
        let bytes = http.get(&manifest.url).send().await?.error_for_status()?.bytes().await?;
        verify(&bytes, &manifest.signature, &source.pubkey)?;
        let info = self.install(&bytes, &manifest.version)?;
        Ok(UiUpdate::Ready { version: info.version })
    }

    /// Serves the staged UI from now on; the window reloads right after. False if nothing was staged.
    pub fn apply(&self) -> bool {
        let Some(bundle) = self.staged.lock().unwrap().take() else { return false };
        log::info!("Switching to interface {}", bundle.info.version);
        *self.active.write().unwrap() = Some(bundle);
        true
    }
}

/// Serves the active downloaded UI, or the binary's own when there's none.
struct UiAssets<R: Runtime> {
    embedded: Box<dyn Assets<R>>,
    store: Arc<UiStore>,
}

impl<R: Runtime> Assets<R> for UiAssets<R> {
    // Runs before the event loop, so before the window's first request.
    fn setup(&self, app: &App<R>) {
        self.embedded.setup(app);
        match app.path().app_data_dir() {
            Ok(dir) => self.store.init(&dir),
            Err(e) => log::warn!("No app data folder for interface updates: {e}"),
        }
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.store.serving.store(true, Ordering::SeqCst);
        match self.store.active_dir() {
            Some(dir) => asset_path(&dir, key.as_ref()).and_then(|p| fs::read(p).ok()).map(Cow::Owned),
            None => self.embedded.get(key),
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.embedded.iter()
    }

    // The binary's hashes are for its own UI's scripts; a downloaded one loads its scripts as 'self'.
    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        if self.store.active_dir().is_some() {
            Box::new(std::iter::empty())
        } else {
            self.embedded.csp_hashes(html_path)
        }
    }
}

/// Stands in for the embedded assets for the moment they're moved into `UiAssets`.
struct Placeholder;

impl<R: Runtime> Assets<R> for Placeholder {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// Puts the downloaded-UI layer in front of the context's embedded assets.
pub fn serve<R: Runtime>(context: &mut Context<R>, safe_mode: bool) -> Arc<UiStore> {
    let embedded = context.set_assets(Box::new(Placeholder));
    let info = embedded.get(&"build.json".into()).and_then(|b| serde_json::from_slice(&b).ok());
    let store = Arc::new(UiStore::new(info, safe_mode));
    context.set_assets(Box::new(UiAssets { embedded, store: store.clone() }));
    store
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    // Made with `tauri signer generate` and `tauri signer sign --app-version 1.2.0` over SIGNED_DATA.
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUxREFBQUEzQjNFRDBCNEUKUldST0MrMnpvNnJhNFVRdXlhYWJaUS9sWmtrcGJpdklHcEloK1UxcWI3WHl3dUZiMm5oRkJHaDAK";
    const SIGNED_DATA: &[u8] = b"mildify ui bundle";
    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVST0MrMnpvNnJhNGJNbWl3c1VJR0lMRjFMdHMySXJOeC8vZWVtak5USlo1MGZVb3JDWWZ1WUtBL1lDYjFiS3Q2d1ArNnBKVmgrbjNtZEFKUGJ3ZFhnMFNlbGNFbHMvekFrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxMDg5NDA2CWZpbGU6ZGF0YS5iaW4JdmVyc2lvbjoxLjIuMApOY0RGUy9JTjhNdmtmR3lKMG9OMWNaLzhoM2xBNWIvTEtGRWcwYmZ6RVRSNHErRmprQUJOUFZIOFM0Z1hZQkIrWkp0U21TNFc0UWhHdndneFUza09BQT09Cg==";

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("mildify-ui-{}", random_hex(8)));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn ui(&self) -> PathBuf {
            self.0.join("ui")
        }
        fn write(&self, rel: &str, contents: &str) {
            let path = self.ui().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        fn bundle(&self, version: &str, backend: &str) {
            self.write(&format!("{version}/build.json"), &info_json(version, backend));
            self.write(&format!("{version}/index.html"), version);
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn info(version: &str, backend: &str) -> BuildInfo {
        BuildInfo { version: version.into(), backend: backend.into() }
    }

    fn info_json(version: &str, backend: &str) -> String {
        serde_json::to_string(&info(version, backend)).unwrap()
    }

    fn store(version: &str) -> UiStore {
        UiStore::new(Some(info(version, "b1")), false)
    }

    fn manifest(version: &str, backend: &str) -> Manifest {
        Manifest { version: version.into(), backend: backend.into(), url: String::new(), signature: String::new() }
    }

    fn tar_gz(files: &[(&str, &str)]) -> Vec<u8> {
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (path, contents) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, path, contents.as_bytes()).unwrap();
        }
        let mut gz = tar.into_inner().unwrap();
        gz.flush().unwrap();
        gz.finish().unwrap()
    }

    fn served(store: &UiStore) -> Option<String> {
        store.active.read().unwrap().as_ref().map(|b| b.info.version.clone())
    }

    #[test]
    fn plans_by_version_then_backend() {
        let ours = info("1.1.0", "b1");
        let answer = |m: Manifest, next: &BuildInfo, staged: bool| plan(&m, &ours, next, staged).unwrap();
        assert_eq!(answer(manifest("1.1.0", "b1"), &ours, false), Plan::Answer(UiUpdate::UpToDate));
        assert_eq!(answer(manifest("1.0.9", "b0"), &ours, false), Plan::Answer(UiUpdate::UpToDate));
        assert_eq!(answer(manifest("1.2.0", "b1"), &ours, false), Plan::Download);
        assert_eq!(
            answer(manifest("1.2.0", "b2"), &ours, false),
            Plan::Answer(UiUpdate::Restart { version: "1.2.0".into() })
        );
        // Already downloaded and waiting for a reload.
        let staged = info("1.2.0", "b1");
        assert_eq!(
            answer(manifest("1.2.0", "b1"), &staged, true),
            Plan::Answer(UiUpdate::Ready { version: "1.2.0".into() })
        );
        // Served already, after a reload.
        assert_eq!(answer(manifest("1.2.0", "b1"), &staged, false), Plan::Answer(UiUpdate::UpToDate));
        assert!(plan(&manifest("soon", "b1"), &ours, &ours, false).is_err());
    }

    #[test]
    fn a_newer_ui_on_a_binary_with_an_older_one_still_restarts_for_a_new_backend() {
        // Binary 1.1.0 serving downloaded 1.2.0; 1.3.0 changes the backend.
        assert_eq!(
            plan(&manifest("1.3.0", "b2"), &info("1.1.0", "b1"), &info("1.2.0", "b1"), false).unwrap(),
            Plan::Answer(UiUpdate::Restart { version: "1.3.0".into() })
        );
    }

    #[test]
    fn verifies_tauri_signatures() {
        assert!(verify(SIGNED_DATA, SIGNATURE, TEST_PUBKEY).is_ok());
        assert!(verify(b"mildify ui bundlf", SIGNATURE, TEST_PUBKEY).is_err());
        assert!(verify(SIGNED_DATA, "bm90IGEgc2lnbmF0dXJl", TEST_PUBKEY).is_err());
        assert!(verify(SIGNED_DATA, SIGNATURE, "").is_err());
    }

    #[test]
    fn asset_paths_stay_in_the_folder() {
        let dir = Path::new("/data/ui/1.2.0");
        assert_eq!(asset_path(dir, "/assets/index-abc.js"), Some(dir.join("assets").join("index-abc.js")));
        assert_eq!(asset_path(dir, "/index.html"), Some(dir.join("index.html")));
        assert_eq!(asset_path(dir, "/../current"), None);
        assert_eq!(asset_path(dir, "/assets/../../x"), None);
        assert_eq!(asset_path(dir, "/C:/x"), None);
        assert_eq!(asset_path(dir, "/a\\..\\x"), None);
    }

    #[test]
    fn manifest_sits_next_to_latest_json() {
        let updater = serde_json::json!({
            "pubkey": "key",
            "endpoints": ["https://github.com/hackrxd/mildify/releases/latest/download/latest.json"],
        });
        let source = Source::from_updater(Some(&updater)).unwrap();
        assert_eq!(source.manifest, "https://github.com/hackrxd/mildify/releases/latest/download/ui.json");
        assert_eq!(source.pubkey, "key");
        assert!(Source::from_updater(None).is_err());
    }

    #[test]
    fn launches_into_the_current_download_and_clears_the_rest() {
        let s = Scratch::new();
        s.bundle("1.1.5", "b1");
        s.bundle("1.2.0", "b1");
        s.write(".download-abcd/index.html", "half");
        s.write(CURRENT_FILE, "1.2.0");
        let store = store("1.1.0");
        store.init(&s.0);
        assert_eq!(served(&store), Some("1.2.0".into()));
        assert!(s.ui().join("1.2.0").exists());
        assert!(s.ui().join(CURRENT_FILE).exists());
        assert!(!s.ui().join("1.1.5").exists());
        assert!(!s.ui().join(".download-abcd").exists());
    }

    #[test]
    fn a_full_update_leaves_downloads_behind() {
        for (binary, backend) in [("1.2.0", "b1"), ("1.3.0", "b1"), ("1.1.0", "b2")] {
            let s = Scratch::new();
            s.bundle("1.2.0", "b1");
            s.write(CURRENT_FILE, "1.2.0");
            let store = UiStore::new(Some(info(binary, backend)), false);
            store.init(&s.0);
            assert_eq!(served(&store), None, "binary {binary} with backend {backend}");
            assert!(!s.ui().join("1.2.0").exists());
            assert!(!s.ui().join(CURRENT_FILE).exists());
        }
    }

    #[test]
    fn safe_mode_and_dev_builds_serve_their_own_ui_and_keep_downloads() {
        for store in [UiStore::new(Some(info("1.1.0", "b1")), true), UiStore::new(None, false)] {
            let s = Scratch::new();
            s.bundle("1.2.0", "b1");
            s.write(CURRENT_FILE, "1.2.0");
            store.init(&s.0);
            assert_eq!(served(&store), None);
            assert!(s.ui().join("1.2.0").exists());
        }
    }

    #[test]
    fn a_current_file_cant_point_outside() {
        let s = Scratch::new();
        s.write("../elsewhere/build.json", &info_json("1.2.0", "b1"));
        s.write(CURRENT_FILE, "../elsewhere");
        let store = store("1.1.0");
        store.init(&s.0);
        assert_eq!(served(&store), None);
    }

    #[test]
    fn a_ui_found_after_the_page_loaded_waits_for_apply() {
        let s = Scratch::new();
        s.bundle("1.2.0", "b1");
        s.write(CURRENT_FILE, "1.2.0");
        let store = store("1.1.0");
        store.serving.store(true, Ordering::SeqCst);
        store.init(&s.0);
        assert_eq!(served(&store), None);
        assert!(store.apply());
        assert_eq!(served(&store), Some("1.2.0".into()));
    }

    #[test]
    fn installs_a_fitting_bundle_and_serves_it_after_apply() {
        let s = Scratch::new();
        let store = store("1.1.0");
        store.init(&s.0);
        let bundle = tar_gz(&[("./build.json", &info_json("1.2.0", "b1")), ("./assets/app.js", "js")]);
        assert_eq!(store.install(&bundle, "1.2.0").unwrap(), info("1.2.0", "b1"));
        assert_eq!(fs::read_to_string(s.ui().join(CURRENT_FILE)).unwrap(), "1.2.0");
        assert_eq!(served(&store), None);
        assert!(store.apply());
        assert_eq!(served(&store), Some("1.2.0".into()));
        assert!(!store.apply());

        let assets = UiAssets::<tauri::Wry> { embedded: Box::new(Placeholder), store: Arc::new(store) };
        assert_eq!(assets.get(&"assets/app.js".into()).as_deref(), Some(&b"js"[..]));
    }

    #[test]
    fn refuses_bundles_that_dont_fit() {
        let s = Scratch::new();
        let store = store("1.1.0");
        store.init(&s.0);
        let cases = [
            (tar_gz(&[("build.json", &info_json("1.2.0", "b2"))]), "1.2.0"), // another backend
            (tar_gz(&[("build.json", &info_json("1.0.0", "b1"))]), "1.0.0"), // older
            (tar_gz(&[("build.json", &info_json("1.2.0", "b1"))]), "1.3.0"), // not what was announced
            (tar_gz(&[("index.html", "x")]), "1.2.0"),                       // no build.json
            (b"not a tarball".to_vec(), "1.2.0"),
        ];
        for (bundle, announced) in cases {
            assert!(store.install(&bundle, announced).is_err());
        }
        assert!(!store.apply());
        assert_eq!(fs::read_dir(s.ui()).unwrap().count(), 0, "leftovers in the ui folder");
    }
}
