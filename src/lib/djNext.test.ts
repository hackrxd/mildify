import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GaveUp, NextSet, SetQueue } from "./djNext";

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

describe("SetQueue", () => {
  /** Lets what's on its way get there. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  /** A queue over a player whose adds and clears the test sees, with an add held until let go when said. */
  function queue(hold?: string) {
    const q = new SetQueue<string>();
    const sent: string[] = [];
    const held = deferred<void>();
    const add = (uri: string) => {
      sent.push(uri);
      return uri === hold ? held.promise : Promise.resolve();
    };
    const clear = () => {
      sent.push("clear");
      return Promise.resolve();
    };
    return { q, sent, add, clear, release: () => held.resolve() };
  }

  it("says how much of the set it was given is queued, and nothing of any other", async () => {
    const { q, sent, add } = queue();
    expect(q.idle).toBe(true);
    q.add("a", ["1", "2"], add);
    expect(q.of("a")).toBe("pending");
    expect(q.of("b")).toBe("no");
    expect(q.of(null)).toBe("no");
    expect(q.adding).toBe("a");
    expect(q.idle).toBe(false);
    await q.settled;
    expect(sent).toEqual(["1", "2"]);
    expect(q.of("a")).toBe("done");
    expect(q.adding).toBeNull();
  });

  it("says when the player refused the set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = new SetQueue<string>();
    q.add("a", ["1"], () => Promise.reject(new Error("refused")));
    await q.settled;
    expect(q.of("a")).toBe("failed");
    expect(q.adding).toBeNull();
    warn.mockRestore();
  });

  it("takes a set back out: the rest of it stops, and the clear comes after what was on its way", async () => {
    const { q, sent, add, clear, release } = queue("1");
    q.add("a", ["1", "2"], add);
    await settle();
    expect(sent).toEqual(["1"]);
    q.remove("a", clear);
    expect(q.of("a")).toBe("no");
    expect(q.adding).toBeNull();
    release();
    await q.settled;
    expect(sent).toEqual(["1", "clear"]);
  });

  it("puts nothing of a set taken out before its turn in the player's queue", async () => {
    const { q, sent, add } = queue();
    q.add("a", ["1"], add);
    q.remove("a", null);
    await q.settled;
    expect(sent).toEqual([]);
    expect(q.idle).toBe(true);
  });

  it("clears only for the set it holds, and lets another set's songs go on in", async () => {
    const { q, sent, add, clear, release } = queue("1");
    q.add("a", ["1", "2"], add);
    await settle();
    // "a" came in before all of it was there, and the set picked to follow it is let go of.
    q.remove("b", clear);
    expect(q.adding).toBe("a");
    release();
    await q.settled;
    expect(sent).toEqual(["1", "2"]);
  });

  it("queues what comes after a clear once the clear is through", async () => {
    const { q, sent, add } = queue();
    q.add("a", ["1"], add);
    await q.settled;
    const cleared = deferred<void>();
    q.remove("a", () => {
      sent.push("clear");
      return cleared.promise;
    });
    q.add("b", ["2"], add);
    await settle();
    expect(sent).toEqual(["1", "clear"]);
    cleared.resolve();
    await q.settled;
    expect(sent).toEqual(["1", "clear", "2"]);
    expect(q.of("b")).toBe("done");
  });

  it("leaves a set queued while another's last song is on its way pending until its own are in", async () => {
    const q = new SetQueue<string>();
    const held = new Map<string, () => void>();
    const add = (uri: string) => new Promise<void>((r) => held.set(uri, r));
    q.add("a", ["1"], add);
    await settle();
    // "a" came in before its song was there, and the set after it is queued meanwhile.
    q.add("b", ["2"], add);
    held.get("1")!();
    await settle();
    expect(q.of("b")).toBe("pending");
    held.get("2")!();
    await q.settled;
    expect(q.of("b")).toBe("done");
  });

  it("forgets the set: nothing of it reads as queued, and the rest of it doesn't go in", async () => {
    const { q, sent, add, release } = queue("1");
    q.add("a", ["1", "2"], add);
    await settle();
    q.forget();
    expect(q.of("a")).toBe("no");
    expect(q.idle).toBe(true);
    release();
    await q.settled;
    expect(sent).toEqual(["1"]);
    expect(q.of("a")).toBe("no");
  });
});
