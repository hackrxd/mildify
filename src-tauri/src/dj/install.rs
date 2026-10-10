//! Downloads a component into the DJ folder: resumable, checked against its SHA-256, then unpacked
//! next to its final place and moved in once complete, so a half-finished install never looks installed.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{CONTENT_RANGE, RANGE};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::manifest::{Component, Pack};
use crate::error::{AppError, Result};

/// Written last into a component's folder: its presence means the folder is whole.
pub(crate) const COMPLETE: &str = ".complete";
/// Partial downloads, kept so an interrupted one resumes.
pub const DOWNLOADS: &str = "downloads";
/// A download that sends nothing for this long has stalled.
const STALL: Duration = Duration::from_secs(60);

pub fn component_dir(root: &Path, c: &Component) -> PathBuf {
    root.join(c.id)
}

pub fn is_installed(root: &Path, c: &Component) -> bool {
    component_dir(root, c).join(COMPLETE).is_file()
}

/// Finds `name` at most `depth` folders below `dir`; downloads put their files under a folder of their own.
pub fn find(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let candidate = dir.join(name);
    if candidate.is_file() {
        return Some(candidate);
    }
    if depth == 0 {
        return None;
    }
    let mut subdirs: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    subdirs.sort();
    subdirs.into_iter().find_map(|d| find(&d, name, depth - 1))
}

/// Total size of the files under `path`.
pub fn size_of(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    fs::read_dir(path)
        .map(|entries| entries.filter_map(|e| e.ok()).map(|e| size_of(&e.path())).sum())
        .unwrap_or(0)
}

/// Removes folders a newer build no longer uses (an older runtime, say), and leftovers of interrupted unpacks.
pub fn remove_stale(root: &Path, known: &[&str]) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == DOWNLOADS || known.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let r = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        if let Err(e) = r {
            log::warn!("couldn't remove {}: {e}", path.display());
        }
    }
}

/// What a download has done so far.
pub trait Progress: Send + Sync {
    fn report(&self, received: u64, total: Option<u64>);
    fn cancelled(&self) -> bool;
}

