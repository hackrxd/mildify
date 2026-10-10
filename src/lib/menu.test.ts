import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("./toasts.svelte", () => ({ toasts }));

let m: typeof import("./menu.svelte");

beforeEach(async () => {
  vi.resetModules();
  toasts.error.mockClear();
  m = await import("./menu.svelte");
});

describe("addedItems", () => {
  const song = { name: "Song", explicit: false };

  it("lists the entries that apply, labelled for the thing", () => {
    const done: string[] = [];
    const items = m.addedItems<typeof song>(
      [
        { label: (s) => `Share ${s.name}`, action: (s) => done.push(s.name) },
        { label: "Explicit only", action: () => {}, when: (s) => s.explicit },
        { label: "Always", action: () => {} },
      ],
      song,
    );
    expect(items.map((i) => i.label)).toEqual(["Share Song", "Always"]);
    items[0].action();
    expect(done).toEqual(["Song"]);
  });

  it("leaves out an entry whose label or filter throws, or that names nothing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = () => {
      throw new Error("broken");
    };
    const items = m.addedItems(
      [
        { label: broken, action: () => {} },
        { label: "Filtered", action: () => {}, when: broken },
        { label: () => undefined as unknown as string, action: () => {} },
        { label: "  ", action: () => {} },
        { label: "Fine", action: () => {} },
      ],
      song,
    );
    expect(items.map((i) => i.label)).toEqual(["Fine"]);
  });

  it("tells of an action that fails at once, or later", async () => {
    const [now, later] = m.addedItems(
      [
        {
          label: "Now",
          action: () => {
            throw new Error("failed at once");
          },
        },
        { label: "Later", action: async () => Promise.reject(new Error("failed later")) },
      ],
      song,
    );
    now.action();
    expect(toasts.error).toHaveBeenCalledWith(new Error("failed at once"));
    later.action();
    await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledWith(new Error("failed later")));
  });
});

describe("contextMenu", () => {
  it("opens the menu where it's right-clicked, with items made as it opens", () => {
    const el = document.createElement("div");
    let label = "First";
    const detach = m.contextMenu(() => [{ label, action: () => {} }])(el);
    label = "Made as it opens";
    const e = new MouseEvent("contextmenu", { clientX: 30, clientY: 40, cancelable: true });
    el.dispatchEvent(e);
    flushSync();
    expect(e.defaultPrevented).toBe(true);
    expect([m.menu.open, m.menu.x, m.menu.y]).toEqual([true, 30, 40]);
    expect(m.menu.items.map((i) => i.label)).toEqual(["Made as it opens"]);
    m.menu.close();
    (detach as () => void)();
    el.dispatchEvent(new MouseEvent("contextmenu"));
    expect(m.menu.open).toBe(false);
  });

  it("opens no menu with nothing in it", () => {
    const el = document.createElement("div");
    m.contextMenu(() => [])(el);
    el.dispatchEvent(new MouseEvent("contextmenu"));
    expect(m.menu.open).toBe(false);
  });
});
