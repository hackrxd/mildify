//! The DJ's voice: sherpa-onnx's offline text-to-speech program reads a line into a WAV file. It reports
//! each sentence's length as it goes, which times the captions sentence by sentence.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use super::manifest::Voice;
use crate::error::{AppError, Result};

/// Anything longer isn't a DJ line.
const MAX_CHARS: usize = 800;
/// Reading a long line with the bigger voice on a slow CPU.
const TIMEOUT: Duration = Duration::from_secs(120);

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
}

/// Reads `text` aloud into WAV bytes, with each sentence's timing.
pub async fn speak(setup: &Setup, text: &str, scratch: &Path) -> Result<(Vec<u8>, Vec<Sentence>, u32)> {
    let text = clean(text);
    if text.is_empty() {
        return Err(AppError::Other("Nothing to say".into()));
    }
    tokio::fs::create_dir_all(scratch).await?;
    let out = scratch.join(format!("speech-{}.wav", crate::config::random_hex(6)));
    let mut cmd = tokio::process::Command::new(&setup.program);
    cmd.args(args(setup, &out, threads()))
        // A lone "--" ends the options: whatever the line says, it's only ever text.
        .arg("--")
        .arg(&text)
        .current_dir(setup.program.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(super::engine::NO_WINDOW);
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
    let sentences = timings(&split_sentences(&text), &chunks, info.sample_rate, info.frames);
    Ok((wav, sentences, info.duration_ms()))
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
    // One sentence at a time, so each is reported on its own.
    opt("tts-max-num-sentences", "1".into());
    opt("output-filename", out.as_os_str().to_owned());
    args
}

/// The line as the voice should get it: one paragraph of plain text, no markup or emoji, never starting
/// with something that looks like an option.
pub fn clean(text: &str) -> String {
    let kept: String = text
        .chars()
        .map(|c| if c.is_whitespace() || c.is_control() { ' ' } else { c })
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || ".,!?;:'’\"“”()&%$€£/+-–—…".contains(*c))
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

/// Sentences as a reader would hear them: split after . ! ? or … followed by a space.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        current.push(c);
        let ends = matches!(c, '.' | '!' | '?' | '…');
        // Closing quotes and brackets stay with their sentence.
        while ends && matches!(chars.peek(), Some('"' | '”' | '’' | '\'' | ')')) {
            current.push(chars.next().unwrap());
        }
        if ends && chars.peek().is_none_or(|n| n.is_whitespace()) {
            let s = current.trim();
            if !s.is_empty() {
                out.push(s.to_owned());
            }
            current.clear();
        }
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

/// When each sentence is spoken. With one reported length per sentence they're exact; otherwise (the
/// program split differently) the time is shared out by length of text.
fn timings(sentences: &[String], chunks: &[u64], sample_rate: u32, frames: u64) -> Vec<Sentence> {
    let ms = |samples: u64| (samples * 1000 / u64::from(sample_rate.max(1))) as u32;
    let total_ms = ms(frames);
    let exact = chunks.len() == sentences.len() && chunks.iter().sum::<u64>() <= frames + u64::from(sample_rate);
    let weights: Vec<u64> = if exact {
        chunks.to_vec()
    } else {
        sentences.iter().map(|s| s.chars().count().max(1) as u64).collect()
    };
    let sum: u64 = weights.iter().sum::<u64>().max(1);
    let mut at = 0u64;
    sentences
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

/// The sample rate and length of a PCM WAV file.
fn wav_info(wav: &[u8]) -> Option<WavInfo> {
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12;
    let (mut channels, mut rate, mut bits) = (0u16, 0u32, 0u16);
    while pos + 8 <= wav.len() {
        let id = &wav[pos..pos + 4];
        let size = u32::from_le_bytes(wav[pos + 4..pos + 8].try_into().ok()?) as usize;
        let body = pos + 8;
        if id == b"fmt " && size >= 16 && body + 16 <= wav.len() {
            channels = u16::from_le_bytes(wav[body + 2..body + 4].try_into().ok()?);
            rate = u32::from_le_bytes(wav[body + 4..body + 8].try_into().ok()?);
            bits = u16::from_le_bytes(wav[body + 14..body + 16].try_into().ok()?);
        } else if id == b"data" {
            let frame = usize::from(channels) * usize::from(bits / 8);
            if frame == 0 || rate == 0 {
                return None;
            }
            let len = size.min(wav.len() - body);
            return Some(WavInfo { sample_rate: rate, frames: (len / frame) as u64 });
        }
        pos = body + size + (size & 1);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::manifest;
    use super::*;

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
    fn times_sentences_exactly_when_the_counts_match() {
        let s = vec!["One.".to_owned(), "Two two.".to_owned()];
        let t = timings(&s, &[24_000, 48_000], 24_000, 72_000);
        assert_eq!((t[0].start_ms, t[0].end_ms), (0, 1000));
        assert_eq!((t[1].start_ms, t[1].end_ms), (1000, 3000));
    }

    #[test]
    fn shares_time_out_by_length_when_they_dont() {
        let s = vec!["Aaaa.".to_owned(), "Bbbbbbbbbb.".to_owned()];
        let t = timings(&s, &[72_000], 24_000, 72_000);
        assert_eq!(t[0].start_ms, 0);
        assert_eq!(t[1].end_ms, 3000);
        assert!(t[0].end_ms > 800 && t[0].end_ms < 1100, "{t:?}");
        assert_eq!(t[0].end_ms, t[1].start_ms);
    }

    #[test]
    fn cleans_lines_for_reading_aloud() {
        assert_eq!(clean("  **Hey!** 🎧 It's   your DJ.\n\nUp next…"), "Hey! It's your DJ. Up next…");
        assert_eq!(clean("--output-filename=/etc/passwd hi"), "output-filename/etc/passwd hi");
        assert_eq!(clean("<b>#1</b> `song`"), "b1/b song");
        assert_eq!(clean("\"Quoted\" start"), "\"Quoted\" start");
        let long = "Word ".repeat(400);
        assert!(clean(&long).chars().count() <= MAX_CHARS);
    }

    #[test]
    fn loads_the_chosen_voice_and_speaker() {
        let voice = manifest::voice("george").unwrap();
        let setup = Setup { program: "/rt/bin/tts".into(), dir: "/voices/kokoro".into(), voice };
        let args: Vec<String> = args(&setup, Path::new("/tmp/out.wav"), 3)
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect();
        let model = Path::new("/voices/kokoro").join("model.int8.onnx");
        assert!(args.contains(&format!("--kokoro-model={}", model.display())), "{args:?}");
        assert!(args.contains(&"--sid=9".to_owned()));
        assert!(args.contains(&"--num-threads=3".to_owned()));
        assert!(args.contains(&"--output-filename=/tmp/out.wav".to_owned()));
        assert!(args.iter().all(|a| a.starts_with("--")), "the text goes after a lone --");
    }
}
