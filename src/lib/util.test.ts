import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queue, Track } from "./types";
import {
  debounce,
  formatDuration,
  formatRuntime,
  idFromUri,
  pickImage,
  plainText,
  plural,
  upcomingTrackIds,
  year,
} from "./util";

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [1000, "0:01"],
    [59_999, "0:59"],
    [60_000, "1:00"],
    [3 * 60_000 + 7_000, "3:07"],
    [59 * 60_000 + 59_000, "59:59"],
    [3_600_000, "1:00:00"],
    [3_600_000 + 5 * 60_000 + 9_000, "1:05:09"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("clamps negative positions to zero", () => {
    expect(formatDuration(-5000)).toBe("0:00");
  });
});

describe("formatRuntime", () => {
  it.each([
    [0, "0 min"],
    [29_999, "0 min"],
    [30_000, "1 min"],
    [59 * 60_000, "59 min"],
    [60 * 60_000, "1 hr 0 min"],
    [72 * 60_000, "1 hr 12 min"],
    // Rounds to minutes before splitting, so 59.5 min doesn't read "0 hr 60 min".
    [59.5 * 60_000, "1 hr 0 min"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatRuntime(ms)).toBe(text);
  });
});

describe("pickImage", () => {
  const img = (width: number | null) => ({ url: `w${width}`, width, height: width });

  it("returns null without images", () => {
    expect(pickImage(null)).toBeNull();
    expect(pickImage(undefined)).toBeNull();
    expect(pickImage([])).toBeNull();
  });

  it("picks the smallest image at least `min` wide, whatever the input order", () => {
    expect(pickImage([img(640), img(64), img(300)])).toBe("w300");
    expect(pickImage([img(640), img(64), img(300)], 301)).toBe("w640");
    expect(pickImage([img(640), img(64), img(300)], 10)).toBe("w64");
  });

  it("falls back to the largest image when none is big enough", () => {
    expect(pickImage([img(64), img(160)], 300)).toBe("w160");
  });

  it("treats a missing width as 0", () => {
    expect(pickImage([img(null)])).toBe("wnull");
    expect(pickImage([img(null), img(300)])).toBe("w300");
  });

  it("doesn't reorder the caller's array", () => {
    const images = [img(640), img(64)];
    pickImage(images);
    expect(images.map((i) => i.width)).toEqual([640, 64]);
  });
});

describe("idFromUri", () => {
  it("takes the last segment of a Spotify URI", () => {
    expect(idFromUri("spotify:track:4uLU6hMCjMI75M1A2tKUQC")).toBe("4uLU6hMCjMI75M1A2tKUQC");
    expect(idFromUri("spotify:user:someone:collection")).toBe("collection");
  });

  it("passes a bare id through", () => {
    expect(idFromUri("4uLU6hMCjMI75M1A2tKUQC")).toBe("4uLU6hMCjMI75M1A2tKUQC");
  });
});

describe("upcomingTrackIds", () => {
  const t = (uri: string) => ({ uri }) as Track;
  const queue = (...uris: string[]): Queue => ({ currently_playing: null, queue: uris.map(t) });

  it("takes the next tracks in order, up to the count", () => {
    expect(upcomingTrackIds(queue("spotify:track:a", "spotify:track:b", "spotify:track:c"), null, 2)).toEqual(["a", "b"]);
  });

  it("skips episodes, local files, repeats and the current track", () => {
    const q = queue("spotify:track:now", "spotify:episode:e", "spotify:local:x", "spotify:track:a", "spotify:track:a", "spotify:track:b");
    expect(upcomingTrackIds(q, "now", 5)).toEqual(["a", "b"]);
  });

  it("gives nothing for a zero count or no queue", () => {
    expect(upcomingTrackIds(queue("spotify:track:a"), null, 0)).toEqual([]);
    expect(upcomingTrackIds(null, null, 3)).toEqual([]);
  });
});

describe("year", () => {
  it("handles every release date precision Spotify returns", () => {
    expect(year("1997-05-21")).toBe("1997");
    expect(year("1997-05")).toBe("1997");
    expect(year("1997")).toBe("1997");
    expect(year(undefined)).toBe("");
  });
});

describe("plural", () => {
  it("adds an s except for exactly one", () => {
    expect(plural(0, "song")).toBe("0 songs");
    expect(plural(1, "song")).toBe("1 song");
    expect(plural(2, "song")).toBe("2 songs");
  });

  it("formats large counts with grouping", () => {
    expect(plural(12345, "song")).toBe(`${(12345).toLocaleString()} songs`);
  });
});

describe("plainText", () => {
  it("strips markup and decodes entities", () => {
    expect(plainText('Songs by <a href="spotify:artist:x">Artist</a> &amp; friends')).toBe("Songs by Artist & friends");
  });

  it("returns an empty string for nothing", () => {
    expect(plainText(null)).toBe("");
    expect(plainText(undefined)).toBe("");
    expect(plainText("")).toBe("");
  });

  it("doesn't run scripts or load images from the description", () => {
    const onerror = vi.fn();
    (globalThis as Record<string, unknown>).__pwned = onerror;
    expect(plainText('<img src="x" onerror="__pwned()">hi<script>__pwned()</script>')).toBe("hi__pwned()");
    expect(onerror).not.toHaveBeenCalled();
    delete (globalThis as Record<string, unknown>).__pwned;
  });
});

describe("debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once, with the last arguments, after calls stop", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 250);
    d(1);
    vi.advanceTimersByTime(200);
    d(2);
    vi.advanceTimersByTime(200);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("fires again for a later burst", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("a");
    vi.advanceTimersByTime(100);
    d("b");
    vi.advanceTimersByTime(100);
    expect(fn.mock.calls).toEqual([["a"], ["b"]]);
  });
});
