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

  it("opens under a menu button, and gives it the focus back once it's answered", async () => {
    const button = target.appendChild(document.createElement("button"));
    button.getBoundingClientRect = () => new DOMRect(40, 80, 32, 20);
    button.focus();
    menu.showFor(button, [{ label: "Copy the song list", action: () => {} }]);
    flushSync();
    // Its end in line with the button's.
    expect([menu.x, menu.y, menu.alignEnd]).toEqual([72, 104, true]);
    await tick();
    await tick();
    expect(document.activeElement?.textContent?.trim()).toBe("Copy the song list");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flushSync();
    expect(document.activeElement).toBe(button);

    menu.showFor(button, [{ label: "Copy the song list", action: () => {} }]);
    flushSync();
    target.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    flushSync();
    expect(document.activeElement).toBe(button);
  });

  it("lines its end up with the button's, and stays on screen", async () => {
    const width = vi.spyOn(HTMLUListElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 80));
    const button = target.appendChild(document.createElement("button"));
    button.getBoundingClientRect = () => new DOMRect(368, 80, 32, 20);
    menu.showFor(button, [{ label: "Copy the song list", action: () => {} }]);
    flushSync();
    await tick();
    flushSync();
    const list = target.querySelector<HTMLElement>('[role="menu"]')!;
    expect([list.style.left, list.style.top]).toEqual(["200px", "104px"]);
    menu.close();
    flushSync();
    button.getBoundingClientRect = () => new DOMRect(10, 80, 32, 20);
    menu.showFor(button, [{ label: "Copy the song list", action: () => {} }]);
    flushSync();
    await tick();
    flushSync();
    expect(target.querySelector<HTMLElement>('[role="menu"]')!.style.left).toBe("8px");
    width.mockRestore();
  });

  it("leaves the focus alone when it's closed some other way", async () => {
    const button = target.appendChild(document.createElement("button"));
    const elsewhere = target.appendChild(document.createElement("input"));
    menu.showFor(button, [{ label: "Copy the song list", action: () => {} }]);
    flushSync();
    elsewhere.focus();
    elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("runs nothing for a disabled entry", () => {
    const action = vi.fn();
    const [button] = open([{ label: "Save to Liked Songs", action, disabled: true }]);
    button.click();
    expect(action).not.toHaveBeenCalled();
  });
});
