//! Plays the DJ's lines on this computer's default audio output, as the music plays, through rodio. The web
//! view's own audio can't be relied on for it: WebKitGTK decodes and plays sound through GStreamer, which often
//! lacks the plugins for a WAV file (`gst-plugins-good`), and the DJ would say nothing.
//!
//! A thread of its own holds the output (a stream can't move between threads on every platform) and takes
//! commands. It reports where the line is, a few times a second, and when it ends.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rodio::buffer::SamplesBuffer;
use rodio::{OutputStream, OutputStreamBuilder, Sink};
use serde::{Deserialize, Serialize};

use super::voice::Pcm;

/// How often the line's position is reported while it plays.
const REPORT_EVERY: Duration = Duration::from_millis(250);
/// How soon the end of a line is noticed.
const POLL: Duration = Duration::from_millis(20);
const IDLE_POLL: Duration = Duration::from_secs(1);
/// The output is let go after this long without a line, so the DJ doesn't keep the audio device open.
const IDLE_CLOSE: Duration = Duration::from_secs(120);
/// A line that hasn't moved on for this long isn't being played: the output died (a device unplugged with no
/// sound server to move the stream). Longer than a sound server can take to start a new stream.
const STALL: Duration = Duration::from_secs(4);

/// What the UI asks of the voice.
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum VoiceCommand {
    /// Plays a line `speak` made, at `gain` (0-1), in place of any line playing.
    Play { id: u64, gain: f32 },
    Pause,
    Resume,
    Gain { gain: f32 },
    Stop,
}

/// What the voice tells the UI, as `dj-voice` events.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum VoiceEvent {
    /// The line is playing, this far in: as it starts or resumes, then a few times a second.
    Playing { id: u64, position_ms: u32 },
    Ended { id: u64 },
    /// It couldn't be played: no audio output, say.
    Failed { id: u64, error: String },
}

pub type Report = Arc<dyn Fn(VoiceEvent) + Send + Sync>;

pub enum Cmd {
    Play { id: u64, pcm: Pcm, gain: f32 },
    Pause,
    Resume,
    Gain(f32),
    Stop,
    /// Stops, and lets go of the output.
    Close,
}

/// Where lines play: the default audio output in the app, a fake in tests.
trait Output {
    fn play(&mut self, pcm: Pcm, gain: f32);
    fn pause(&mut self);
    fn resume(&mut self);
    fn set_gain(&mut self, gain: f32);
    fn stop(&mut self);
    /// How far into the line it is.
    fn position(&self) -> Duration;
    /// The line has played to its end.
    fn finished(&self) -> bool;
}

struct Rodio {
    stream: OutputStream,
    sink: Option<Sink>,
}

impl Rodio {
    fn open() -> Result<Box<dyn Output>, String> {
        let mut stream = OutputStreamBuilder::open_default_stream().map_err(|e| e.to_string())?;
        stream.log_on_drop(false);
        Ok(Box::new(Self { stream, sink: None }))
    }
}

impl Output for Rodio {
    fn play(&mut self, pcm: Pcm, gain: f32) {
        self.stop();
        let sink = Sink::connect_new(self.stream.mixer());
        sink.set_volume(gain);
        sink.append(SamplesBuffer::new(pcm.channels, pcm.sample_rate, pcm.samples));
        self.sink = Some(sink);
    }
    fn pause(&mut self) {
        if let Some(s) = &self.sink {
            s.pause();
        }
    }
    fn resume(&mut self) {
        if let Some(s) = &self.sink {
            s.play();
        }
    }
    fn set_gain(&mut self, gain: f32) {
        if let Some(s) = &self.sink {
            s.set_volume(gain);
        }
    }
    fn stop(&mut self) {
        if let Some(s) = self.sink.take() {
            s.stop();
        }
    }
    fn position(&self) -> Duration {
        self.sink.as_ref().map_or(Duration::ZERO, Sink::get_pos)
    }
    fn finished(&self) -> bool {
        self.sink.as_ref().is_none_or(Sink::empty)
    }
}

/// The voice's thread, started with the first line.
#[derive(Default)]
pub struct Speaker {
    tx: Mutex<Option<Sender<Cmd>>>,
}

