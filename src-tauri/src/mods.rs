//! User mods: CSS themes and JavaScript extensions dropped into the app config dir.
//!
//! The UI loads them through the `nsmod` URI scheme (`nsmod://localhost/themes/<version>/…`, or
//! `http://nsmod.localhost/…` on Windows), so a theme's relative `url(…)`s and an extension's
//! relative `import`s resolve to files next to it. The version segment is ignored here; the UI
//! changes it after an edit so the webview fetches every file of the mod again, not just the entry.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "nsmod";

/// Command-line flag that starts the app without any theme or extension.
pub const SAFE_MODE_FLAG: &str = "--safe-mode";

/// Base URL the webview reaches the `nsmod` scheme at.
pub fn base_url() -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/")
    } else {
        format!("{SCHEME}://localhost/")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Theme,
    Extension,
}

impl Kind {
    /// File extensions a single-file mod of this kind can have.
    fn file_exts(self) -> &'static [&'static str] {
        match self {
            Kind::Theme => &["css"],
            Kind::Extension => &["js", "mjs"],
        }
    }

    /// Entry files looked for, in order, inside a folder mod.
    fn folder_entries(self) -> &'static [&'static str] {
        match self {
            Kind::Theme => &["theme.css", "index.css"],
            Kind::Extension => &["index.js", "index.mjs", "extension.js"],
        }
    }
}

/// One installed theme or extension.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModInfo {
    /// File or folder name; stable, and what enabled state is keyed by.
    pub id: String,
    /// Entry file, relative to the kind's folder, with `/` separators.
    pub entry: String,
    pub name: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
    /// Newest modification time, in ms since the epoch, of the entry file or, for a folder mod,
    /// of any file in the folder; changes when any of them is edited.
    pub modified: u64,
}

#[derive(Debug, Serialize)]
pub struct ModList {
    pub themes_dir: PathBuf,
    pub extensions_dir: PathBuf,
    /// Where `themes/<entry>` and `extensions/<entry>` are served from.
    pub base_url: String,
    /// Started with `--safe-mode`: the UI loads no theme or extension.
    pub safe_mode: bool,
    pub themes: Vec<ModInfo>,
    pub extensions: Vec<ModInfo>,
}

/// Metadata from `@key value` lines in the file's first block comment:
///
/// ```css
/// /**
///  * @name Midnight
///  * @description Deep blue, no brass.
///  */
/// ```
#[derive(Debug, Default, PartialEq)]
pub struct Meta {
    pub name: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
}

pub fn parse_meta(source: &str) -> Meta {
    let mut meta = Meta::default();
    let trimmed = source.trim_start_matches('\u{feff}').trim_start();
    let Some(rest) = trimmed.strip_prefix("/*") else {
        return meta;
    };
    let Some(end) = rest.find("*/") else {
        return meta;
    };
    for line in rest[..end].lines() {
        let line = line.trim().trim_start_matches('*').trim();
        let Some(tag) = line.strip_prefix('@') else {
            continue;
        };
        let (key, value) = tag.split_once(char::is_whitespace).unwrap_or((tag, ""));
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let slot = match key {
            "name" => &mut meta.name,
            "description" => &mut meta.description,
            "author" => &mut meta.author,
            "version" => &mut meta.version,
            _ => continue,
        };
        *slot = Some(value.to_owned());
    }
    meta
}

/// Lists the mods of one kind in `dir`: single files with a matching extension, and folders with
/// an entry file. Hidden files are skipped. A missing folder is an empty list.
pub fn scan(dir: &Path, kind: Kind) -> Vec<ModInfo> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut mods: Vec<ModInfo> = read
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().to_str()?.to_owned();
            if id.starts_with('.') {
                return None;
            }
            let path = entry.path();
            if path.is_dir() {
                let name = kind.folder_entries().iter().find(|e| path.join(e).is_file())?;
                let modified = newest_mtime(&path, 0);
                Some(info(id.clone(), format!("{id}/{name}"), &path.join(name), modified))
            } else {
                let ext = path.extension()?.to_str()?.to_ascii_lowercase();
                if !kind.file_exts().contains(&ext.as_str()) {
                    return None;
                }
                let modified = mtime(&path);
                Some(info(id.clone(), id, &path, modified))
            }
        })
        .collect();
    mods.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
    mods
}

fn mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// Newest file modification time under `dir`, skipping hidden entries. Stops a few folders deep,
/// so a mod that bundles `node_modules` isn't walked whole on every focus.
fn newest_mtime(dir: &Path, depth: usize) -> u64 {
    let Ok(read) = fs::read_dir(dir) else {
        return 0;
    };
    read.flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| {
            let path = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => if depth < 4 { newest_mtime(&path, depth + 1) } else { 0 },
                _ => mtime(&path),
            }
        })
        .max()
        .unwrap_or(0)
}

