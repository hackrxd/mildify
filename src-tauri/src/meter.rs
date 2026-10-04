//! How loud the music is as it comes out of the speakers, for the UI's audio-responsive effects.
//!
//! The sink measures each packet as it queues it and files the reading under the moment the
//! packet starts playing (the output clock in `device.rs` knows). While the window wants them, a
//! task sends the readings that have come due as `audio-level` events, about once a frame.

use std::collections::VecDeque;
use std::f64::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use librespot_playback::{NUM_CHANNELS, SAMPLE_RATE};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// How often due readings go to the window.
const TICK: Duration = Duration::from_millis(16);
/// No reading for this long means nothing is playing; the window gets one silent level.
const SILENCE: Duration = Duration::from_millis(150);
/// The output queue holds well under a second of packets; more means nobody is collecting.
const MAX_READINGS: usize = 256;
/// Where the bass filter rolls off: kick drums and bass lines, not voices.
const BASS_HZ: f64 = 150.0;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Level {
    /// RMS of the whole signal, 0-1, after the volume.
    pub level: f32,
    /// RMS of what's below about 150 Hz.
    pub bass: f32,
}

/// Readings shared between the sink, which files them, and the task that sends them.
#[derive(Clone, Default)]
pub struct Meter(Arc<Shared>);

#[derive(Default)]
struct Shared {
    on: AtomicBool,
    /// Bumped each time it's turned on, so a task from an earlier time exits.
    generation: AtomicU64,
    readings: Mutex<VecDeque<(Instant, Level)>>,
}

impl Meter {
    pub fn is_on(&self) -> bool {
        self.0.on.load(Ordering::Relaxed)
    }

    /// Starts or stops sending `audio-level` events to the main window.
    pub fn set_on(&self, app: &AppHandle, on: bool) {
        if self.0.on.swap(on, Ordering::SeqCst) == on {
            return;
        }
        self.0.readings.lock().unwrap().clear();
        if !on {
            return;
        }
        let generation = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let meter = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(TICK);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut silence = Silence::default();
            while meter.is_on() && meter.0.generation.load(Ordering::SeqCst) == generation {
                tick.tick().await;
                let now = Instant::now();
                if let Some(level) = silence.check(now, meter.due(now)) {
                    let _ = app.emit_to("main", "audio-level", level);
                }
            }
        });
    }

    /// Files a packet's level under when it starts playing.
    pub fn record(&self, at: Instant, level: Level) {
        let mut readings = self.0.readings.lock().unwrap();
        if readings.len() >= MAX_READINGS {
            readings.pop_front();
        }
        readings.push_back((at, level));
    }

    /// The loudest of the readings that have started playing by `now`, which it removes.
    fn due(&self, now: Instant) -> Option<Level> {
        let mut readings = self.0.readings.lock().unwrap();
        let mut loudest: Option<Level> = None;
        while let Some(&(at, level)) = readings.front() {
            if at > now {
                break;
            }
            readings.pop_front();
            let l = loudest.get_or_insert(level);
            l.level = l.level.max(level.level);
            l.bass = l.bass.max(level.bass);
        }
        loudest
    }
}

/// Passes levels through, and one silent level once they stop coming.
#[derive(Default)]
struct Silence {
    last: Option<Instant>,
}

impl Silence {
    fn check(&mut self, now: Instant, due: Option<Level>) -> Option<Level> {
        match due {
            Some(level) => {
                self.last = Some(now);
                Some(level)
            }
            None if self.last.is_some_and(|t| now.duration_since(t) >= SILENCE) => {
                self.last = None;
                Some(Level::default())
            }
            None => None,
        }
    }
}

/// Measures packets. The bass filter's state carries over from one packet to the next.
#[derive(Default)]
pub struct Analyser {
    low: [f64; 2],
}

