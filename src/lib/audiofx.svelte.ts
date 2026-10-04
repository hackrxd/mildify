// Audio-responsive effects: the embedded player measures what's playing as it's heard
// (`audio-level` events from meter.rs), and elements pulse with it through a CSS variable.
// Music playing on another device can't be measured, so nothing moves then.

import { listen } from "@tauri-apps/api/event";
import { backend, type AudioLevel } from "./ipc";
import { reducedMotion } from "./motion";

const KEY = "nativify:audioFx";

/** The loudest bass lately falls away over about this long, so quiet songs still move. */
const PEAK_DECAY_MS = 4000;
/** Below this the music is silent, not quiet: the pulse doesn't amplify it. */
const PEAK_FLOOR = 0.002;
/** How fast the running average follows the bass; a hit is what rises above it. */
const AVERAGE_MS = 200;
/** A hit is measured against the gap between the average and the peak, but never less than this
 * share of the peak, so small wobbles in steady bass don't count as full hits. */
const MIN_RANGE = 0.2;
const ATTACK_MS = 25;
const RELEASE_MS = 160;
/** Longer frames than this (a hidden window) count as this long. */
const MAX_FRAME_MS = 100;

function approach(from: number, to: number, dtMs: number, timeMs: number): number {
  return to + (from - to) * Math.exp(-dtMs / timeMs);
}

/**
 * Turns bass levels into a pulse from 0 to 1. A hit is how far the bass jumps above its running
 * average, against how far the loudest lately did: a kick reaches 1 even in a dense mix with a
 * bass line under it, at any volume. Sustained bass adds only a little. It rises fast and falls
 * back slower.
 */
export class Pulse {
  value = 0;
  #bass = 0;
  #peak = PEAK_FLOOR;
  #average = 0;

  feed(bass: number) {
    this.#bass = Number.isFinite(bass) ? Math.max(0, bass) : 0;
    this.#peak = Math.max(this.#peak, this.#bass);
  }

  /** Advances by `dtMs`; returns the new value. */
  step(dtMs: number): number {
    const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
    this.#peak = Math.max(PEAK_FLOOR, this.#bass, this.#peak * Math.exp(-dt / PEAK_DECAY_MS));
    this.#average = approach(this.#average, this.#bass, dt, AVERAGE_MS);
    const level = this.#bass / this.#peak;
    const range = Math.max(this.#peak - this.#average, this.#peak * MIN_RANGE);
    const hit = Math.max(0, this.#bass - this.#average) / range;
    const target = Math.min(1, 0.25 * level * level + hit);
    this.value = approach(this.value, target, dt, target > this.value ? ATTACK_MS : RELEASE_MS);
    return this.value;
  }
}

function loadOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

class AudioFx {
  /** The "Audio-responsive Effects" setting. Off unless turned on. */
  on = $state(loadOn());
  #users = 0;

  setOn(on: boolean) {
    this.on = on;
    try {
      if (on) localStorage.setItem(KEY, "true");
      else localStorage.removeItem(KEY);
    } catch {
      // Not persisted; still applies for this session.
    }
  }

  /**
   * Sets `--audio-pulse` (0 to 1) on the element `target` finds, every frame, until the returned
   * function is called. `target` is asked again whenever its element leaves the page. Nothing
   * pulses when the system asks for less motion.
   */
  attach(target: () => HTMLElement | null): () => void {
    if (reducedMotion()) return () => {};
    const pulse = new Pulse();
    const unlisten = listen<AudioLevel>("audio-level", (e) => pulse.feed(e.payload.bass));
    this.#use(1);
    let el: HTMLElement | null = null;
    let shown = -1;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const v = pulse.step(now - last);
      last = now;
      if (!el?.isConnected) {
        el = target();
        shown = -1;
      }
      // Writes only when it visibly changes: a still pulse costs no style work.
      if (el && Math.abs(v - shown) >= 0.002) {
        shown = v < 0.002 ? 0 : v;
        el.style.setProperty("--audio-pulse", shown.toFixed(3));
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      unlisten.then((off) => off());
      el?.style.removeProperty("--audio-pulse");
      this.#use(-1);
    };
  }

  /** The backend measures only while something is pulsing. */
  #use(delta: number) {
    const was = this.#users > 0;
    this.#users += delta;
    const now = this.#users > 0;
    if (now !== was) backend.audioMeter(now).catch(() => {});
  }
}

export const audioFx = new AudioFx();