/// Downloads, checks and unpacks `c` into `root`, unless it's there already.
pub async fn install(http: &reqwest::Client, root: &Path, c: &Component, progress: &dyn Progress) -> Result<()> {
    if is_installed(root, c) {
        return Ok(());
    }
    let downloads = root.join(DOWNLOADS);
    tokio::fs::create_dir_all(&downloads).await?;
    let part = downloads.join(format!("{}.part", c.id));

    download(http, c.url, &part, Some(c.sha256), progress).await?;

    let dest = component_dir(root, c);
    let staging = root.join(format!(".{}.unpacking", c.id));
    let file_name = c.url.rsplit('/').next().unwrap_or(c.id).to_owned();
    let pack = c.pack;
    let (part2, staging2, dest2) = (part.clone(), staging.clone(), dest.clone());
    tokio::task::spawn_blocking(move || -> Result<()> {
        let _ = fs::remove_dir_all(&staging2);
        fs::create_dir_all(&staging2)?;
        if pack == Pack::File {
            check_format(&part2, &file_name)?;
            fs::rename(&part2, staging2.join(&file_name))?;
        } else {
            unpack(&part2, pack, &staging2).map_err(|e| {
                let _ = fs::remove_dir_all(&staging2);
                AppError::Other(format!("Couldn't unpack {file_name}: {e}"))
            })?;
            let _ = fs::remove_file(&part2);
        }
        fs::write(staging2.join(COMPLETE), "")?;
        let _ = fs::remove_dir_all(&dest2);
        fs::rename(&staging2, &dest2)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    let _ = tokio::fs::remove_file(&part).await;
    Ok(())
}

/// Downloads `url` into `part`, resuming what's already there, and checks the whole file against `sha256`.
async fn download(
    http: &reqwest::Client,
    url: &str,
    part: &Path,
    sha256: Option<&str>,
    progress: &dyn Progress,
) -> Result<()> {
    let mut hasher = Sha256::new();
    let mut have = match tokio::fs::metadata(part).await {
        Ok(m) if m.is_file() => {
            let path = part.to_owned();
            let (h, n) = tokio::task::spawn_blocking(move || hash_file(&path))
                .await
                .map_err(|e| AppError::Other(e.to_string()))??;
            hasher = h;
            n
        }
        _ => 0,
    };

    let mut request = http.get(url);
    if have > 0 {
        request = request.header(RANGE, format!("bytes={have}-"));
    }
    let mut resp = request.send().await?;
    let status = resp.status().as_u16();
    let mut file = match status {
        206 => {
            if resumes_at(resp.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok())) != Some(have) {
                let _ = tokio::fs::remove_file(part).await;
                return Err(AppError::Other("The download couldn't pick up where it stopped. Try again.".into()));
            }
            tokio::fs::OpenOptions::new().append(true).open(part).await?
        }
        // What we have is the whole file already.
        416 if have > 0 => return verify(part, hasher, sha256).await,
        200..=299 => {
            hasher = Sha256::new();
            have = 0;
            tokio::fs::File::create(part).await?
        }
        _ => {
            return Err(AppError::Api { status, message: format!("Download failed: {url}") });
        }
    };
    let total = resp.content_length().map(|n| n + have);
    progress.report(have, total);

    loop {
        if progress.cancelled() {
            file.flush().await?;
            return Err(AppError::Cancelled);
        }
        let chunk = tokio::time::timeout(STALL, resp.chunk())
            .await
            .map_err(|_| AppError::Other("The download stalled. Try again.".into()))??;
        let Some(chunk) = chunk else { break };
        // Cancelled while waiting: a newer install may own the file now.
        if progress.cancelled() {
            return Err(AppError::Cancelled);
        }
        file.write_all(&chunk).await?;
        hasher.update(&chunk);
        have += chunk.len() as u64;
        progress.report(have, total);
    }
    file.flush().await?;
    drop(file);
    if total.is_some_and(|t| t != have) {
        return Err(AppError::Other("The download ended early. Try again to continue it.".into()));
    }
    verify(part, hasher, sha256).await
}

/// Where a `206` response's `Content-Range: bytes N-M/T` starts.
fn resumes_at(content_range: Option<&str>) -> Option<u64> {
    content_range?.strip_prefix("bytes ")?.split('-').next()?.trim().parse().ok()
}

async fn verify(part: &Path, hasher: Sha256, sha256: Option<&str>) -> Result<()> {
    let got = hex(&hasher.finalize());
    match sha256 {
        Some(want) if !got.eq_ignore_ascii_case(want) => {
            let _ = tokio::fs::remove_file(part).await;
            log::warn!("{} has SHA-256 {got}, expected {want}", part.display());
            Err(AppError::Other("A download came out damaged, so it was thrown away. Try again.".into()))
        }
        _ => Ok(()),
    }
}

fn hash_file(path: &Path) -> io::Result<(Sha256, u64)> {
    let mut f = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut n = 0u64;
    loop {
        let read = f.read(&mut buf)?;
        if read == 0 {
            return Ok((hasher, n));
        }
        hasher.update(&buf[..read]);
        n += read as u64;
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Model weights are GGUF files; anything else (an error page, say) isn't kept.
fn check_format(path: &Path, file_name: &str) -> Result<()> {
    if !file_name.ends_with(".gguf") {
        return Ok(());
    }
    let mut magic = [0u8; 4];
    let ok = fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && &magic == b"GGUF";
    if !ok {
        let _ = fs::remove_file(path);
        return Err(AppError::Other("The model download isn't a model file. Try again later.".into()));
    }
    Ok(())
}

/// Unpacks an archive into `dest`. Entries that would land outside it are refused by the archive readers.
pub fn unpack(archive: &Path, pack: Pack, dest: &Path) -> io::Result<()> {
    let file = io::BufReader::new(fs::File::open(archive)?);
    match pack {
        Pack::File => Err(io::Error::other("not an archive")),
        Pack::TarGz => tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(dest),
        Pack::TarBz2 => tar::Archive::new(bzip2::read::MultiBzDecoder::new(file)).unpack(dest),
        Pack::Zip => zip::ZipArchive::new(file)
            .and_then(|mut z| z.extract(dest))
            .map_err(io::Error::other),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mildify-test-{}", crate::config::random_hex(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tar_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for (name, data) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o755);
            h.set_cksum();
            b.append_data(&mut h, name, *data).unwrap();
        }
        b.into_inner().unwrap()
    }

    #[test]
    fn unpacks_every_archive_kind() {
        let dir = scratch();
        let tar = tar_of(&[("pkg/bin/tool", b"#!"), ("pkg/lib/lib.so", b"lib")]);

        let gz = dir.join("a.tar.gz");
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(&tar).unwrap();
        fs::write(&gz, enc.finish().unwrap()).unwrap();
        unpack(&gz, Pack::TarGz, &dir.join("gz")).unwrap();
        assert_eq!(fs::read(dir.join("gz/pkg/bin/tool")).unwrap(), b"#!");

        let bz = dir.join("a.tar.bz2");
        let mut enc = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        enc.write_all(&tar).unwrap();
        fs::write(&bz, enc.finish().unwrap()).unwrap();
        unpack(&bz, Pack::TarBz2, &dir.join("bz")).unwrap();
        assert_eq!(fs::read(dir.join("bz/pkg/lib/lib.so")).unwrap(), b"lib");

        let zip = dir.join("a.zip");
        let mut w = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        w.start_file("tool.exe", opts).unwrap();
        w.write_all(b"MZ").unwrap();
        w.finish().unwrap();
        unpack(&zip, Pack::Zip, &dir.join("zip")).unwrap();
        assert_eq!(fs::read(dir.join("zip/tool.exe")).unwrap(), b"MZ");

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unpacked_programs_stay_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let archive = dir.join("a.tar.gz");
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(&tar_of(&[("bin/tool", b"#!")])).unwrap();
        fs::write(&archive, enc.finish().unwrap()).unwrap();
        unpack(&archive, Pack::TarGz, &dir.join("out")).unwrap();
        let mode = fs::metadata(dir.join("out/bin/tool")).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "{mode:o}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn archive_entries_cant_escape_the_folder() {
        let dir = scratch();
        // tar::Builder refuses to write `..`, so build the header by hand.
        let mut h = tar::Header::new_old();
        h.as_old_mut().name[..13].copy_from_slice(b"../escaped.sh");
        h.set_size(2);
        h.set_mode(0o644);
        h.set_cksum();
        let mut raw = h.as_bytes().to_vec();
        raw.extend_from_slice(b"hi");
        raw.resize(raw.len().div_ceil(512) * 512 + 1024, 0);
        let archive = dir.join("evil.tar.gz");
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(&raw).unwrap();
        fs::write(&archive, enc.finish().unwrap()).unwrap();
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let _ = unpack(&archive, Pack::TarGz, &out);
        assert!(!dir.join("escaped.sh").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finds_files_inside_a_downloads_own_folder() {
        let dir = scratch();
        fs::create_dir_all(dir.join("pkg-1.0/bin")).unwrap();
        fs::write(dir.join("pkg-1.0/bin/tool"), "").unwrap();
        assert_eq!(find(&dir, "tool", 2), Some(dir.join("pkg-1.0/bin/tool")));
        assert_eq!(find(&dir, "tool", 1), None);
        assert_eq!(find(&dir, "missing", 3), None);
        assert_eq!(find(&dir.join("nope"), "tool", 3), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stale_folders_go_and_known_ones_stay() {
        let dir = scratch();
        for d in ["llama-b1", "llama-b2", DOWNLOADS, ".llama-b2.unpacking"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        fs::write(dir.join("stray.txt"), "x").unwrap();
        remove_stale(&dir, &["llama-b2"]);
        let mut left: Vec<String> =
            fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, vec![DOWNLOADS.to_owned(), "llama-b2".to_owned()]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sizes_add_up_across_folders() {
        let dir = scratch();
        fs::create_dir_all(dir.join("a/b")).unwrap();
        fs::write(dir.join("a/one"), vec![0u8; 10]).unwrap();
        fs::write(dir.join("a/b/two"), vec![0u8; 32]).unwrap();
        assert_eq!(size_of(&dir), 42);
        assert_eq!(size_of(&dir.join("missing")), 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_where_a_resumed_download_starts() {
        assert_eq!(resumes_at(Some("bytes 100-199/200")), Some(100));
        assert_eq!(resumes_at(Some("bytes 0-9/*")), Some(0));
        assert_eq!(resumes_at(Some("items 1-2/3")), None);
        assert_eq!(resumes_at(None), None);
    }

    #[test]
    fn only_real_model_files_are_kept() {
        let dir = scratch();
        let good = dir.join("good");
        fs::write(&good, b"GGUF\x03\0\0\0").unwrap();
        check_format(&good, "m.gguf").unwrap();
        let page = dir.join("page");
        fs::write(&page, b"<!doctype html>").unwrap();
        assert!(check_format(&page, "m.gguf").is_err());
        assert!(!page.exists());
        // Only models are checked.
        fs::write(&page, b"anything").unwrap();
        check_format(&page, "voices.bin").unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    struct Counter {
        last: AtomicU64,
        stop: AtomicBool,
    }

    impl Progress for Counter {
        fn report(&self, received: u64, _total: Option<u64>) {
            self.last.store(received, Ordering::SeqCst);
        }
        fn cancelled(&self) -> bool {
            self.stop.load(Ordering::SeqCst)
        }
    }

    /// Serves `body` once over a loopback socket, honouring a `Range: bytes=N-` request.
    async fn serve_once(body: Vec<u8>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = vec![0u8; 4096];
            let n = sock.read(&mut req).await.unwrap();
            let req = String::from_utf8_lossy(&req[..n]).to_ascii_lowercase();
            let from = req
                .lines()
                .find_map(|l| l.strip_prefix("range: bytes="))
                .and_then(|r| r.trim_end_matches('-').parse::<usize>().ok());
            let head = match from {
                Some(f) => format!(
                    "HTTP/1.1 206 Partial Content\r\ncontent-length: {}\r\n\
                     content-range: bytes {f}-{}/{}\r\nconnection: close\r\n\r\n",
                    body.len() - f,
                    body.len() - 1,
                    body.len()
                ),
                None => format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()),
            };
            sock.write_all(head.as_bytes()).await.unwrap();
            sock.write_all(&body[from.unwrap_or(0)..]).await.unwrap();
        });
        format!("http://{addr}/file")
    }

    fn sha(data: &[u8]) -> String {
        hex(&Sha256::digest(data))
    }

    #[tokio::test]
    async fn downloads_and_checks_a_file() {
        let dir = scratch();
        let body = b"hello, dj".repeat(1000);
        let url = serve_once(body.clone()).await;
        let progress = Counter { last: AtomicU64::new(0), stop: AtomicBool::new(false) };
        let part = dir.join("f.part");
        download(&reqwest::Client::new(), &url, &part, Some(&sha(&body)), &progress).await.unwrap();
        assert_eq!(fs::read(&part).unwrap(), body);
        assert_eq!(progress.last.load(Ordering::SeqCst), body.len() as u64);
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn resumes_an_interrupted_download() {
        let dir = scratch();
        let body: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
        let part = dir.join("f.part");
        fs::write(&part, &body[..12_345]).unwrap();
        let url = serve_once(body.clone()).await;
        let progress = Counter { last: AtomicU64::new(0), stop: AtomicBool::new(false) };
        download(&reqwest::Client::new(), &url, &part, Some(&sha(&body)), &progress).await.unwrap();
        assert_eq!(fs::read(&part).unwrap(), body);
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn throws_away_a_damaged_download() {
        let dir = scratch();
        let url = serve_once(b"tampered".to_vec()).await;
        let progress = Counter { last: AtomicU64::new(0), stop: AtomicBool::new(false) };
        let part = dir.join("f.part");
        let err = download(&reqwest::Client::new(), &url, &part, Some(&sha(b"original")), &progress).await;
        assert!(matches!(err, Err(AppError::Other(m)) if m.contains("damaged")));
        assert!(!part.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_cancelled_download_keeps_its_part_for_later() {
        let dir = scratch();
        let url = serve_once(vec![7u8; 10_000]).await;
        let progress = Counter { last: AtomicU64::new(0), stop: AtomicBool::new(true) };
        let part = dir.join("f.part");
        let err = download(&reqwest::Client::new(), &url, &part, None, &progress).await;
        assert!(matches!(err, Err(AppError::Cancelled)));
        assert!(part.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn installs_into_a_complete_folder() {
        let root = scratch();
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(&tar_of(&[("pkg/bin/tool", b"#!")])).unwrap();
        let body = enc.finish().unwrap();
        let url: &'static str = Box::leak(serve_once(body.clone()).await.into_boxed_str());
        let sha: &'static str = Box::leak(sha(&body).into_boxed_str());
        let c = Component { id: "pkg-1", label: "Pkg", url, sha256: sha, bytes: 1, pack: Pack::TarGz };
        let progress = Counter { last: AtomicU64::new(0), stop: AtomicBool::new(false) };
        assert!(!is_installed(&root, &c));
        install(&reqwest::Client::new(), &root, &c, &progress).await.unwrap();
        assert!(is_installed(&root, &c));
        assert_eq!(find(&component_dir(&root, &c), "tool", 3), Some(root.join("pkg-1/pkg/bin/tool")));
        assert!(!root.join(DOWNLOADS).join("pkg-1.part").exists());
        // Installed already: no second request (the test server has gone).
        install(&reqwest::Client::new(), &root, &c, &progress).await.unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
