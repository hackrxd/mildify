//! The DJ's voice: sherpa-onnx's offline text-to-speech program reads a line into a WAV file. It reports
//! each sentence's length as it goes, which times the captions sentence by sentence. What it's given is what the
//! captions show, sentence by sentence, said the way it reads right (`say.rs`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use super::manifest::Voice;
use super::say;
use crate::error::{AppError, Result};

/// Anything longer isn't a DJ line.
const MAX_CHARS: usize = 800;
/// Reading a long line with the bigger voice on a slow CPU.
const TIMEOUT: Duration = Duration::from_secs(120);
/// How much slower or faster than its own pace the voice may speak: Settings' range.
pub const SPEED_MIN: f32 = 0.8;
pub const SPEED_MAX: f32 = 1.3;

/// A sentence of the line and when it's spoken, from the start of the audio.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Sentence {
    pub text: String,
    pub start_ms: u32,
    pub end_ms: u32,
}

/// A spoken line, without its audio.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Speech {
    pub id: u64,
    pub duration_ms: u32,
    pub sentences: Vec<Sentence>,
}

/// What text-to-speech needs on disk.
pub struct Setup {
    pub program: PathBuf,
    /// The voice package's folder (the one holding its model file).
    pub dir: PathBuf,
    pub voice: &'static Voice,
    /// How fast it speaks, against the voice's own pace.
    pub speed: f32,
}

/// Reads `text` aloud into WAV bytes, with each sentence's timing.
pub async fn speak(setup: &Setup, text: &str, scratch: &Path) -> Result<(Vec<u8>, Vec<Sentence>, u32)> {
    let shown = split_sentences(&clean(text));
    if shown.is_empty() {
        return Err(AppError::Other("Nothing to say".into()));
    }
    let said: Vec<String> = shown.iter().map(|s| say::say(s)).collect();
    let line = said.join(" ");
    tokio::fs::create_dir_all(scratch).await?;
    let out = scratch.join(format!("speech-{}.wav", crate::config::random_hex(6)));
    let mut cmd = tokio::process::Command::new(&setup.program);
    cmd.args(args(setup, &out, threads()))
        // A lone "--" ends the options: whatever the line says, it's only ever text.
        .arg("--")
        .arg(&line)
        .current_dir(setup.program.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(super::engine::NO_WINDOW);
    let started = std::time::Instant::now();
    let child = cmd.spawn().map_err(|e| AppError::Other(format!("Couldn't start the DJ's voice: {e}")))?;
    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| AppError::Other("The DJ's voice took too long".into()))??;
    let wav = tokio::fs::read(&out).await;
    let _ = tokio::fs::remove_file(&out).await;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let why = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no details");
        return Err(AppError::Other(format!("The DJ's voice failed: {}", why.chars().take(200).collect::<String>())));
    }
    let wav = wav?;
    let info = wav_info(&wav).ok_or_else(|| AppError::Other("The DJ's voice wrote no audio".into()))?;
    let chunks = chunk_samples(&String::from_utf8_lossy(&output.stdout));
    let sentences = timings(&shown, &said, &chunks, info.sample_rate, info.frames);
    log_timing(started.elapsed(), &output, info.duration_ms(), line.chars().count());
    Ok((wav, sentences, info.duration_ms()))
}

/// How long a line took, and how much of that was loading the voice rather than speaking, for tuning.
fn log_timing(took: Duration, output: &std::process::Output, audio_ms: u32, chars: usize) {
    let said = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let total = took.as_secs_f64();
    match speaking_secs(&said) {
        Some(speaking) => log::info!(
            "DJ voice: {:.1} s of speech ({chars} characters) in {total:.1} s: {:.1} s loading, {speaking:.1} s speaking",
            f64::from(audio_ms) / 1000.0,
            (total - speaking).max(0.0),
        ),
        None => log::info!("DJ voice: {:.1} s of speech ({chars} characters) in {total:.1} s", f64::from(audio_ms) / 1000.0),
    }
}