impl Speaker {
    /// Passes `cmd` to the voice's thread, starting it for a line if it isn't running.
    pub fn send(&self, cmd: Cmd, report: impl FnOnce() -> Report) {
        let mut tx = self.tx.lock().unwrap();
        let cmd = match tx.as_ref() {
            Some(t) => match t.send(cmd) {
                Ok(()) => return,
                // The thread is gone: a line starts it again.
                Err(mpsc::SendError(cmd)) => cmd,
            },
            None => cmd,
        };
        // Nothing to pause or stop without one.
        if !matches!(cmd, Cmd::Play { .. }) {
            return;
        }
        let (send, recv) = mpsc::channel();
        let report = report();
        let spawned = std::thread::Builder::new()
            .name("dj-voice".into())
            .spawn(move || run(recv, Rodio::open, move |e| report(e), IDLE_CLOSE, STALL));
        match spawned {
            Ok(_) => {
                let _ = send.send(cmd);
                *tx = Some(send);
            }
            Err(e) => log::warn!("DJ: couldn't start the voice's thread: {e}"),
        }
    }

    /// Stops the line and lets go of the audio output.
    pub fn close(&self) {
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(Cmd::Close);
        }
    }
}

/// The line playing, or paused.
struct Line {
    id: u64,
    paused: bool,
    reported: Instant,
    /// Where it was when it last moved on, and when.
    at: Duration,
    moved: Instant,
}

impl Line {
    fn new(id: u64) -> Self {
        let now = Instant::now();
        Self { id, paused: false, reported: now, at: Duration::ZERO, moved: now }
    }
}

fn ms(d: Duration) -> u32 {
    d.as_millis().min(u128::from(u32::MAX)) as u32
}

