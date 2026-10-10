import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmStrip from "./ConfirmStrip.svelte";

let target: HTMLElement;
let strip: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (strip) unmount(strip);
  strip = null;
  target.remove();
});

/** Asks under a button that had the focus, as a setting's button or picker does. */
function ask() {
  target = document.body.appendChild(document.createElement("div"));
  const trigger = target.appendChild(document.createElement("button"));
  trigger.focus();
  const onconfirm = vi.fn();
  const oncancel = vi.fn();
  strip = mount(ConfirmStrip, {
    target,
    props: { text: "Switch the DJ?", confirm: "Switch and stop", cancel: "Keep playing", onconfirm, oncancel },
  });
  flushSync();
  const button = (name: string) => [...target.querySelectorAll("button")].find((b) => b.textContent === name)!;
  return { trigger, onconfirm, oncancel, button };
}

describe("ConfirmStrip", () => {
  it("asks its question with the cancel button focused", () => {
    ask();
    const group = target.querySelector('[role="group"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("Switch the DJ?");
    expect(document.activeElement?.textContent).toBe("Keep playing");
  });

  it("answers with either button, giving the focus back first", () => {
    const { trigger, onconfirm, oncancel, button } = ask();
    let focused: Element | null = null;
    onconfirm.mockImplementation(() => (focused = document.activeElement));
    button("Switch and stop").click();
    expect(onconfirm).toHaveBeenCalledOnce();
    expect(focused).toBe(trigger);
    button("Keep playing").focus();
    button("Keep playing").click();
    expect(oncancel).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
  });

  it("cancels on Escape, and only on Escape", () => {
    const { trigger, onconfirm, oncancel, button } = ask();
    const key = (k: string) => button("Keep playing").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("Enter");
    expect(oncancel).not.toHaveBeenCalled();
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    key("Escape");
    document.removeEventListener("keydown", outside);
    expect(oncancel).toHaveBeenCalledOnce();
    expect(onconfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    // Escape is the question's: nothing else closes on it.
    expect(outside).not.toHaveBeenCalled();
  });
});
