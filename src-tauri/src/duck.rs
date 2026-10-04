//! Turns the music down while the DJ talks, inside the embedded player's output, so the volume slider and
//! other Spotify apps see no change. The sink applies the gain to each packet by when it will be heard (the
//! output clock in `device.rs` knows), so a fade asked for ahead of time lands on time despite the output
//! queue in between.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use librespot_playback::{NUM_CHANNELS, SAMPLE_RATE};

/// A duck nobody lifts (the window reloaded mid-sentence, say) lifts itself after this long.
const MAX_HOLD: Duration = Duration::from_secs(90);
/// How long that lifting takes.
const RELEASE: Duration = Duration::from_millis(1500);

#[derive(Clone)]
pub struct Duck(Arc<Mutex<Envelope>>);

impl Default for Duck {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Envelope::full(Instant::now()))))
    }
}

/// A move from one gain to another, starting at a point in heard time.
#[derive(Debug, Clone, Copy)]
struct Envelope {
    from: f32,
    to: f32,
    start: Instant,
    ramp: Duration,
    /// When a duck lifts itself, if nobody lifts it first.
    release: Option<Instant>,
}

impl Envelope {
    fn full(now: Instant) -> Self {
        Self { from: 1.0, to: 1.0, start: now, ramp: Duration::ZERO, release: None }
    }

    fn gain(&self, t: Instant) -> f32 {
        if let Some(release) = self.release.filter(|r| t >= *r) {
            let x = t.duration_since(release).as_secs_f32() / RELEASE.as_secs_f32();
            return lerp(self.to, 1.0, ease(x));
        }
        if t < self.start {
            return self.from;
        }
        let x = if self.ramp.is_zero() {
            1.0
        } else {
            t.duration_since(self.start).as_secs_f32() / self.ramp.as_secs_f32()
        };
        lerp(self.from, self.to, ease(x))
    }
}

/// Exact at both ends, so a lifted duck is exactly full volume and costs nothing.
fn lerp(a: f32, b: f32, x: f32) -> f32 {
    if x <= 0.0 {
        a
    } else if x >= 1.0 {
        b
    } else {
        a + (b - a) * x
    }
}

/// Smoothstep: fades start and end gently, without the click of a corner.
fn ease(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

impl Duck {
    /// Moves the music's gain to `level` (0-1) over `ramp`, starting `delay` from now in heard time.
    pub fn set(&self, level: f32, delay: Duration, ramp: Duration) {
        self.set_at(Instant::now(), level, delay, ramp);
    }

    fn set_at(&self, now: Instant, level: f32, delay: Duration, ramp: Duration) {
        let level = if level.is_finite() { level.clamp(0.0, 1.0) } else { 1.0 };
        let start = now + delay;
        let mut e = self.0.lock().unwrap();
        // Carry on from wherever the old envelope would be by then, so changing course never jumps.
        let from = e.gain(start);
        *e = Envelope { from, to: level, start, ramp, release: (level < 1.0).then(|| start + ramp + MAX_HOLD) };
    }

    /// Applies the gain to interleaved samples that start playing at `starts`.
    pub fn apply(&self, starts: Instant, samples: &mut [f64]) {
        let channels = usize::from(NUM_CHANNELS);
        let frames = samples.len() / channels;
        if frames == 0 {
            return;
        }
        let ends = starts + Duration::from_secs_f64(frames as f64 / f64::from(SAMPLE_RATE));
        let (g0, g1) = {
            let e = self.0.lock().unwrap();
            (e.gain(starts), e.gain(ends))
        };
        if g0 == 1.0 && g1 == 1.0 {
            return;
        }
        // Packets are tens of milliseconds long; a straight line across one is smooth enough.
        for (i, frame) in samples.chunks_exact_mut(channels).enumerate() {
            let g = f64::from(lerp(g0, g1, i as f32 / frames as f32));
            for s in frame {
                *s *= g;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn gain(d: &Duck, t: Instant) -> f32 {
        d.0.lock().unwrap().gain(t)
    }

    #[test]
    fn leaves_the_music_alone_until_asked() {
        let d = Duck::default();
        let mut samples = vec![0.5; 2048];
        d.apply(Instant::now(), &mut samples);
        assert!(samples.iter().all(|s| *s == 0.5));
    }

    #[test]
    fn fades_down_from_when_its_asked_to_start() {
        let d = Duck::default();
        let t = Instant::now();
        d.set_at(t, 0.2, ms(500), ms(400));
        assert_eq!(gain(&d, t + ms(400)), 1.0, "audio heard before the start isn't touched");
        assert!((gain(&d, t + ms(700)) - 0.6).abs() < 0.01, "halfway down");
        assert_eq!(gain(&d, t + ms(900)), 0.2);
        assert_eq!(gain(&d, t + ms(5_000)), 0.2);
    }

    #[test]
    fn a_new_fade_starts_where_the_old_one_had_got_to() {
        let d = Duck::default();
        let t = Instant::now();
        d.set_at(t, 0.0, ms(0), ms(1000));
        // Halfway down, turn around.
        d.set_at(t + ms(500), 1.0, ms(0), ms(1000));
        assert!((gain(&d, t + ms(500)) - 0.5).abs() < 0.01);
        assert_eq!(gain(&d, t + ms(1500)), 1.0);
    }

    #[test]
    fn a_forgotten_duck_lifts_itself() {
        let d = Duck::default();
        let t = Instant::now();
        d.set_at(t, 0.1, ms(0), ms(100));
        let lifts = t + ms(100) + MAX_HOLD;
        assert_eq!(gain(&d, lifts - ms(1)), 0.1);
        assert_eq!(gain(&d, lifts + RELEASE), 1.0);
        // Lifting it on purpose clears the timer.
        d.set_at(t, 1.0, ms(0), ms(0));
        assert!(d.0.lock().unwrap().release.is_none());
    }

    #[test]
    fn scales_each_packet_along_the_fade() {
        let d = Duck::default();
        let t = Instant::now();
        d.set_at(t, 0.0, ms(0), ms(0));
        let mut samples = vec![1.0; 4096];
        d.apply(t + ms(10), &mut samples);
        assert!(samples.iter().all(|s| *s == 0.0));

        d.set_at(t, 1.0, ms(0), ms(2000));
        let mut samples = vec![1.0; 4096];
        d.apply(t + ms(1000), &mut samples);
        // Rising through the packet, both channels of a frame alike.
        assert!(samples[0] > 0.4 && samples[0] < 0.6, "{}", samples[0]);
        assert!(samples[4094] > samples[0]);
        assert_eq!(samples[0], samples[1]);
    }

    #[test]
    fn nonsense_levels_mean_full_volume() {
        let d = Duck::default();
        let t = Instant::now();
        d.set_at(t, f32::NAN, ms(0), ms(0));
        assert_eq!(gain(&d, t + ms(1)), 1.0);
        d.set_at(t, 7.0, ms(0), ms(0));
        assert_eq!(gain(&d, t + ms(1)), 1.0);
        d.set_at(t, -1.0, ms(0), ms(0));
        assert_eq!(gain(&d, t + ms(1)), 0.0);
    }
}
