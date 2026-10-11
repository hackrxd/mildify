import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GaveUp, NextSet } from "./djNext";

/** A promise with its settling in the test's hands. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("NextSet", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("hands over what a pick comes to, and is picking until then", async () => {
    const next = new NextSet();
    const answer = deferred<string>();
    const done = vi.fn();
    const dropped = vi.fn();
    let wanted: () => boolean = () => false;
    next.pick(
      (w) => {
        wanted = w;
        return answer.promise;
      },
      done,
      dropped,
    );
    expect(next.picking).toBe(true);
    expect(wanted()).toBe(true);
    answer.resolve("set");
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledWith("set");
    expect(dropped).not.toHaveBeenCalled();
    expect(next.picking).toBe(false);
  });

  it("drops what a pick let go of comes to, and a newer pick isn't let go of with it", async () => {
    const next = new NextSet();
    const first = deferred<string>();
    const second = deferred<string>();
    const done = vi.fn();
    const dropped = vi.fn();
    let firstWanted: () => boolean = () => true;
    next.pick(
      (w) => {
        firstWanted = w;
        return first.promise;
      },
      done,
      dropped,
    );
    next.letGo();
    expect(firstWanted()).toBe(false);
    expect(next.picking).toBe(false);
    next.pick(() => second.promise, done, dropped);
    first.resolve("old");
    await vi.advanceTimersByTimeAsync(0);
    expect(dropped).toHaveBeenCalledWith("old");
    // The newer pick is still under way.
    expect(next.picking).toBe(true);
    second.resolve("new");
    await vi.advanceTimersByTimeAsync(0);
    expect(done.mock.calls).toEqual([["new"]]);
    expect(next.picking).toBe(false);
  });

  it("waits for the model's answer, until its time is up", async () => {
    const next = new NextSet();
    await expect(next.wait(Promise.resolve("answer"), 1000)).resolves.toBe("answer");
    const slow = next.wait(new Promise(() => {}), 1000);
    const caught = slow.catch((e: unknown) => e);
    expect(next.waiting).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    await vi.advanceTimersByTimeAsync(1);
    const e = await caught;
    expect(e).toBeInstanceOf(GaveUp);
    expect((e as Error).message).toBe("the model took too long");
  });

  it("stops waiting when hurried, and only while it waits", async () => {
    const next = new NextSet();
    next.hurry();
    const answer = deferred<string>();
    const waited = next.wait(answer.promise, 10_000).catch((e: unknown) => e);
    next.hurry();
    const e = await waited;
    expect(e).toBeInstanceOf(GaveUp);
    expect((e as Error).message).toBe("the music can't wait");
    // Hurried, the answer still comes in the end: the wait is over by then.
    answer.resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(next.waiting).toBe(false);
  });

  it("hurries the newest wait, which an older one settling doesn't take over", async () => {
    const next = new NextSet();
    const older = deferred<string>();
    const olderWait = next.wait(older.promise, 10_000);
    const newerWait = next.wait(new Promise<string>(() => {}), 10_000).catch((e: unknown) => e);
    older.resolve("older");
    await expect(olderWait).resolves.toBe("older");
    expect(next.waiting).toBe(true);
    next.hurry();
    expect(await newerWait).toBeInstanceOf(GaveUp);
  });

  it("starts afresh: what was being picked is let go of, and no wait can be hurried", async () => {
    const next = new NextSet();
    const answer = deferred<string>();
    const done = vi.fn();
    const dropped = vi.fn();
    next.pick(() => answer.promise, done, dropped);
    const waited = next.wait(new Promise<string>(() => {}), 10_000).catch((e: unknown) => e);
    next.reset();
    expect(next.picking).toBe(false);
    expect(next.waiting).toBe(false);
    next.hurry();
    answer.resolve("set");
    await vi.advanceTimersByTimeAsync(0);
    expect(done).not.toHaveBeenCalled();
    expect(dropped).toHaveBeenCalledWith("set");
    // The old wait runs out its own time.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await waited) as Error).message).toBe("the model took too long");
  });
});
