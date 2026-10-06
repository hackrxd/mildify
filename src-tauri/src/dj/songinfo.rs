//! What the DJ can look up about a song before picking it: Spotify's own metadata (release date, label, album,
//! popularity, the artist's biography, active years and related artists, read through the player's signed-in
//! session), the artist's genres from the Web API, and genres and tags from MusicBrainz when the user allows it.
//! Each source may fail on its own; what the others found is still returned. Complete answers are kept for a month;
//! one a source didn't give, for a few minutes, so it's asked again soon.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use librespot_core::{Session, SpotifyUri};
use librespot_metadata::artist::ActivityPeriod;
use librespot_metadata::{Album, Artist, Metadata, Track};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::webapi::WebApi;

/// How long a look-up is kept.
const KEEP_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// How long a look-up a source didn't answer is kept, before that source is asked again.
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);
/// The longest one MusicBrainz request may take.
const MUSICBRAINZ_TIMEOUT: Duration = Duration::from_secs(8);
/// At most this many songs are kept.
const KEEP_AT_MOST: usize = 2000;
/// MusicBrainz asks for no more than one request a second.
const MUSICBRAINZ_EVERY: Duration = Duration::from_millis(1100);
/// A whole look-up gives up on slow sources after this long: the DJ has a set to pick.
const DEADLINE: Duration = Duration::from_secs(12);
const MUSICBRAINZ: &str = "https://musicbrainz.org/ws/2";
/// Tags people put on everything, which say nothing about the music.
const NOISE: [&str; 6] = ["seen live", "favorites", "favourite", "albums i own", "under 2000 listeners", "spotify"];