impl Analyser {
    /// The level of interleaved stereo samples (-1 to 1).
    pub fn measure(&mut self, samples: &[f64]) -> Level {
        // Two one-pole low-passes in a row, so the mids fall away at 12 dB an octave.
        let alpha = 1.0 - (-2.0 * PI * BASS_HZ / f64::from(SAMPLE_RATE)).exp();
        let (mut all, mut bass, mut frames) = (0.0, 0.0, 0usize);
        for frame in samples.chunks_exact(usize::from(NUM_CHANNELS)) {
            let mono = frame.iter().sum::<f64>() / f64::from(NUM_CHANNELS);
            self.low[0] += alpha * (mono - self.low[0]);
            self.low[1] += alpha * (self.low[0] - self.low[1]);
            all += mono * mono;
            bass += self.low[1] * self.low[1];
            frames += 1;
        }
        if frames == 0 {
            return Level::default();
        }
        let rms = |sum: f64| (sum / frames as f64).sqrt() as f32;
        Level { level: rms(all), bass: rms(bass) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stereo sine at `hz`, full scale, `secs` long.
    fn sine(hz: f64, secs: f64) -> Vec<f64> {
        let rate = f64::from(SAMPLE_RATE);
        (0..(rate * secs) as usize)
            .flat_map(|i| {
                let v = (2.0 * PI * hz * i as f64 / rate).sin();
                [v, v]
            })
            .collect()
    }

    /// Steady state: the filter has settled on the first second.
    fn measure_settled(hz: f64) -> Level {
        let mut a = Analyser::default();
        a.measure(&sine(hz, 1.0));
        a.measure(&sine(hz, 0.5))
    }

    fn level(v: f32) -> Level {
        Level { level: v, bass: v }
    }

    #[test]
    fn silence_measures_zero() {
        assert_eq!(Analyser::default().measure(&[0.0; 2048]), Level::default());
        assert_eq!(Analyser::default().measure(&[]), Level::default());
    }

    #[test]
    fn a_low_tone_is_bass() {
        let l = measure_settled(50.0);
        assert!((l.level - 0.707).abs() < 0.01, "{l:?}");
        assert!(l.bass > 0.55, "{l:?}");
    }

    #[test]
    fn a_high_tone_is_not_bass() {
        let l = measure_settled(1000.0);
        assert!((l.level - 0.707).abs() < 0.01, "{l:?}");
        assert!(l.bass < 0.03, "{l:?}");
    }

    #[test]
    fn readings_come_due_when_they_play() {
        let meter = Meter::default();
        let t = Instant::now();
        meter.record(t, level(0.2));
        meter.record(t + Duration::from_millis(10), level(0.5));
        meter.record(t + Duration::from_millis(40), level(0.9));

        assert_eq!(meter.due(t - Duration::from_millis(1)), None);
        // Several due at once: the loudest stands for them.
        assert_eq!(meter.due(t + Duration::from_millis(20)), Some(level(0.5)));
        assert_eq!(meter.due(t + Duration::from_millis(30)), None);
        assert_eq!(meter.due(t + Duration::from_millis(40)), Some(level(0.9)));
    }

    #[test]
    fn readings_nobody_collects_are_capped() {
        let meter = Meter::default();
        let t = Instant::now();
        for _ in 0..MAX_READINGS + 10 {
            meter.record(t, level(0.1));
        }
        assert_eq!(meter.0.readings.lock().unwrap().len(), MAX_READINGS);
    }

    #[test]
    fn silence_is_sent_once_after_the_levels_stop() {
        let mut s = Silence::default();
        let t = Instant::now();
        // Nothing has played yet: nothing to say.
        assert_eq!(s.check(t, None), None);
        assert_eq!(s.check(t, Some(level(0.4))), Some(level(0.4)));
        // A gap between packets isn't silence.
        assert_eq!(s.check(t + Duration::from_millis(30), None), None);
        assert_eq!(s.check(t + SILENCE, None), Some(Level::default()));
        assert_eq!(s.check(t + SILENCE * 2, None), None);
    }
}