fn info(id: String, entry: String, file: &Path, modified: u64) -> ModInfo {
    // Metadata lives at the top, so a few KB is plenty and big bundles aren't read whole.
    let head = fs::read(file).map(|b| String::from_utf8_lossy(&b[..b.len().min(8192)]).into_owned());
    let meta = head.map(|s| parse_meta(&s)).unwrap_or_default();
    let name = meta.name.unwrap_or_else(|| {
        let stem = Path::new(&id).file_stem().and_then(|s| s.to_str()).unwrap_or(&id);
        stem.replace(['-', '_'], " ")
    });
    ModInfo {
        id,
        entry,
        name,
        description: meta.description,
        author: meta.author,
        version: meta.version,
        modified,
    }
}

/// Maps a request path (`/themes/<version>/midnight/bg.png`) to a file under the matching mods
/// folder. Anything that could step outside it (`..`, absolute or prefixed parts) is refused.
pub fn resolve(themes_dir: &Path, extensions_dir: &Path, request_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(request_path.trim_start_matches('/'))?;
    let (top, rest) = decoded.split_once('/')?;
    let (version, rest) = rest.split_once('/')?;
    if version.is_empty() {
        return None;
    }
    let root = match top {
        "themes" => themes_dir,
        "extensions" => extensions_dir,
        _ => return None,
    };
    let rel = Path::new(rest);
    if rest.is_empty() || rest.contains('\\') || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    // Symlinks are fine as long as they stay inside the folder.
    let file = root.join(rel).canonicalize().ok()?;
    file.starts_with(root.canonicalize().ok()?).then_some(file).filter(|f| f.is_file())
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Serves an `nsmod` request. Files are never cached, so edits show up on the next load.
pub fn serve(themes_dir: &Path, extensions_dir: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let builder = Response::builder()
        .header(header::CACHE_CONTROL, "no-store")
        // Extensions are ES modules, which load cross-origin only with CORS.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let found = resolve(themes_dir, extensions_dir, request.uri().path())
        .and_then(|path| fs::read(&path).ok().map(|body| (path, body)));
    match found {
        Some((path, body)) => builder.header(header::CONTENT_TYPE, content_type(&path)).body(body),
        None => builder.status(StatusCode::NOT_FOUND).body(Vec::new()),
    }
    .expect("static headers are valid")
}

pub fn safe_mode(mut args: impl Iterator<Item = String>) -> bool {
    args.any(|a| a == SAFE_MODE_FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::random_hex;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("nativespotify-mods-{}", random_hex(8)));
            fs::create_dir_all(dir.join("themes")).unwrap();
            fs::create_dir_all(dir.join("extensions")).unwrap();
            Self(dir)
        }
        fn themes(&self) -> PathBuf {
            self.0.join("themes")
        }
        fn extensions(&self) -> PathBuf {
            self.0.join("extensions")
        }
        fn write(&self, rel: &str, contents: &str) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn meta_from_the_leading_block_comment() {
        let src = "\u{feff}\n/**\n * @name Midnight Blue\n * @description Deep blue,\tno brass.\n * @author nya\n * @version 1.2\n * @unknown x\n */\n:root{}";
        assert_eq!(
            parse_meta(src),
            Meta {
                name: Some("Midnight Blue".into()),
                description: Some("Deep blue,\tno brass.".into()),
                author: Some("nya".into()),
                version: Some("1.2".into()),
            }
        );
    }

    #[test]
    fn meta_ignores_later_comments_and_empty_tags() {
        assert_eq!(parse_meta(":root{}\n/* @name Late */"), Meta::default());
        assert_eq!(parse_meta("/* @name\n@author   */"), Meta::default());
        assert_eq!(parse_meta("/* @name Unclosed"), Meta::default());
        assert_eq!(parse_meta("/* @name One-liner */").name.as_deref(), Some("One-liner"));
    }

    #[test]
    fn scan_finds_files_and_folders_of_its_kind() {
        let s = Scratch::new();
        s.write("themes/midnight-blue.css", ":root{}");
        s.write("themes/Glass/theme.css", "/* @name Glass */");
        s.write("themes/Glass/bg.png", "");
        let glass_entry = mtime(&s.themes().join("Glass/theme.css"));
        s.write("themes/no-entry/readme.md", "");
        s.write("themes/.hidden.css", "");
        s.write("themes/notes.txt", "");
        s.write("extensions/clock.JS", "/** @name Clock\n @version 2 */");
        s.write("extensions/bundle/index.mjs", "");
        s.write("extensions/style.css", "");

        let themes = scan(&s.themes(), Kind::Theme);
        let ids: Vec<_> = themes.iter().map(|m| (m.id.as_str(), m.entry.as_str(), m.name.as_str())).collect();
        assert_eq!(ids, [("Glass", "Glass/theme.css", "Glass"), ("midnight-blue.css", "midnight-blue.css", "midnight blue")]);
        assert!(themes.iter().all(|m| m.modified > 0));
        assert!(themes[0].modified >= glass_entry, "a folder's version covers every file in it");

        let exts = scan(&s.extensions(), Kind::Extension);
        let ids: Vec<_> = exts.iter().map(|m| (m.id.as_str(), m.entry.as_str(), m.version.as_deref())).collect();
        assert_eq!(ids, [("bundle", "bundle/index.mjs", None), ("clock.JS", "clock.JS", Some("2"))]);
    }

    #[test]
    fn a_folder_mod_changes_version_when_any_file_in_it_does() {
        let s = Scratch::new();
        s.write("extensions/rp/index.js", "");
        s.write("extensions/rp/lib/format.js", "");
        s.write("extensions/rp/.git/HEAD", "");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        let newer = old + std::time::Duration::from_secs(60);
        let set = |rel: &str, t| fs::File::options().write(true).open(s.0.join(rel)).unwrap().set_modified(t).unwrap();
        set("extensions/rp/index.js", old);
        set("extensions/rp/lib/format.js", old);
        let before = scan(&s.extensions(), Kind::Extension)[0].modified;

        set("extensions/rp/lib/format.js", newer);
        let after = scan(&s.extensions(), Kind::Extension)[0].modified;
        assert_eq!(after - before, 60_000);

        // Hidden files (an editor's swap file, .git) don't count.
        set("extensions/rp/.git/HEAD", newer + std::time::Duration::from_secs(60));
        assert_eq!(scan(&s.extensions(), Kind::Extension)[0].modified, after);
    }

    #[test]
    fn scan_of_a_missing_folder_is_empty() {
        assert!(scan(Path::new("/definitely/not/here"), Kind::Theme).is_empty());
    }

    #[test]
    fn resolve_stays_inside_the_mods_folders() {
        let s = Scratch::new();
        s.write("themes/Glass/theme.css", "");
        s.write("themes/My Theme.css", "");
        s.write("extensions/clock.js", "");
        s.write("secret.txt", "");
        let r = |p: &str| resolve(&s.themes(), &s.extensions(), p);

        assert_eq!(r("/themes/5/Glass/theme.css"), Some(s.themes().join("Glass/theme.css").canonicalize().unwrap()));
        assert!(r("/themes/5/My%20Theme.css").is_some());
        assert!(r("/extensions/1/clock.js").is_some());
        assert_eq!(r("/extensions/1/clock.js"), r("/extensions/2/clock.js"), "the version is ignored");

        for bad in [
            "/themes/1/../secret.txt",
            "/themes/../secret.txt",
            "/themes/1/%2E%2E/secret.txt",
            "/themes/1/Glass/../../secret.txt",
            "/themes/1/..%5Csecret.txt",
            "/themes/1//etc/passwd",
            "/themes//Glass/theme.css",
            "/themes/1/",
            "/themes/1/Glass",
            "/themes/Glass/theme.css",
            "/other/1/clock.js",
            "/extensions/1/missing.js",
            "/themes/1/%zz.css",
        ] {
            assert_eq!(r(bad), None, "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolve_refuses_symlinks_that_leave_the_folder() {
        let s = Scratch::new();
        s.write("secret.txt", "");
        std::os::unix::fs::symlink(s.0.join("secret.txt"), s.themes().join("link.css")).unwrap();
        assert_eq!(resolve(&s.themes(), &s.extensions(), "/themes/1/link.css"), None);
    }

    #[test]
    fn serve_sends_files_with_their_type_and_no_caching() {
        let s = Scratch::new();
        s.write("extensions/clock.js", "export default () => {}");
        let get = |uri: &str| serve(&s.themes(), &s.extensions(), &Request::get(uri).body(Vec::new()).unwrap());

        let ok = get("nsmod://localhost/extensions/123/clock.js");
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
        assert_eq!(ok.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(ok.body(), b"export default () => {}");

        let missing = get("http://nsmod.localhost/extensions/1/nope.js");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert!(missing.body().is_empty());
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type(Path::new("a.CSS")), "text/css; charset=utf-8");
        assert_eq!(content_type(Path::new("a.mjs")), "text/javascript; charset=utf-8");
        assert_eq!(content_type(Path::new("f.woff2")), "font/woff2");
        assert_eq!(content_type(Path::new("noext")), "application/octet-stream");
    }

    #[test]
    fn safe_mode_flag() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
        assert!(safe_mode(args(&["app", "--safe-mode"])));
        assert!(!safe_mode(args(&["app", "--safe"])));
        assert!(!safe_mode(args(&["app"])));
    }

    #[test]
    fn base_url_matches_the_platform_scheme_form() {
        let url = base_url();
        assert!(url.ends_with('/'));
        if cfg!(windows) {
            assert_eq!(url, "http://nsmod.localhost/");
        } else {
            assert_eq!(url, "nsmod://localhost/");
        }
    }
}
