// Native Spotify's tests for the vendored renderer; not part of upstream.
import { describe, expect, it } from "vitest";
import { Spring } from "../src/modules/Spring.ts";

/** Steps a spring at 60 fps for `seconds`, returning every position. */
function run(spring: Spring, seconds: number, dt = 1 / 60): number[] {
  const out: number[] = [];
  for (let t = 0; t < seconds; t += dt) out.push(spring.Step(dt));
  return out;
}

const regimes = [
  ["underdamped", 0.5],
  ["critically damped", 1],
  ["overdamped", 2],
] as const;

describe("Spring", () => {
  it("starts at rest on its goal when no goal is given", () => {
    const s = new Spring(3, 2, 1);
    expect(s.GetGoal()).toBe(3);
    expect(s.Step(1 / 60)).toBe(3);
    expect(s.CanSleep()).toBe(true);
  });

  it.each(regimes)("settles on the goal when %s", (_, damping) => {
    const s = new Spring(0, 2, damping, 1);
    expect(s.CanSleep()).toBe(false);
    const path = run(s, 10);
    expect(path.at(-1)).toBeCloseTo(1, 4);
    expect(s.CanSleep()).toBe(true);
  });

  it.each(regimes)("gives the same result for one long step or many short ones when %s", (_, damping) => {
    // The integrator is the closed-form solution, so it's exact regardless of frame rate.
    const coarse = new Spring(0, 1.5, damping, 1);
    const fine = new Spring(0, 1.5, damping, 1);
    coarse.Step(0.3);
    for (let i = 0; i < 30; i++) fine.Step(0.01);
    expect(fine.Step(0)).toBeCloseTo(coarse.Step(0), 9);
  });

  it("overshoots when underdamped", () => {
    expect(Math.max(...run(new Spring(0, 2, 0.3, 1), 3))).toBeGreaterThan(1.05);
  });

  it.each([1, 1.5, 3])("approaches without overshooting at damping %s", (damping) => {
    const path = run(new Spring(0, 2, damping, 1), 5);
    expect(Math.max(...path)).toBeLessThanOrEqual(1 + 1e-9);
    for (let i = 1; i < path.length; i++) expect(path[i]).toBeGreaterThanOrEqual(path[i - 1] - 1e-12);
  });

  it("settles faster at a higher frequency", () => {
    const slow = new Spring(0, 1, 1, 1);
    const fast = new Spring(0, 4, 1, 1);
    slow.Step(0.25);
    fast.Step(0.25);
    expect(Math.abs(1 - fast.Step(0))).toBeLessThan(Math.abs(1 - slow.Step(0)));
  });

  it("can jump straight to a new goal", () => {
    const s = new Spring(0, 2, 0.5, 1);
    run(s, 0.1);
    s.SetGoal(5, true);
    expect(s.Step(1 / 60)).toBe(5);
    expect(s.CanSleep()).toBe(true);
  });

  it("keeps its momentum when the goal moves", () => {
    const s = new Spring(0, 2, 1, 1);
    const before = run(s, 0.1).at(-1)!;
    s.SetGoal(-1);
    expect(s.GetGoal()).toBe(-1);
    // Still moving towards the old goal for a moment before turning around.
    expect(s.Step(1 / 240)).toBeGreaterThan(before);
  });

  it("stays finite at damping ratios just under 1", () => {
    const s = new Spring(0, 2, 1 - 1e-12, 1);
    const path = run(s, 5);
    expect(path.every(Number.isFinite)).toBe(true);
    expect(path.at(-1)).toBeCloseTo(1, 4);
  });
});
