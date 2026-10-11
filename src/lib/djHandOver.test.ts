import { describe, expect, it, vi } from "vitest";
import { cue, HandOver, runCues, type Cue } from "./djHandOver";
import { Mixer } from "./djMixer";

describe("runCues", () => {
  /** Runs `cues` at `now`, with timers kept to run by hand; every cue wanted unless said. */
  function run(cues: Cue[], now: number, clock = () => now, wanted = (_c: Cue) => true) {
    const timers: [number, () => void][] = [];
    runCues(cues, now, clock, 400, wanted, (ms, fn) => void timers.push([ms, fn]));
    return timers;
  }

  it("fires the cues that are due, once", () => {
    const fired: string[] = [];
    const cues = [cue(1000, () => fired.push("a")), cue(997, () => fired.push("b")), cue(2000, () => fired.push("c"))];
    // Within 5 ms of its time, a cue is due.
    run(cues, 994);
    expect(fired).toEqual(["b"]);
    run(cues, 1000);
    run(cues, 1000);
    expect(fired).toEqual(["b", "a"]);
  });

  it("arms a timer for a cue due before the clock is looked at again, and only once", () => {
    const fire = vi.fn();
    const cues = [cue(1300, fire), cue(1500, () => {})];
    const timers = run(cues, 1000);
    expect(timers.map(([ms]) => ms)).toEqual([300]);
    expect(run(cues, 1100)).toEqual([]);
    timers[0][1]();
    expect(fire).not.toHaveBeenCalled();
    // The timer comes due with its clock there.
    const later = run([cue(1300, fire)], 1000, () => 1300);
    later[0][1]();
    expect(fire).toHaveBeenCalledOnce();
  });

  it("doesn't fire an armed cue whose clock stopped short, and arms it again", () => {
    const fire = vi.fn();
    const cues = [cue(1300, fire)];
    const [[, due]] = run(cues, 1000, () => 1100);
    due();
    expect(fire).not.toHaveBeenCalled();
    expect(cues[0].armed).toBe(false);
    expect(run(cues, 1100)).toHaveLength(1);
  });

  it("doesn't fire a cue dropped since it was armed", () => {
    const fire = vi.fn();
    let wanted = true;
    const [[, due]] = run([cue(1300, fire)], 1000, () => 1300, () => wanted);
    wanted = false;
    due();
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("HandOver", () => {
  function handOver() {
    const sent: number[][] = [];
    const host = { t: 0, pos: 190_000 };
    const mixer = new Mixer({
      gain: (...a) => void sent.push(a),
      now: () => host.t,
      track: () => "a",
      position: () => host.pos,
      speaking: () => false,
    });
    return { h: new HandOver<string>(mixer), mixer, sent };
  }

  it("is planned on a song, with its cues and the next song's hold", () => {
    const { h } = handOver();
    expect(h.on).toBeNull();
    const cues = [cue(1, () => {})];
    h.plan("a", cues, { set: "next", musicAt: 4000 });
    expect(h.on).toBe("a");
    expect(h.cues).toBe(cues);
  });

  it("settled, fires none of its cues any more", () => {
    const { h } = handOver();
    const fire = vi.fn();
    h.plan("a", [cue(1000, fire)], null);
    h.settle();
    runCues(h.cues, 2000, () => 2000, 400, () => true, () => {});
    expect(fire).not.toHaveBeenCalled();
  });

  it("dropped, lets go of all of it, the silence at the song's end included", () => {
    const { h, mixer } = handOver();
    expect(h.drop()).toBe(false);
    h.plan("a", [cue(1, () => {})], { set: "next", musicAt: 4000 });
    mixer.silenceAt("a", 200_000);
    expect(h.drop()).toBe(true);
    expect([h.on, h.cues]).toEqual([null, []]);
    expect(mixer.silencing).toBe(false);
    expect(mixer.silentIn()).toBe(0);
    // Its hold is gone with it.
    expect(h.land("next")).toBeNull();
  });

  it("landed, gives the hold for the set that came in, and keeps when the song's end goes silent", () => {
    const { h, mixer } = handOver();
    h.plan("a", [cue(1, () => {})], { set: "next", musicAt: 4000 });
    mixer.silenceAt("a", 200_000);
    expect(h.land("next")).toEqual({ set: "next", musicAt: 4000 });
    expect([h.on, h.cues]).toEqual([null, []]);
    expect(mixer.silencing).toBe(false);
    expect(mixer.silentIn()).toBe(10_000);
    // Another set coming in has no hold of its own.
    h.plan("a", [], { set: "next", musicAt: 4000 });
    expect(h.land("another")).toBeNull();
  });
});