/// The synthesis time the TTS program reports ("Elapsed seconds: 0.296 s"), which leaves out loading the voice.
fn speaking_secs(said: &str) -> Option<f64> {
    let rest = &said[said.find("Elapsed seconds:")? + "Elapsed seconds:".len()..];
    let number: String = rest.trim_start().chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    number.parse().ok()
}

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(1, 4)).unwrap_or(2)
}

fn args(setup: &Setup, out: &Path, threads: usize) -> Vec<std::ffi::OsString> {
    let kind = setup.voice.kind.option();
    let file = |name: &str| setup.dir.join(name).into_os_string();
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    let mut opt = |name: &str, value: std::ffi::OsString| {
        let mut a = std::ffi::OsString::from(format!("--{name}="));
        a.push(value);
        args.push(a);
    };
    opt(&format!("{kind}-model"), file(setup.voice.kind.model_file()));
    opt(&format!("{kind}-voices"), file("voices.bin"));
    opt(&format!("{kind}-tokens"), file("tokens.txt"));
    opt(&format!("{kind}-data-dir"), file("espeak-ng-data"));
    opt("num-threads", threads.to_string().into());
    opt("sid", setup.voice.sid.to_string().into());
    opt(&format!("{kind}-length-scale"), format!("{:.3}", length_scale(setup.speed)).into());
    // One sentence at a time, so each is reported on its own.
    opt("tts-max-num-sentences", "1".into());
    opt("output-filename", out.as_os_str().to_owned());
    args
}

/// The program's length scale for `speed`: how long the speech takes against the voice's own pace. A speed from
/// outside Settings' range (a config edited by hand) is held to it.
fn length_scale(speed: f32) -> f32 {
    let speed = if speed.is_finite() { speed.clamp(SPEED_MIN, SPEED_MAX) } else { 1.0 };
    1.0 / speed
}

/// The line as the voice should get it: one paragraph of plain text, no markup or emoji, never starting
/// with something that looks like an option. A "#" stays only before a number ("#1").
pub fn clean(text: &str) -> String {
    let chars: Vec<char> = text.chars().map(|c| if c.is_whitespace() || c.is_control() { ' ' } else { c }).collect();
    let kept: String = chars
        .iter()
        .enumerate()
        .filter(|(i, c)| {
            c.is_alphanumeric()
                || c.is_whitespace()
                || ".,!?;:'’\"“”()&%$€£/+-–—…".contains(**c)
                || (**c == '#' && chars.get(i + 1).is_some_and(char::is_ascii_digit))
        })
        .map(|(_, c)| *c)
        .collect();
    let mut out = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    out = out.trim_start_matches(|c: char| !c.is_alphanumeric() && c != '"' && c != '“').to_owned();
    if out.chars().count() > MAX_CHARS {
        let cut: String = out.chars().take(MAX_CHARS).collect();
        out = match cut.rfind(['.', '!', '?']) {
            Some(i) if i > MAX_CHARS / 2 => cut[..=i].to_owned(),
            _ => cut.rsplit_once(' ').map_or(cut.clone(), |(head, _)| head.to_owned()),
        };
    }
    out
}

/// Sentences as the voice program reads them: split after . ! or ? followed by a space. Not after an ellipsis, nor
/// after a full stop the sentence goes on after (`say::keeps_going`): before a lowercase word, after an abbreviation,
/// an initial or a dotted acronym.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        current.push(c);
        let ends = matches!(c, '.' | '!' | '?');
        // Closing quotes and brackets stay with their sentence.
        while ends && matches!(chars.peek(), Some('"' | '”' | '’' | '\'' | ')')) {
            current.push(chars.next().unwrap());
        }
        if !ends || !chars.peek().is_none_or(|n| n.is_whitespace()) {
            continue;
        }
        if c == '.' {
            let word = current.rsplit(char::is_whitespace).next().unwrap_or_default();
            let next: String = chars.clone().skip_while(|n| n.is_whitespace()).take_while(|n| !n.is_whitespace()).collect();
            if say::keeps_going(word, &next) {
                continue;
            }
        }
        let s = current.trim();
        if !s.is_empty() {
            out.push(s.to_owned());
        }
        current.clear();
    }
    let s = current.trim();
    if !s.is_empty() {
        out.push(s.to_owned());
    }
    out
}

