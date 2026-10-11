import { describe, expect, it } from "vitest";
import { Mixer, MUTE_RAMP_MS } from "./djMixer";
import { DUCK_DOWN_MS, DUCK_LEVEL, DUCK_UP_MS } from "./djTiming";

/** A mixer over a player whose clock, song and talk the test sets; `sent` is what it asked the player for. */
function mixer() {
  const host = {
    t: 1000,
    uri: "a" as string | null,
    pos: 0,
    talking: false,
    sent: [] as [number, number, number][],
  };
  const m = new Mixer({
    gain: (level, delayMs, rampMs) => void host.sent.push([level, delayMs, rampMs]),
    now: () => host.t,
    track: () => host.uri,
    position: () => host.pos,
    speaking: () => host.talking,
  });
  return { m, host };
}

describe("Mixer", () => {
  it("asks the player for a gain in whole milliseconds, never before now", () => {
    const { m, host } = mixer();
    expect(m.level).toBe(1);
    m.to(0.5, -40, 100.4);
    m.to(0.3, 250.6, 99.5);
    expect(host.sent).toEqual([
      [0.5, 0, 100],
      [0.3, 251, 100],
    ]);
    expect(m.level).toBe(0.3);
  });

  it("turns the music down under the voice and back up, only when it's down", () => {
    const { m, host } = mixer();
    m.unduck();
    expect(host.sent).toEqual([]);
    m.duck(500);
    expect(m.ducked).toBe(true);
    m.unduck();
    expect(m.ducked).toBe(false);
    expect(host.sent).toEqual([
      [DUCK_LEVEL, 500, DUCK_DOWN_MS],
      [1, 0, DUCK_UP_MS],
    ]);
  });

  it("brings the music back under the voice while the DJ talks, and up otherwise", () => {
    const { m, host } = mixer();
    m.to(0, 0, 0);
    host.talking = true;
    m.restore();
    host.talking = false;
    m.restore(DUCK_UP_MS);
    expect(host.sent.slice(1)).toEqual([
      [DUCK_LEVEL, 0, 0],
      [1, 0, DUCK_UP_MS],
    ]);
  });

  it("silences a song's end as heard, timed from where the song is, and knows when", () => {
    const { m, host } = mixer();
    host.pos = 190_000;
    m.silenceAt("a", 200_000);
    expect(host.sent).toEqual([[0, 10_000 - MUTE_RAMP_MS, MUTE_RAMP_MS]]);
    expect(m.silencing).toBe(true);
    expect(m.silentIn()).toBe(10_000);
    host.t += 4000;
    expect(m.silentIn()).toBe(6000);
    // Any sound at all is no silence at the end.
    m.to(DUCK_LEVEL, 0, 0);
    expect(m.silencing).toBe(false);
  });

  it("times the silence at a song's end anew from where the song is when refreshed", () => {
    const { m, host } = mixer();
    host.pos = 190_000;
    m.silenceAt("a", 200_000);
    // Paused 5 s, then played on from where it was.
    host.t += 5000;
    host.talking = true;
    host.sent = [];
    m.refresh();
    expect(host.sent).toEqual([
      [DUCK_LEVEL, 0, 0],
      [0, 10_000 - MUTE_RAMP_MS, MUTE_RAMP_MS],
    ]);
    expect(m.silentIn()).toBe(10_000);
  });

  it("refreshed past the silence, or on another song, says its level again", () => {
    const { m, host } = mixer();
    m.refresh();
    expect(host.sent).toEqual([]);
    host.pos = 190_000;
    m.silenceAt("a", 200_000);
    host.uri = "b";
    host.sent = [];
    m.refresh();
    expect(host.sent).toEqual([[0, 0, 0]]);
    host.uri = "a";
    host.pos = 200_500;
    m.refresh();
    expect(host.sent).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  it("renews music that's down before the player lifts it on its own", () => {
    const { m, host } = mixer();
    m.renew(host.t + 60_000);
    expect(host.sent).toEqual([]);
    m.duck(0);
    m.renew(host.t + 29_000);
    expect(host.sent).toHaveLength(1);
    m.renew(host.t + 31_000);
    expect(host.sent).toEqual([
      [DUCK_LEVEL, 0, DUCK_DOWN_MS],
      [DUCK_LEVEL, 0, 0],
    ]);
  });

  it("times the silence again when the song has drifted from it, playing", () => {
    const { m, host } = mixer();
    host.pos = 190_000;
    m.silenceAt("a", 200_000);
    host.sent = [];
    // On time, a little off, another song, or paused: nothing to do.
    m.retime(host.t + 1000, "a", 191_000, true);
    m.retime(host.t + 1000, "a", 191_200, true);
    m.retime(host.t + 1000, "b", 185_000, true);
    m.retime(host.t + 1000, "a", 185_000, false);
    expect(host.sent).toEqual([]);
    // Moved back 6 s.
    host.t += 1000;
    host.pos = 185_000;
    m.retime(host.t, "a", host.pos, true);
    expect(host.sent).toEqual([
      [1, 0, 0],
      [0, 15_000 - MUTE_RAMP_MS, MUTE_RAMP_MS],
    ]);
  });

  it("keeps when the silence is heard once its song is gone, until it's dropped", () => {
    const { m, host } = mixer();
    host.pos = 199_000;
    m.silenceAt("a", 200_000);
    m.songEnded();
    expect(m.silencing).toBe(false);
    expect(m.silentIn()).toBe(1000);
    m.dropSilence();
    expect(m.silentIn()).toBe(-host.t);
  });
});