/// A song to look up, as the UI knows it.
#[derive(Debug, Clone, Deserialize)]
pub struct SongRef {
    pub uri: String,
    pub name: String,
    #[serde(default)]
    pub artist: String,
    /// The first artist's Spotify id, for its genres.
    #[serde(default)]
    pub artist_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SongInfo {
    pub uri: String,
    /// The artist's genres on Spotify, then the song's on MusicBrainz.
    pub genres: Vec<String>,
    /// MusicBrainz tags that aren't genres already.
    pub tags: Vec<String>,
    /// `YYYY-MM-DD`, or just the year when that's all there is.
    pub released: Option<String>,
    pub label: Option<String>,
    pub album: Option<String>,
    /// album, single, compilation…
    pub album_type: Option<String>,
    /// Spotify's 0–100.
    pub popularity: Option<u8>,
    /// Languages sung in, as codes.
    pub languages: Vec<String>,
    pub artist_bio: Option<String>,
    /// "since 2001", "1998–2010", "the 1990s".
    pub artist_active: Option<String>,
    pub related_artists: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Kept {
    info: SongInfo,
    /// Seconds since the epoch.
    at: u64,
    /// Every source asked answered.
    #[serde(default)]
    complete: bool,
    /// MusicBrainz was among them.
    #[serde(default)]
    musicbrainz: bool,
}

impl Kept {
    fn fresh(&self, now: u64) -> bool {
        let keep = if self.complete { KEEP_FOR } else { RETRY_AFTER };
        now.saturating_sub(self.at) < keep.as_secs()
    }
}

pub struct SongLookup {
    http: reqwest::Client,
    file: PathBuf,
    kept: Mutex<Option<BTreeMap<String, Kept>>>,
    /// Held while the file is written, so two look-ups can't interleave their writes.
    saving: Mutex<()>,
    /// Bumped as everything's forgotten, so a look-up under way then keeps nothing.
    generation: std::sync::atomic::AtomicU64,
    /// When the last MusicBrainz request went out.
    musicbrainz_at: tokio::sync::Mutex<Option<Instant>>,
    musicbrainz_url: String,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl SongLookup {
    pub fn new(http: reqwest::Client, file: PathBuf) -> Self {
        Self {
            http,
            file,
            kept: Mutex::new(None),
            saving: Mutex::new(()),
            generation: std::sync::atomic::AtomicU64::new(0),
            musicbrainz_at: tokio::sync::Mutex::new(None),
            musicbrainz_url: MUSICBRAINZ.into(),
        }
    }

    /// What's known about each song, in the order asked.
    pub async fn look_up(&self, songs: &[SongRef], session: Option<Session>, web: &WebApi, musicbrainz: bool) -> Vec<SongInfo> {
        self.look_up_by(songs, session, web, musicbrainz, Instant::now() + DEADLINE).await
    }

    async fn look_up_by(
        &self,
        songs: &[SongRef],
        session: Option<Session>,
        web: &WebApi,
        musicbrainz: bool,
        deadline: Instant,
    ) -> Vec<SongInfo> {
        let left = || deadline.saturating_duration_since(Instant::now());
        let generation = self.generation();
        // Songs by the same artist in one look-up ask for its genres once.
        let mut genres_of: HashMap<String, Option<Vec<String>>> = HashMap::new();
        let mut out = Vec::with_capacity(songs.len());
        for song in songs {
            if let Some(info) = self.kept(&song.uri, musicbrainz) {
                out.push(info);
                continue;
            }
            let mut info = SongInfo { uri: song.uri.clone(), ..Default::default() };
            // Whether every source asked answered; a look-up missing one is asked again soon.
            let mut complete = session.is_some();
            let mut isrc = None;
            let mut artist_id = song.artist_id.clone();
            if let Some(session) = &session {
                match tokio::time::timeout(left(), spotify_metadata(session, &song.uri)).await {
                    Ok(Ok((found, found_isrc, found_artist, whole))) => {
                        // An album or artist entry missing is asked for again soon.
                        complete &= whole;
                        info = found;
                        isrc = found_isrc;
                        artist_id = artist_id.or(found_artist);
                    }
                    Ok(Err(e)) => {
                        complete = false;
                        log::info!("DJ: no Spotify metadata for {}: {e}", song.uri);
                    }
                    Err(_) => {
                        complete = false;
                        log::info!("DJ: Spotify's metadata for {} took too long", song.uri);
                    }
                }
            }
            if let Some(id) = artist_id {
                let known = match genres_of.get(&id) {
                    Some(known) => known.clone(),
                    None => {
                        let found = match tokio::time::timeout(left(), artist_genres(web, &id)).await {
                            Ok(Ok(genres)) => Some(genres),
                            Ok(Err(e)) => {
                                log::info!("DJ: no genres for artist {id}: {e}");
                                None
                            }
                            Err(_) => None,
                        };
                        genres_of.insert(id, found.clone());
                        found
                    }
                };
                match known {
                    Some(genres) => info.genres = genres,
                    None => complete = false,
                }
            }
            if musicbrainz {
                match self.musicbrainz(isrc.as_deref(), song, deadline).await {
                    Ok((genres, tags, whole)) => {
                        complete &= whole;
                        merge(&mut info, genres, tags);
                    }
                    Err(e) => {
                        complete = false;
                        log::info!("DJ: nothing from MusicBrainz for {}: {e}", song.uri);
                    }
                }
            }
            self.keep(&info, complete, musicbrainz, generation);
            out.push(info);
        }
        self.save(generation);
        out
    }

    fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Forgets every look-up, as the DJ's files are removed; one under way keeps nothing, nor writes the file.
    pub fn clear(&self) {
        let _saving = self.saving.lock().unwrap();
        let mut kept = self.kept.lock().unwrap();
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *kept = Some(BTreeMap::new());
    }

    fn with_kept<R>(&self, f: impl FnOnce(&mut BTreeMap<String, Kept>) -> R) -> R {
        let mut kept = self.kept.lock().unwrap();
        let map = kept.get_or_insert_with(|| {
            std::fs::read(&self.file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
        });
        f(map)
    }

    /// A look-up kept, unless it's old, or MusicBrainz is asked now and wasn't then.
    pub(super) fn kept(&self, uri: &str, musicbrainz: bool) -> Option<SongInfo> {
        let now = now_secs();
        self.with_kept(|m| m.get(uri).filter(|k| k.fresh(now) && (k.musicbrainz || !musicbrainz)).map(|k| k.info.clone()))
    }

    /// Keeps a look-up begun in `generation`, unless everything's been forgotten since.
    pub(super) fn keep(&self, info: &SongInfo, complete: bool, musicbrainz: bool, generation: u64) {
        let now = now_secs();
        self.with_kept(|m| {
            if self.generation() != generation {
                return;
            }
            m.insert(info.uri.clone(), Kept { info: info.clone(), at: now, complete, musicbrainz });
            m.retain(|_, k| k.fresh(now));
            while m.len() > KEEP_AT_MOST {
                let oldest = m.iter().min_by_key(|(_, k)| k.at).map(|(u, _)| u.clone());
                match oldest {
                    Some(u) => m.remove(&u),
                    None => break,
                };
            }
        });
    }

    /// Writes what's kept to a new file and moves it over the old one, one look-up at a time, so the file is
    /// never half written.
    fn save(&self, generation: u64) {
        let _saving = self.saving.lock().unwrap();
        // Forgotten since, with the DJ's folder going: nothing's written back into it.
        if self.generation() != generation {
            return;
        }
        let body = self.with_kept(|m| serde_json::to_vec(m).ok());
        let (Some(body), Some(dir)) = (body, self.file.parent()) else { return };
        let tmp = self.file.with_extension("json.tmp");
        let written = std::fs::create_dir_all(dir)
            .and_then(|()| std::fs::write(&tmp, body))
            .and_then(|()| std::fs::rename(&tmp, &self.file));
        if let Err(e) = written {
            log::warn!("DJ: couldn't keep song look-ups in {}: {e}", self.file.display());
        }
    }

    /// One MusicBrainz request, no sooner than a second after the last, and done by the deadline; `None` when
    /// MusicBrainz doesn't know what was asked for.
    async fn musicbrainz_get(&self, path: &str, deadline: Instant) -> Result<Option<Value>, String> {
        let mut last = self.musicbrainz_at.lock().await;
        if let Some(at) = *last {
            let ready = at + MUSICBRAINZ_EVERY;
            if ready > deadline {
                return Err("out of time".into());
            }
            tokio::time::sleep_until(ready.into()).await;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("out of time".into());
        }
        *last = Some(Instant::now());
        let resp = self
            .http
            .get(format!("{}{path}", self.musicbrainz_url))
            .header("User-Agent", concat!("Mildify/", env!("CARGO_PKG_VERSION"), " ( https://github.com/hackrxd/mildify )"))
            .header("Accept", "application/json")
            .timeout(MUSICBRAINZ_TIMEOUT.min(left))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(format!("MusicBrainz answered {}", resp.status()));
        }
        resp.json().await.map(Some).map_err(|e| e.to_string())
    }

    /// The song's genres and tags on MusicBrainz: by ISRC, or by searching for its title and artist when there's
    /// none or MusicBrainz doesn't know it; then the artist's, when the recording has no genres of its own.
    /// Whether it got all it asked for comes third: the artist's genres can be missing.
    async fn musicbrainz(&self, isrc: Option<&str>, song: &SongRef, deadline: Instant) -> Result<(Vec<String>, Vec<String>, bool), String> {
        let mut found = None;
        if let Some(isrc) = isrc {
            found = self
                .musicbrainz_get(&format!("/isrc/{isrc}?inc=artists+genres+tags&fmt=json"), deadline)
                .await?
                .filter(|v| v["recordings"].as_array().is_some_and(|r| !r.is_empty()));
        }
        let found = match found {
            Some(v) => v,
            None => {
                let query = format!("recording:\"{}\" AND artist:\"{}\"", quoted(&song.name), quoted(&song.artist));
                let q = url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>();
                match self.musicbrainz_get(&format!("/recording?query={q}&limit=1&fmt=json"), deadline).await? {
                    Some(v) => v,
                    None => return Ok((Vec::new(), Vec::new(), true)),
                }
            }
        };
        let (mut genres, tags, artist) = read_recording(&found);
        let mut whole = true;
        if genres.is_empty() {
            if let Some(mbid) = artist {
                match self.musicbrainz_get(&format!("/artist/{mbid}?inc=genres&fmt=json"), deadline).await {
                    Ok(Some(a)) => genres = top_names(&a["genres"], 4),
                    Ok(None) => {}
                    Err(e) => {
                        log::info!("DJ: no MusicBrainz genres for {}'s artist: {e}", song.uri);
                        whole = false;
                    }
                }
            }
        }
        Ok((genres, tags, whole))
    }
}

/// Escapes quotes and backslashes for a Lucene phrase.
fn quoted(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Spotify's genres and the MusicBrainz ones together, without repeats; tags that are genres already go.
fn merge(info: &mut SongInfo, genres: Vec<String>, tags: Vec<String>) {
    for g in genres {
        if !info.genres.iter().any(|h| h.eq_ignore_ascii_case(&g)) {
            info.genres.push(g);
        }
    }
    info.genres.truncate(6);
    info.tags = tags.into_iter().filter(|t| !info.genres.iter().any(|g| g.eq_ignore_ascii_case(t))).take(3).collect();
}

/// The first recording's genres and tags, by votes, and its first artist's MusicBrainz id. An ISRC lookup
/// lists recordings under `recordings`; a search, likewise.
fn read_recording(v: &Value) -> (Vec<String>, Vec<String>, Option<String>) {
    let Some(rec) = v["recordings"].as_array().and_then(|r| r.first()) else { return (Vec::new(), Vec::new(), None) };
    let genres = top_names(&rec["genres"], 4);
    let tags = top_names(&rec["tags"], 6)
        .into_iter()
        .filter(|t| !NOISE.contains(&t.as_str()) && !genres.contains(t))
        .take(3)
        .collect();
    let artist = rec["artist-credit"][0]["artist"]["id"].as_str().map(str::to_owned);
    (genres, tags, artist)
}

/// The names in a MusicBrainz genre or tag list with at least one vote, most votes first.
fn top_names(list: &Value, n: usize) -> Vec<String> {
    let mut items: Vec<(i64, String)> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| Some((t["count"].as_i64().unwrap_or(0), t["name"].as_str()?.trim().to_lowercase())))
        .filter(|(count, name)| *count > 0 && !name.is_empty())
        .collect();
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    items.into_iter().map(|(_, name)| name).take(n).collect()
}

/// The artist's genres from the Web API (paced like every other request).
async fn artist_genres(web: &WebApi, id: &str) -> crate::error::Result<Vec<String>> {
    let artist = web.request("GET", &format!("/artists/{id}"), None, None).await?;
    Ok(artist["genres"].as_array().into_iter().flatten().filter_map(Value::as_str).take(4).map(str::to_owned).collect())
}

/// What Spotify's metadata says about the track, its album and its first artist; with the ISRC and the
/// artist's id, for the other sources, and whether the album's and artist's entries were both there.
async fn spotify_metadata(session: &Session, uri: &str) -> Result<(SongInfo, Option<String>, Option<String>, bool), String> {
    let id = SpotifyUri::from_uri(uri).map_err(|e| e.to_string())?;
    let track = Track::get(session, &id).await.map_err(|e| e.to_string())?;
    let mut info = SongInfo {
        uri: uri.to_owned(),
        popularity: u8::try_from(track.popularity.clamp(0, 100)).ok().filter(|p| *p > 0),
        languages: track.language_of_performance.iter().filter(|l| !l.is_empty()).cloned().collect(),
        ..Default::default()
    };
    let isrc = track.external_ids.iter().find(|e| e.external_type.eq_ignore_ascii_case("isrc")).map(|e| e.id.clone());
    let mut whole = true;
    // The track carries a partial album; the album's own entry has its label and date.
    match Album::get(session, &track.album.id).await {
        Ok(album) => {
            info.album = non_empty(&album.name);
            info.label = non_empty(&album.label);
            info.album_type = non_empty(&album.type_str.to_lowercase()).or_else(|| Some(format!("{:?}", album.album_type).to_lowercase()));
            info.released = Some(release_date(album.date.year(), u8::from(album.date.month()), album.date.day()));
        }
        Err(e) => {
            log::info!("DJ: no album metadata for {uri}: {e}");
            info.album = non_empty(&track.album.name);
            whole = false;
        }
    }
    let artist_id = track.artists.first().map(|a| a.id.clone());
    if let Some(aid) = &artist_id {
        match Artist::get(session, aid).await {
            Ok(artist) => {
                info.artist_bio = artist.biographies.first().and_then(|b| bio(&b.text));
                info.artist_active = active(&artist.activity_periods);
                info.related_artists = artist.related.iter().map(|a| a.name.clone()).filter(|n| !n.is_empty()).take(3).collect();
            }
            Err(e) => {
                log::info!("DJ: no artist metadata for {uri}: {e}");
                whole = false;
            }
        }
    }
    Ok((info, isrc, artist_id.map(|a| a.to_id()), whole))
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

/// Spotify gives a date with only a year as 1 January of it.
fn release_date(year: i32, month: u8, day: u8) -> String {
    if month == 1 && day == 1 {
        year.to_string()
    } else {
        format!("{year:04}-{month:02}-{day:02}")
    }
}

/// The start of a biography, as plain text: Spotify's has links in it.
fn bio(html: &str) -> Option<String> {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => text.push(c),
            _ => {}
        }
    }
    let text = text.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= 300 {
        return Some(text);
    }
    // Whole sentences, up to about 300 characters.
    let cut: String = text.chars().take(300).collect();
    Some(match cut.rfind(". ") {
        Some(i) if i > 80 => cut[..=i].to_owned(),
        _ => format!("{}…", cut.trim_end()),
    })
}

fn active(periods: &[ActivityPeriod]) -> Option<String> {
    let first = periods.first()?;
    Some(match (first, periods.last()) {
        (ActivityPeriod::Decade(d), _) => format!("the {d}s"),
        (ActivityPeriod::Timespan { start_year, .. }, Some(ActivityPeriod::Timespan { end_year: Some(end), .. })) => {
            format!("{start_year}–{end}")
        }
        (ActivityPeriod::Timespan { start_year, .. }, _) => format!("since {start_year}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lookup() -> SongLookup {
        let file = std::env::temp_dir().join(format!("mildify-songs-{}", crate::config::random_hex(8))).join("songs.json");
        SongLookup::new(reqwest::Client::new(), file)
    }

    #[test]
    fn reads_genres_and_tags_from_an_isrc_lookup() {
        // The shape MusicBrainz documents for /ws/2/isrc/<isrc>?inc=artists+genres+tags.
        let v = json!({ "isrc": "FRZ111100211", "recordings": [{
            "id": "r1", "title": "Midnight City",
            "artist-credit": [{ "name": "M83", "artist": { "id": "a-m83", "name": "M83" } }],
            "genres": [{ "name": "Electronic", "count": 2 }, { "name": "synth-pop", "count": 5 }, { "name": "dream pop", "count": 0 }],
            "tags": [{ "name": "seen live", "count": 9 }, { "name": "synth-pop", "count": 4 }, { "name": "80s", "count": 3 }],
        }]});
        let (genres, tags, artist) = read_recording(&v);
        assert_eq!(genres, ["synth-pop", "electronic"]);
        assert_eq!(tags, ["80s"]);
        assert_eq!(artist.as_deref(), Some("a-m83"));
        assert_eq!(read_recording(&json!({ "recordings": [] })), (vec![], vec![], None));
    }

    #[test]
    fn puts_spotifys_genres_first_without_repeats() {
        let mut info = SongInfo { genres: vec!["Synth-pop".into(), "french electronic".into()], ..Default::default() };
        merge(&mut info, vec!["synth-pop".into(), "electronic".into()], vec!["electronic".into(), "80s".into()]);
        assert_eq!(info.genres, ["Synth-pop", "french electronic", "electronic"]);
        assert_eq!(info.tags, ["80s"]);
    }

    #[test]
    fn says_dates_bios_and_careers_plainly() {
        assert_eq!(release_date(2011, 9, 30), "2011-09-30");
        assert_eq!(release_date(1979, 1, 1), "1979");
        assert_eq!(bio("<a href=\"spotify:artist:x\">M83</a> is a French band &amp; project."), Some("M83 is a French band & project.".into()));
        assert_eq!(bio("  "), None);
        let long = "First sentence of a long biography goes on for a while here. ".repeat(10);
        let short = bio(&long).unwrap();
        assert!(short.chars().count() <= 301 && short.ends_with('.'), "{short}");
        assert_eq!(active(&[ActivityPeriod::Timespan { start_year: 2001, end_year: None }]).as_deref(), Some("since 2001"));
        assert_eq!(
            active(&[
                ActivityPeriod::Timespan { start_year: 1998, end_year: Some(2003) },
                ActivityPeriod::Timespan { start_year: 2005, end_year: Some(2010) },
            ])
            .as_deref(),
            Some("1998–2010")
        );
        assert_eq!(active(&[ActivityPeriod::Decade(1990)]).as_deref(), Some("the 1990s"));
        assert_eq!(active(&[]), None);
    }

    #[test]
    fn keeps_look_ups_for_a_month_and_on_disk() {
        let l = lookup();
        let info = SongInfo { uri: "spotify:track:a".into(), label: Some("Mute".into()), ..Default::default() };
        l.keep(&info, true, false, 0);
        l.save(0);
        assert_eq!(l.kept("spotify:track:a", false), Some(info.clone()));
        let again = SongLookup::new(reqwest::Client::new(), l.file.clone());
        assert_eq!(again.kept("spotify:track:a", false), Some(info));
        // A month on, it's asked again.
        again.with_kept(|m| m.get_mut("spotify:track:a").unwrap().at -= KEEP_FOR.as_secs());
        assert_eq!(again.kept("spotify:track:a", false), None);
    }

    #[test]
    fn keeps_only_so_many() {
        let l = lookup();
        for i in 0..(KEEP_AT_MOST + 5) {
            l.with_kept(|m| {
                m.insert(format!("u{i}"), Kept { info: SongInfo::default(), at: now_secs() - 1000 + i as u64 / 10, complete: true, musicbrainz: false });
            });
        }
        l.keep(&SongInfo { uri: "newest".into(), ..Default::default() }, true, false, 0);
        assert_eq!(l.with_kept(|m| m.len()), KEEP_AT_MOST);
        assert!(l.kept("newest", false).is_some());
        assert!(l.kept("u0", false).is_none());
    }

    #[test]
    fn keeps_an_incomplete_look_up_only_a_few_minutes() {
        let l = lookup();
        let info = SongInfo { uri: "spotify:track:a".into(), ..Default::default() };
        l.keep(&info, false, false, 0);
        assert!(l.kept("spotify:track:a", false).is_some());
        l.with_kept(|m| m.get_mut("spotify:track:a").unwrap().at -= RETRY_AFTER.as_secs());
        assert_eq!(l.kept("spotify:track:a", false), None);
        l.keep(&info, true, false, 0);
        l.with_kept(|m| m.get_mut("spotify:track:a").unwrap().at -= RETRY_AFTER.as_secs());
        assert!(l.kept("spotify:track:a", false).is_some());
    }

    #[tokio::test]
    async fn without_the_player_a_look_up_is_asked_again_soon() {
        let l = lookup();
        let web = WebApi::new(reqwest::Client::new(), l.file.with_file_name("token.json"));
        let song = SongRef { uri: "spotify:track:a".into(), name: "x".into(), artist: "y".into(), artist_id: None };
        l.look_up(&[song], None, &web, false).await;
        assert!(!l.with_kept(|m| m["spotify:track:a"].complete));
    }

    #[test]
    fn forgets_everything_when_the_djs_files_go() {
        let l = lookup();
        l.keep(&SongInfo { uri: "spotify:track:a".into(), ..Default::default() }, true, false, 0);
        l.save(0);
        l.clear();
        assert_eq!(l.kept("spotify:track:a", false), None);
    }

    #[test]
    fn a_look_up_under_way_as_everything_is_forgotten_keeps_nothing() {
        let l = lookup();
        let started = l.generation();
        l.clear();
        // The DJ's folder is gone by now.
        l.keep(&SongInfo { uri: "spotify:track:a".into(), ..Default::default() }, true, false, started);
        l.save(started);
        assert_eq!(l.kept("spotify:track:a", false), None);
        assert!(!l.file.exists());
    }

    #[test]
    fn looks_a_song_up_again_once_musicbrainz_is_allowed() {
        let l = lookup();
        l.keep(&SongInfo { uri: "spotify:track:a".into(), ..Default::default() }, true, false, 0);
        assert!(l.kept("spotify:track:a", false).is_some());
        assert_eq!(l.kept("spotify:track:a", true), None);
        l.keep(&SongInfo { uri: "spotify:track:b".into(), ..Default::default() }, true, true, 0);
        assert!(l.kept("spotify:track:b", true).is_some());
        assert!(l.kept("spotify:track:b", false).is_some());
    }

    #[test]
    fn writes_the_whole_file_or_none_of_it() {
        let l = lookup();
        l.keep(&SongInfo { uri: "spotify:track:a".into(), ..Default::default() }, true, false, 0);
        l.save(0);
        assert!(!l.file.with_extension("json.tmp").exists());
        let again = SongLookup::new(reqwest::Client::new(), l.file.clone());
        assert!(again.kept("spotify:track:a", false).is_some());
    }

    /// Answers requests over loopback in turn with these statuses and bodies, or never answers past them, and
    /// hands back the request lines it got.
    async fn serve(replies: Vec<(u16, &'static str)>, hang: bool) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut seen = Vec::new();
            for (status, body) in replies {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap();
                seen.push(String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or_default().to_owned());
                let head = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                sock.write_all(head.as_bytes()).await.unwrap();
                sock.write_all(body.as_bytes()).await.unwrap();
            }
            if hang {
                let (_sock, _) = listener.accept().await.unwrap();
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
            seen
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn searches_by_title_when_musicbrainz_doesnt_know_the_isrc() {
        let search = r#"{"recordings":[{"title":"x","genres":[{"name":"shoegaze","count":2}],"tags":[]}]}"#;
        let (url, server) = serve(vec![(404, r#"{"error":"Not Found"}"#), (200, search)], false).await;
        let mut l = lookup();
        l.musicbrainz_url = url;
        let song = SongRef { uri: "u".into(), name: "When You Sleep".into(), artist: "My Bloody Valentine".into(), artist_id: None };
        let (genres, _, whole) = l.musicbrainz(Some("GBAAA9100001"), &song, Instant::now() + DEADLINE).await.unwrap();
        assert_eq!(genres, ["shoegaze"]);
        assert!(whole);
        let seen = server.await.unwrap();
        assert!(seen[0].contains("/isrc/GBAAA9100001"));
        assert!(seen[1].contains("/recording?query="));
    }

    #[tokio::test]
    async fn says_when_the_artists_genres_didnt_come() {
        let search = r#"{"recordings":[{"title":"x","genres":[],"tags":[],"artist-credit":[{"artist":{"id":"a-1"}}]}]}"#;
        let (url, server) = serve(vec![(200, search), (503, r#"{"error":"slow down"}"#)], false).await;
        let mut l = lookup();
        l.musicbrainz_url = url;
        let song = SongRef { uri: "u".into(), name: "x".into(), artist: "y".into(), artist_id: None };
        let (genres, _, whole) = l.musicbrainz(None, &song, Instant::now() + DEADLINE).await.unwrap();
        assert!(genres.is_empty());
        assert!(!whole);
        assert!(server.await.unwrap()[1].contains("/artist/a-1"));
    }

    #[tokio::test]
    async fn a_stalled_musicbrainz_request_ends_at_the_deadline() {
        let (url, _server) = serve(vec![], true).await;
        let mut l = lookup();
        l.musicbrainz_url = url;
        let song = SongRef { uri: "u".into(), name: "x".into(), artist: "y".into(), artist_id: None };
        let started = Instant::now();
        assert!(l.musicbrainz(None, &song, started + Duration::from_millis(400)).await.is_err());
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn waits_a_second_between_musicbrainz_requests_and_names_itself() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..3 {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap();
                requests.push((Instant::now(), String::from_utf8_lossy(&buf[..n]).into_owned()));
                let body = r#"{"recordings":[]}"#;
                let head = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                sock.write_all(head.as_bytes()).await.unwrap();
                sock.write_all(body.as_bytes()).await.unwrap();
            }
            requests
        });
        let mut l = lookup();
        l.musicbrainz_url = format!("http://{addr}");
        let deadline = Instant::now() + DEADLINE;
        let song = SongRef { uri: "spotify:track:a".into(), name: "Say \"Hi\"".into(), artist: "M83".into(), artist_id: None };
        l.musicbrainz(None, &song, deadline).await.unwrap();
        l.musicbrainz(Some("FRZ111100211"), &song, deadline).await.unwrap();
        let requests = server.await.unwrap();
        assert!(requests[1].0 - requests[0].0 >= Duration::from_millis(1000));
        let first = requests[0].1.to_ascii_lowercase();
        assert!(first.contains("user-agent: mildify/"), "{first}");
        assert!(first.contains("/recording?query=recording%3a%22say+%5c%22hi%5c%22%22"), "{first}");
        assert!(requests[1].1.contains("/isrc/FRZ111100211?inc=artists+genres+tags"));
        // An ISRC with no recordings there: the search by title and artist, a second later again.
        assert!(requests[2].1.contains("/recording?query="));
        assert!(requests[2].0 - requests[1].0 >= Duration::from_millis(1000));
    }

    #[tokio::test]
    async fn gives_up_on_musicbrainz_past_the_deadline() {
        let l = lookup();
        *l.musicbrainz_at.lock().await = Some(Instant::now());
        let song = SongRef { uri: "u".into(), name: "x".into(), artist: "y".into(), artist_id: None };
        let soon = Instant::now() + Duration::from_millis(100);
        assert_eq!(l.musicbrainz(None, &song, soon).await.unwrap_err(), "out of time");
    }
}