/// Each sentence's length in samples, from the program's `sample=N, progress=P` lines.
fn chunk_samples(stdout: &str) -> Vec<u64> {
    stdout
        .lines()
        .filter_map(|l| l.trim().strip_prefix("sample=")?.split(',').next()?.trim().parse().ok())
        .collect()
}

/// When each sentence `shown` is spoken, as it was `said`. With one reported length per sentence they're exact;
/// otherwise (the program split differently) the time is shared out by the length of what was said.
fn timings(shown: &[String], said: &[String], chunks: &[u64], sample_rate: u32, frames: u64) -> Vec<Sentence> {
    let ms = |samples: u64| (samples * 1000 / u64::from(sample_rate.max(1))) as u32;
    let total_ms = ms(frames);
    let exact = chunks.len() == shown.len() && chunks.iter().sum::<u64>() <= frames + u64::from(sample_rate);
    let weights: Vec<u64> = if exact {
        chunks.to_vec()
    } else {
        said.iter().map(|s| s.chars().count().max(1) as u64).collect()
    };
    let sum: u64 = weights.iter().sum::<u64>().max(1);
    let mut at = 0u64;
    shown
        .iter()
        .zip(weights)
        .map(|(text, w)| {
            let start = at;
            at += w;
            let (start_ms, end_ms) = if exact {
                (ms(start).min(total_ms), ms(at).min(total_ms))
            } else {
                ((start * u64::from(total_ms) / sum) as u32, (at * u64::from(total_ms) / sum) as u32)
            };
            Sentence { text: text.clone(), start_ms, end_ms }
        })
        .collect()
}

#[derive(Debug, PartialEq)]
struct WavInfo {
    sample_rate: u32,
    frames: u64,
}

impl WavInfo {
    fn duration_ms(&self) -> u32 {
        (self.frames * 1000 / u64::from(self.sample_rate.max(1))) as u32
    }
}

/// A WAV file's format and its sample data.
struct Wav<'a> {
    /// 1 for integer PCM, 3 for float.
    format: u16,
    channels: u16,
    sample_rate: u32,
    bits: u16,
    data: &'a [u8],
}

fn parse_wav(wav: &[u8]) -> Option<Wav<'_>> {
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12;
    let (mut format, mut channels, mut rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    while pos + 8 <= wav.len() {
        let id = &wav[pos..pos + 4];
        let size = u32::from_le_bytes(wav[pos + 4..pos + 8].try_into().ok()?) as usize;
        let body = pos + 8;
        let field = |at: usize| Some(u16::from_le_bytes(wav.get(body + at..body + at + 2)?.try_into().ok()?));
        if id == b"fmt " && size >= 16 && body + 16 <= wav.len() {
            format = field(0)?;
            channels = field(2)?;
            rate = u32::from_le_bytes(wav[body + 4..body + 8].try_into().ok()?);
            bits = field(14)?;
            // WAVE_FORMAT_EXTENSIBLE keeps the real format at the start of its subformat GUID.
            if format == 0xFFFE && size >= 26 {
                format = field(24)?;
            }
        } else if id == b"data" {
            if channels == 0 || rate == 0 || bits < 8 {
                return None;
            }
            let data = &wav[body..body + size.min(wav.len() - body)];
            return Some(Wav { format, channels, sample_rate: rate, bits, data });
        }
        pos = body + size + (size & 1);
    }
    None
}

