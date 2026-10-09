import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { menu } from "../lib/menu.svelte";
import ContextMenu from "./ContextMenu.svelte";

let target: HTMLElement;
let component: ReturnType<typeof mount>;

beforeEach(() => {
  target = document.body.appendChild(document.createElement("div"));
  component = mount(ContextMenu, { target });
});

afterEach(() => {
  menu.close();
  flushSync();
  unmount(component);
  target.remove();
});

function open(items: { label: string; action: () => void; disabled?: boolean }[]) {
  menu.show(new MouseEvent("contextmenu", { clientX: 10, clientY: 20 }), items);
  flushSync();
  return [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

describe("ContextMenu", () => {
  it("shows entries that share a label, each with its own action", () => {
    const went: string[] = [];
    const buttons = open([
      { label: "Go to Sam", action: () => went.push("first Sam") },
      { label: "Go to Sam", action: () => went.push("second Sam") },
    ]);
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Go to Sam", "Go to Sam"]);
    buttons[1].click();
    flushSync();
    expect(went).toEqual(["second Sam"]);
    expect(menu.open).toBe(false);
    expect(target.querySelector('[role="menu"]')).toBeNull();
  });

  it("focuses its first entry, moves with the arrow keys past disabled ones, and closes on Escape", async () => {
    const buttons = open([
      { label: "Add to queue", action: () => {} },
      { label: "Save to Liked Songs", action: () => {}, disabled: true },
      { label: "Go to album", action: () => {} },
    ]);
    await tick();
    await tick();
    expect(document.activeElement).toBe(buttons[0]);
    const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
    key("ArrowDown");
    expect(document.activeElement).toBe(buttons[2]);
    key("ArrowDown");
    expect(document.activeElement).toBe(buttons[0]);
    key("ArrowUp");
    expect(document.activeElement).toBe(buttons[2]);
    key("Escape");
    flushSync();
    expect(menu.open).toBe(false);
  });

  it("runs nothing for a disabled entry", () => {
    const action = vi.fn();
    const [button] = open([{ label: "Save to Liked Songs", action, disabled: true }]);
    button.click();
    expect(action).not.toHaveBeenCalled();
  });
});