/// The voice's thread: takes commands until the speaker goes away.
fn run(
    rx: Receiver<Cmd>,
    open: impl Fn() -> Result<Box<dyn Output>, String>,
    report: impl Fn(VoiceEvent),
    idle_close: Duration,
    stall: Duration,
) {
    let mut out: Option<Box<dyn Output>> = None;
    let mut line: Option<Line> = None;
    let mut idle_since = Instant::now();
    loop {
        let wait = if line.as_ref().is_some_and(|l| !l.paused) { POLL } else { IDLE_POLL.min(idle_close) };
        match rx.recv_timeout(wait) {
            Ok(Cmd::Play { id, pcm, gain }) => {
                if out.is_none() {
                    match open() {
                        Ok(o) => out = Some(o),
                        Err(error) => {
                            log::warn!("DJ: no audio output for the voice: {error}");
                            report(VoiceEvent::Failed { id, error });
                            continue;
                        }
                    }
                }
                if let Some(o) = out.as_mut() {
                    // A line in its place just stops: it doesn't end.
                    o.play(pcm, gain);
                    report(VoiceEvent::Playing { id, position_ms: 0 });
                    line = Some(Line::new(id));
                }
            }
            Ok(Cmd::Pause) => {
                if let (Some(l), Some(o)) = (line.as_mut(), out.as_mut()) {
                    o.pause();
                    l.paused = true;
                }
            }
            Ok(Cmd::Resume) => {
                if let (Some(l), Some(o)) = (line.as_mut(), out.as_mut()) {
                    o.resume();
                    l.paused = false;
                    l.reported = Instant::now();
                    l.moved = Instant::now();
                    report(VoiceEvent::Playing { id: l.id, position_ms: ms(o.position()) });
                }
            }
            Ok(Cmd::Gain(gain)) => {
                if let Some(o) = out.as_mut() {
                    o.set_gain(gain);
                }
            }
            Ok(Cmd::Stop) => {
                if let Some(o) = out.as_mut() {
                    o.stop();
                }
                line = None;
                idle_since = Instant::now();
            }
            Ok(Cmd::Close) => {
                // A line cut off here still ends, for whoever is waiting on it.
                if let Some(l) = line.take() {
                    report(VoiceEvent::Ended { id: l.id });
                }
                out = None;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let Some(o) = out.as_ref() else { continue };
        if let Some(l) = line.as_mut().filter(|l| !l.paused) {
            let at = o.position();
            if at != l.at {
                l.at = at;
                l.moved = Instant::now();
            } else if !o.finished() && l.moved.elapsed() >= stall {
                log::warn!("DJ: the voice's output stopped playing");
                report(VoiceEvent::Failed { id: l.id, error: "The sound output stopped playing.".into() });
                // Opened anew for the next line, on whatever output is the default by then.
                out = None;
                line = None;
                continue;
            }
        }
        match line.as_mut() {
            Some(l) if !l.paused && o.finished() => {
                report(VoiceEvent::Ended { id: l.id });
                line = None;
                idle_since = Instant::now();
            }
            Some(l) if !l.paused && l.reported.elapsed() >= REPORT_EVERY => {
                l.reported = Instant::now();
                report(VoiceEvent::Playing { id: l.id, position_ms: ms(o.position()) });
            }
            Some(_) => {}
            None if idle_since.elapsed() >= idle_close => out = None,
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a fake output was told, and what it says back.
    #[derive(Default)]
    struct Fake {
        log: Vec<String>,
        position: Duration,
        finished: bool,
        open: bool,
    }

    struct FakeOutput(Arc<Mutex<Fake>>);

    impl Output for FakeOutput {
        fn play(&mut self, pcm: Pcm, gain: f32) {
            let mut f = self.0.lock().unwrap();
            f.log.push(format!("play {} at {gain}", pcm.samples.len()));
            f.finished = false;
        }
        fn pause(&mut self) {
            self.0.lock().unwrap().log.push("pause".into());
        }
        fn resume(&mut self) {
            self.0.lock().unwrap().log.push("resume".into());
        }
        fn set_gain(&mut self, gain: f32) {
            self.0.lock().unwrap().log.push(format!("gain {gain}"));
        }
        fn stop(&mut self) {
            self.0.lock().unwrap().log.push("stop".into());
        }
        fn position(&self) -> Duration {
            self.0.lock().unwrap().position
        }
        fn finished(&self) -> bool {
            self.0.lock().unwrap().finished
        }
    }

    impl Drop for FakeOutput {
        fn drop(&mut self) {
            self.0.lock().unwrap().open = false;
        }
    }

    struct Harness {
        tx: Sender<Cmd>,
        events: Receiver<VoiceEvent>,
        fake: Arc<Mutex<Fake>>,
    }

    fn harness(fails: bool, idle_close: Duration) -> Harness {
        harness_with(fails, idle_close, STALL)
    }

    fn harness_with(fails: bool, idle_close: Duration, stall: Duration) -> Harness {
        let (tx, rx) = mpsc::channel();
        let (etx, events) = mpsc::channel();
        let fake = Arc::new(Mutex::new(Fake::default()));
        let shared = fake.clone();
        let open = move || -> Result<Box<dyn Output>, String> {
            if fails {
                return Err("no output device".into());
            }
            shared.lock().unwrap().open = true;
            Ok(Box::new(FakeOutput(shared.clone())))
        };
        std::thread::spawn(move || run(rx, open, move |e| etx.send(e).unwrap(), idle_close, stall));
        Harness { tx, events, fake }
    }

    fn line(id: u64) -> Cmd {
        Cmd::Play { id, pcm: Pcm { channels: 1, sample_rate: 24_000, samples: vec![0.0; 240] }, gain: 0.5 }
    }

    impl Harness {
        fn next(&self) -> VoiceEvent {
            self.events.recv_timeout(Duration::from_secs(2)).expect("an event")
        }
        fn quiet(&self, ms: u64) -> bool {
            self.events.recv_timeout(Duration::from_millis(ms)).is_err()
        }
        /// Waits for the thread to have passed `what` on to the output.
        fn told(&self, what: &str) {
            let until = Instant::now() + Duration::from_secs(2);
            while !self.fake.lock().unwrap().log.iter().any(|l| l == what) {
                assert!(Instant::now() < until, "never told the output {what}");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    #[test]
    fn plays_a_line_reports_where_it_is_and_when_it_ends() {
        let h = harness(false, IDLE_CLOSE);
        h.tx.send(line(1)).unwrap();
        assert_eq!(h.next(), VoiceEvent::Playing { id: 1, position_ms: 0 });
        h.fake.lock().unwrap().position = Duration::from_millis(300);
        assert_eq!(h.next(), VoiceEvent::Playing { id: 1, position_ms: 300 });
        h.fake.lock().unwrap().finished = true;
        assert_eq!(h.next(), VoiceEvent::Ended { id: 1 });
        assert!(h.quiet(100));
        assert_eq!(h.fake.lock().unwrap().log, vec!["play 240 at 0.5"]);
    }

    #[test]
    fn says_so_when_there_is_no_output() {
        let h = harness(true, IDLE_CLOSE);
        h.tx.send(line(4)).unwrap();
        assert_eq!(h.next(), VoiceEvent::Failed { id: 4, error: "no output device".into() });
    }

    #[test]
    fn a_paused_line_stays_put_and_picks_up_where_it_was() {
        let h = harness(false, IDLE_CLOSE);
        h.tx.send(line(1)).unwrap();
        h.next();
        h.tx.send(Cmd::Pause).unwrap();
        h.told("pause");
        h.fake.lock().unwrap().position = Duration::from_millis(120);
        // No reports while paused, and no end even if the output says it's done.
        h.fake.lock().unwrap().finished = true;
        assert!(h.quiet(400));
        h.fake.lock().unwrap().finished = false;
        h.tx.send(Cmd::Resume).unwrap();
        assert_eq!(h.next(), VoiceEvent::Playing { id: 1, position_ms: 120 });
        h.tx.send(Cmd::Gain(0.25)).unwrap();
        h.tx.send(Cmd::Stop).unwrap();
        assert!(h.quiet(100));
        assert_eq!(h.fake.lock().unwrap().log, vec!["play 240 at 0.5", "pause", "resume", "gain 0.25", "stop"]);
    }

    #[test]
    fn a_new_line_replaces_the_one_playing_without_ending_it() {
        let h = harness(false, IDLE_CLOSE);
        h.tx.send(line(1)).unwrap();
        h.next();
        h.tx.send(line(2)).unwrap();
        assert_eq!(h.next(), VoiceEvent::Playing { id: 2, position_ms: 0 });
        h.fake.lock().unwrap().finished = true;
        assert_eq!(h.next(), VoiceEvent::Ended { id: 2 });
    }

    /// Needs an audio output that plays in real time; run with `--ignored` where there is one (a PulseAudio
    /// null sink will do; ALSA's null device takes the audio as fast as it's given).
    #[test]
    #[ignore]
    fn plays_through_the_default_output() {
        let (tx, rx) = mpsc::channel();
        let (etx, events) = mpsc::channel();
        std::thread::spawn(move || run(rx, Rodio::open, move |e| etx.send(e).unwrap(), IDLE_CLOSE, STALL));
        let samples = (0..24_000 * 6 / 10).map(|i| (i as f32 * 0.05).sin() * 0.1).collect();
        tx.send(Cmd::Play { id: 9, pcm: Pcm { channels: 1, sample_rate: 24_000, samples }, gain: 0.5 }).unwrap();
        let started = Instant::now();
        let mut last = 0;
        loop {
            match events.recv_timeout(Duration::from_secs(4)).expect("an event") {
                VoiceEvent::Playing { id: 9, position_ms } => last = position_ms,
                VoiceEvent::Ended { id: 9 } => break,
                other => panic!("{other:?}"),
            }
        }
        let took = started.elapsed();
        // A sound server can take a moment to start a new stream.
        assert!(took >= Duration::from_millis(550) && took < Duration::from_secs(3), "{took:?}");
        assert!(last >= 200, "reported {last} ms in");
    }

    #[test]
    fn gives_up_on_an_output_that_stopped_playing() {
        let h = harness_with(false, IDLE_CLOSE, Duration::from_millis(300));
        h.tx.send(line(1)).unwrap();
        h.next();
        h.fake.lock().unwrap().position = Duration::from_millis(100);
        // Stuck there: no end, no more progress.
        let failed = loop {
            match h.next() {
                VoiceEvent::Playing { .. } => continue,
                other => break other,
            }
        };
        assert_eq!(failed, VoiceEvent::Failed { id: 1, error: "The sound output stopped playing.".into() });
        assert!(!h.fake.lock().unwrap().open);
        // A paused line stands still on purpose.
        h.tx.send(line(2)).unwrap();
        h.next();
        h.fake.lock().unwrap().position = Duration::from_millis(50);
        h.tx.send(Cmd::Pause).unwrap();
        h.told("pause");
        assert!(h.quiet(600));
    }

    #[test]
    fn a_line_cut_off_by_closing_still_ends() {
        let h = harness(false, IDLE_CLOSE);
        h.tx.send(line(3)).unwrap();
        h.next();
        h.tx.send(Cmd::Close).unwrap();
        assert_eq!(h.next(), VoiceEvent::Ended { id: 3 });
    }

    #[test]
    fn lets_go_of_the_output_when_idle_or_closed() {
        let h = harness(false, Duration::from_millis(150));
        h.tx.send(line(1)).unwrap();
        h.next();
        h.fake.lock().unwrap().finished = true;
        h.next();
        assert!(h.fake.lock().unwrap().open);
        std::thread::sleep(Duration::from_millis(500));
        assert!(!h.fake.lock().unwrap().open);
        // Opened again for the next line, and closed on request.
        h.tx.send(line(2)).unwrap();
        h.next();
        assert!(h.fake.lock().unwrap().open);
        h.tx.send(Cmd::Close).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(!h.fake.lock().unwrap().open);
    }
}