/// The sample rate and length of a PCM WAV file.
fn wav_info(wav: &[u8]) -> Option<WavInfo> {
    let w = parse_wav(wav)?;
    let frame = usize::from(w.channels) * usize::from(w.bits / 8);
    Some(WavInfo { sample_rate: w.sample_rate, frames: (w.data.len() / frame) as u64 })
}

/// The loudness every line plays at, as RMS over its speech: about the middle of the Kokoro voices, which differ by
/// 6 dB among themselves, and by 10 from the Light ones.
const LEVEL_DBFS: f32 = -23.0;
/// 20 ms stretches quieter than this are pauses, left out of the measure.
const GATE_DBFS: f32 = -50.0;
/// No sample goes over this.
const CEILING_DBFS: f32 = -1.0;
/// Nor is a line made more than this much louder: one that's nearly silent stays so.
const MAX_GAIN_DB: f32 = 12.0;

fn amplitude(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Turns a line up or down to `LEVEL_DBFS`, whichever voice read it, so the DJ sounds as loud with any voice. Its
/// peaks stay under `CEILING_DBFS`.
pub fn level(pcm: &mut Pcm) {
    let frame = (pcm.sample_rate as usize / 50).max(1) * usize::from(pcm.channels.max(1));
    let gate = f64::from(amplitude(GATE_DBFS)).powi(2);
    let (mut sum, mut count) = (0f64, 0usize);
    for chunk in pcm.samples.chunks(frame) {
        let energy: f64 = chunk.iter().map(|s| f64::from(*s).powi(2)).sum();
        if energy / chunk.len() as f64 > gate {
            sum += energy;
            count += chunk.len();
        }
    }
    if count == 0 {
        return;
    }
    let rms = (sum / count as f64).sqrt() as f32;
    let peak = pcm.samples.iter().fold(0f32, |m, s| m.max(s.abs()));
    let gain = (amplitude(LEVEL_DBFS) / rms).min(amplitude(CEILING_DBFS) / peak).min(amplitude(MAX_GAIN_DB));
    for s in &mut pcm.samples {
        *s *= gain;
    }
}

/// A line's audio, ready to play: interleaved samples between -1 and 1.
pub struct Pcm {
    pub channels: u16,
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

/// Decodes a 16-bit or 32-bit float WAV, as the voice program writes.
pub fn pcm(wav: &[u8]) -> Option<Pcm> {
    let w = parse_wav(wav)?;
    let mut samples: Vec<f32> = match (w.format, w.bits) {
        (1, 16) => w.data.chunks_exact(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0).collect(),
        (3, 32) => w.data.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect(),
        _ => return None,
    };
    // Whole frames only.
    samples.truncate(samples.len() - samples.len() % usize::from(w.channels));
    Some(Pcm { channels: w.channels, sample_rate: w.sample_rate, samples })
}

#[cfg(test)]
mod tests {
    use super::super::manifest;
    use super::*;

    #[test]
    fn reads_how_long_the_program_spent_speaking() {
        let said = "sample=1200\nElapsed seconds: 0.296 s\nAudio duration: 4.536 s\nReal-time factor (RTF): 0.296/4.536 = 0.065\n";
        assert_eq!(speaking_secs(said), Some(0.296));
        assert_eq!(speaking_secs("Elapsed seconds:12 s"), Some(12.0));
        assert_eq!(speaking_secs("sample=1200\n"), None);
        assert_eq!(speaking_secs("Elapsed seconds: n/a"), None);
    }

    /// A mono 16-bit WAV of `frames` silent samples.
    fn wav(rate: u32, frames: u32) -> Vec<u8> {
        let data = frames * 2;
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * 2).to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data.to_le_bytes());
        w.resize(w.len() + data as usize, 0);
        w
    }

    /// A WAV with the given format tag and fmt chunk length, around `data`.
    fn wav_with(format: u16, channels: u16, bits: u16, fmt_len: u32, data: &[u8]) -> Vec<u8> {
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(4 + 8 + fmt_len + 8 + data.len() as u32).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&fmt_len.to_le_bytes());
        let tag = if fmt_len >= 40 { 0xFFFEu16 } else { format };
        w.extend_from_slice(&tag.to_le_bytes());
        w.extend_from_slice(&channels.to_le_bytes());
        w.extend_from_slice(&24_000u32.to_le_bytes());
        w.extend_from_slice(&(24_000 * u32::from(channels * bits / 8)).to_le_bytes());
        w.extend_from_slice(&(channels * bits / 8).to_le_bytes());
        w.extend_from_slice(&bits.to_le_bytes());
        if fmt_len >= 40 {
            // cbSize, valid bits, channel mask, then the subformat GUID, whose first two bytes are the format.
            w.extend_from_slice(&22u16.to_le_bytes());
            w.extend_from_slice(&bits.to_le_bytes());
            w.extend_from_slice(&0u32.to_le_bytes());
            w.extend_from_slice(&format.to_le_bytes());
            w.extend_from_slice(&[0u8; 14]);
        }
        w.extend_from_slice(b"data");
        w.extend_from_slice(&(data.len() as u32).to_le_bytes());
        w.extend_from_slice(data);
        w
    }

    #[test]
    fn decodes_16_bit_and_float_audio() {
        let ints: Vec<u8> = [0i16, 16_384, -32_768].iter().flat_map(|v| v.to_le_bytes()).collect();
        let p = pcm(&wav_with(1, 1, 16, 16, &ints)).unwrap();
        assert_eq!((p.channels, p.sample_rate), (1, 24_000));
        assert_eq!(p.samples, vec![0.0, 0.5, -1.0]);

        let floats: Vec<u8> = [0.25f32, -0.75].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(pcm(&wav_with(3, 1, 32, 16, &floats)).unwrap().samples, vec![0.25, -0.75]);
        // The same, in WAVE_FORMAT_EXTENSIBLE's longer header.
        assert_eq!(pcm(&wav_with(3, 1, 32, 40, &floats)).unwrap().samples, vec![0.25, -0.75]);
    }

    #[test]
    fn decodes_whole_frames_only_and_refuses_other_formats() {
        let ints: Vec<u8> = [1i16, 2, 3].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(pcm(&wav_with(1, 2, 16, 16, &ints)).unwrap().samples.len(), 2);
        // 8-bit, and a-law.
        assert!(pcm(&wav_with(1, 1, 8, 16, &[128, 128])).is_none());
        assert!(pcm(&wav_with(6, 1, 8, 16, &[0, 0])).is_none());
        assert!(pcm(&wav_with(1, 0, 16, 16, &ints)).is_none());
        assert!(pcm(b"not a wav file at all").is_none());
    }

    /// The RMS of `samples` over its speech, in dBFS, as `level` measures it at 24 kHz.
    fn speech_dbfs(samples: &[f32]) -> f32 {
        let kept: Vec<f32> =
            samples.chunks(480).filter(|c| c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32 > 1e-5).flatten().copied().collect();
        10.0 * (kept.iter().map(|s| s * s).sum::<f32>() / kept.len() as f32).log10()
    }

    /// A second of a tone at `amp`, then `pause` seconds of silence.
    fn tone(amp: f32, pause: f32) -> Pcm {
        let mut samples: Vec<f32> = (0..24_000).map(|i| (i as f32 * 0.07).sin() * amp).collect();
        samples.resize(samples.len() + (24_000.0 * pause) as usize, 0.0);
        Pcm { channels: 1, sample_rate: 24_000, samples }
    }

    #[test]
    fn brings_every_line_to_one_loudness_leaving_pauses_out() {
        // From 6 dB under the level to 14 over it.
        for (amp, pause) in [(0.05, 0.0), (0.5, 0.0), (0.05, 3.0), (0.3, 1.0)] {
            let mut line = tone(amp, pause);
            level(&mut line);
            let loudness = speech_dbfs(&line.samples);
            assert!((loudness - LEVEL_DBFS).abs() < 0.1, "{amp} {pause}: {loudness}");
            // Pauses stay silent.
            assert!(line.samples[24_000..].iter().all(|s| *s == 0.0));
        }
    }

    #[test]
    fn keeps_peaks_under_the_ceiling_and_a_near_silent_line_quiet() {
        // Quiet, with one click: turning it up to the level would clip.
        let mut clicky = tone(0.01, 0.0);
        clicky.samples[100] = 0.4;
        level(&mut clicky);
        let peak = clicky.samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!((peak - amplitude(CEILING_DBFS)).abs() < 1e-4, "{peak}");
        // Barely there: turned up no more than the most it may be.
        let mut faint = tone(0.006, 0.0);
        level(&mut faint);
        let gained = faint.samples.iter().fold(0f32, |m, s| m.max(s.abs())) / 0.006;
        assert!((gained - amplitude(MAX_GAIN_DB)).abs() < 0.01, "{gained}");
        // Nothing but silence stays as it is.
        let mut silent = tone(0.0, 1.0);
        level(&mut silent);
        assert!(silent.samples.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn reads_wav_length() {
        let info = wav_info(&wav(24_000, 36_000)).unwrap();
        assert_eq!(info, WavInfo { sample_rate: 24_000, frames: 36_000 });
        assert_eq!(info.duration_ms(), 1500);
        assert_eq!(wav_info(b"not a wav file at all"), None);
        assert_eq!(wav_info(&wav(24_000, 10)[..30]), None);
    }

    #[test]
    fn reads_the_sentence_lengths_it_reports() {
        // What sherpa-onnx-offline-tts prints, from a real run.
        let out = "sample=109010, progress=0.500000\nsample=114604, progress=1.000000\n";
        assert_eq!(chunk_samples(out), vec![109_010, 114_604]);
        assert_eq!(chunk_samples("Saved to x.wav successfully!\n"), Vec::<u64>::new());
    }

    #[test]
    fn splits_sentences_where_a_listener_hears_them() {
        assert_eq!(
            split_sentences("That was Midnight City by M83. Up next: a few throwbacks! Ready?"),
            vec!["That was Midnight City by M83.", "Up next: a few throwbacks!", "Ready?"]
        );
        // Decimal points and closing quotes don't end a sentence early.
        assert_eq!(
            split_sentences("Version 2.0 of “Hello.” Then more"),
            vec!["Version 2.0 of “Hello.”", "Then more"]
        );
        assert_eq!(split_sentences("  "), Vec::<String>::new());
    }

    #[test]
    fn splits_sentences_where_the_voice_program_does() {
        // It reads on after an initial, an abbreviation, a dotted acronym, an ellipsis, and before a lowercase word.
        assert_eq!(
            split_sentences("That was Middle Child by J. Cole. Up next, Mr. Brightside feat. nobody. Ready?"),
            vec!["That was Middle Child by J. Cole.", "Up next, Mr. Brightside feat. nobody.", "Ready?"]
        );
        assert_eq!(
            split_sentences("Wait for it… Here it is. Hey... Next song. B.B. King, then U.S.A. songs. Done."),
            vec!["Wait for it… Here it is.", "Hey... Next song.", "B.B. King, then U.S.A. songs.", "Done."]
        );
        assert_eq!(
            split_sentences("That was great. and then more! and more? Yes. The No. 1 song. No. Not now."),
            vec!["That was great. and then more!", "and more?", "Yes.", "The No. 1 song.", "No.", "Not now."]
        );
    }

    #[test]
    fn times_sentences_exactly_when_the_counts_match() {
        let s = vec!["One.".to_owned(), "Two two.".to_owned()];
        let t = timings(&s, &s, &[24_000, 48_000], 24_000, 72_000);
        assert_eq!((t[0].start_ms, t[0].end_ms), (0, 1000));
        assert_eq!((t[1].start_ms, t[1].end_ms), (1000, 3000));
    }

    #[test]
    fn shares_time_out_by_length_when_they_dont() {
        let s = vec!["Aaaa.".to_owned(), "Bbbbbbbbbb.".to_owned()];
        let t = timings(&s, &s, &[72_000], 24_000, 72_000);
        assert_eq!(t[0].start_ms, 0);
        assert_eq!(t[1].end_ms, 3000);
        assert!(t[0].end_ms > 800 && t[0].end_ms < 1100, "{t:?}");
        assert_eq!(t[0].end_ms, t[1].start_ms);
        // By the length of what was said, with what's shown as the captions' text.
        let said = vec!["Aaaaaaaaaaaaaaaaaaaa.".to_owned(), "Bbbbbbbbbb.".to_owned()];
        let t = timings(&s, &said, &[72_000], 24_000, 72_000);
        assert!(t[0].end_ms > 1800 && t[0].end_ms < 2100, "{t:?}");
        assert_eq!((t[0].text.as_str(), t[1].text.as_str()), ("Aaaa.", "Bbbbbbbbbb."));
    }

    #[test]
    fn cleans_lines_for_reading_aloud() {
        assert_eq!(clean("  **Hey!** 🎧 It's   your DJ.\n\nUp next…"), "Hey! It's your DJ. Up next…");
        assert_eq!(clean("--output-filename=/etc/passwd hi"), "output-filename/etc/passwd hi");
        assert_eq!(clean("<b>#1</b> `song`"), "b#1/b song");
        assert_eq!(clean("The #1 song, #tbt ## yes #"), "The #1 song, tbt yes");
        assert_eq!(clean("\"Quoted\" start"), "\"Quoted\" start");
        let long = "Word ".repeat(400);
        assert!(clean(&long).chars().count() <= MAX_CHARS);
    }

    #[test]
    fn loads_the_chosen_voice_and_speaker() {
        let voice = manifest::voice("george").unwrap();
        let setup = Setup { program: "/rt/bin/tts".into(), dir: "/voices/kokoro".into(), voice, speed: 1.0 };
        let args: Vec<String> = args(&setup, Path::new("/tmp/out.wav"), 3)
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect();
        let model = Path::new("/voices/kokoro").join("model.int8.onnx");
        assert!(args.contains(&format!("--kokoro-model={}", model.display())), "{args:?}");
        assert!(args.contains(&"--sid=9".to_owned()));
        assert!(args.contains(&"--num-threads=3".to_owned()));
        assert!(args.contains(&"--output-filename=/tmp/out.wav".to_owned()));
        assert!(args.contains(&"--kokoro-length-scale=1.000".to_owned()), "{args:?}");
        assert!(args.iter().all(|a| a.starts_with("--")), "the text goes after a lone --");
    }

    #[test]
    fn speaks_at_the_speed_picked() {
        let scale = |voice: &str, speed: f32| {
            let setup = Setup { program: "/tts".into(), dir: "/v".into(), voice: manifest::voice(voice).unwrap(), speed };
            args(&setup, Path::new("/out.wav"), 1)
                .into_iter()
                .map(|a| a.into_string().unwrap())
                .find_map(|a| a.split_once("-length-scale=").map(|(kind, v)| format!("{kind} {v}")))
                .unwrap()
        };
        // Faster speech is shorter: the program takes how long it runs.
        assert_eq!(scale("michael", 1.25), "--kokoro 0.800");
        assert_eq!(scale("michael", 0.8), "--kokoro 1.250");
        assert_eq!(scale("light-male", 1.25), "--kitten 0.800");
        // Held to Settings' range, whatever the config says.
        assert_eq!(scale("michael", 3.0), scale("michael", SPEED_MAX));
        assert_eq!(scale("michael", 0.1), scale("michael", SPEED_MIN));
        assert_eq!(scale("michael", f32::NAN), "--kokoro 1.000");
    }
}

