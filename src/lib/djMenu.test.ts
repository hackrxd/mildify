import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DjSet } from "./dj.svelte";

const dj = vi.hoisted(() => ({ current: null as { id: number } | null, canSkipSet: vi.fn(() => true), skipSet: vi.fn(async () => {}) }));
const toasts = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn() }));
const util = vi.hoisted(() => ({ copyText: vi.fn(async (_text: string) => {}) }));
vi.mock("./dj.svelte", () => ({ dj }));
vi.mock("./toasts.svelte", () => ({ toasts }));
vi.mock("./util", () => util);

let m: typeof import("./djMenu");

beforeEach(async () => {
  vi.resetModules();
  for (const fn of [dj.canSkipSet, dj.skipSet, toasts.show, toasts.error, util.copyText]) fn.mockClear();
  dj.canSkipSet.mockReturnValue(true);
  dj.current = null;
  m = await import("./djMenu");
});

function set(id: number): DjSet {
  const song = (n: number, artists: string[]) => ({ uri: `spotify:track:${n}`, name: `Song ${n}`, artists }) as DjSet["songs"][number];
  return { id, name: "Sunday night on repeat", songs: [song(1, ["Childish Gambino"]), song(2, ["Masego", "FKJ"])] } as DjSet;
}

describe("setMenu", () => {
  it("skips the set playing, and copies any set's songs", async () => {
    const playing = set(1);
    dj.current = playing;
    const items = m.setMenu(playing);
    expect(items.map((i) => [i.label, !!i.disabled])).toEqual([
      ["Skip this set", false],
      ["Copy the song list", false],
    ]);
    items[0].action();
    expect(dj.skipSet).toHaveBeenCalledOnce();
    items[1].action();
    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledWith("Copied the song list"));
    expect(util.copyText).toHaveBeenCalledWith("Sunday night on repeat\n1. Song 1 by Childish Gambino\n2. Song 2 by Masego, FKJ");
  });

  it("offers no skip for a set that isn't playing, and greys it out while the set playing can't be skipped", () => {
    dj.current = set(1);
    expect(m.setMenu(set(2)).map((i) => i.label)).toEqual(["Copy the song list"]);
    dj.canSkipSet.mockReturnValue(false);
    expect(m.setMenu(set(1))[0]).toMatchObject({ label: "Skip this set", disabled: true });
  });

  it("says when the songs couldn't be copied", async () => {
    util.copyText.mockRejectedValueOnce(new Error("Couldn't copy to the clipboard"));
    m.setMenu(set(2))[0].action();
    await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledWith(new Error("Couldn't copy to the clipboard")));
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it("adds what's added for sets after its own entries, guarded, until it's removed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved: string[] = [];
    const remove = m.addSetAction({ label: (s) => `Save "${s.name}" as a playlist`, action: (s) => void saved.push(s.name) });
    m.addSetAction({
      label: () => {
        throw new Error("broken");
      },
      action: () => {},
    });
    const items = m.setMenu(set(2));
    expect(items.map((i) => i.label)).toEqual(["Copy the song list", 'Save "Sunday night on repeat" as a playlist']);
    items[1].action();
    expect(saved).toEqual(["Sunday night on repeat"]);
    remove();
    expect(m.setMenu(set(2)).map((i) => i.label)).toEqual(["Copy the song list"]);
  });
});
