// A single app-wide context menu.
import type { Attachment } from "svelte/attachments";
import { toasts } from "./toasts.svelte";

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

class Menu {
  open = $state(false);
  x = $state(0);
  y = $state(0);
  items = $state<MenuItem[]>([]);
  /** `x` is where the menu ends, not where it starts: opened from a button, it lines up with the button's end. */
  alignEnd = $state(false);
  /** The button it opened from, which says it's open and has the focus back once it's answered. */
  opener = $state.raw<HTMLElement | null>(null);

  show(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    this.items = items;
    this.x = e.clientX;
    this.y = e.clientY;
    this.alignEnd = false;
    this.opener = null;
    this.open = true;
  }

  /** Opens the menu under `button`, its end in line with the button's, as a menu button does: from the keyboard
   * too. The same button again closes it. */
  showFor(button: HTMLElement, items: MenuItem[]) {
    if (this.open && this.opener === button) return this.close(true);
    const r = button.getBoundingClientRect();
    this.items = items;
    this.x = r.right;
    this.y = r.bottom + 4;
    this.alignEnd = true;
    this.opener = button;
    this.open = true;
  }

  /** Closes the menu. `answered`, by a choice or Escape, gives the focus back to the button it opened from. */
  close(answered = false) {
    this.open = false;
    if (answered && this.opener?.isConnected) this.opener.focus();
    this.opener = null;
  }
}

export const menu = new Menu();

/** Opens the menu on right-click, or the keyboard's menu key, with the items `items` makes as it opens:
 * `{@attach contextMenu(() => items)}`. Without any, there's no menu. */
export function contextMenu(items: () => MenuItem[]): Attachment<HTMLElement> {
  return (el) => {
    const open = (e: MouseEvent) => {
      const list = items();
      if (list.length) menu.show(e, list);
    };
    el.addEventListener("contextmenu", open);
    return () => el.removeEventListener("contextmenu", open);
  };
}

/** A menu entry that code from outside the app adds, such as an extension's, for a thing of type T. */
export interface AddedItem<T> {
  label: string | ((thing: T) => string);
  /** May be async: a failure, then or later, is told in a toast. What it returns is otherwise ignored. */
  action: (thing: T) => unknown;
  /** Hides the entry for things it doesn't apply to. */
  when?: (thing: T) => boolean;
}

/** `items` as entries for `thing`, guarded: one whose `when` or label throws, or names nothing, is left out, and an
 * action that fails, at once or later, says so in a toast. The menu works whatever they do. */
export function addedItems<T>(items: AddedItem<T>[], thing: T): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    try {
      if (item.when && !item.when(thing)) continue;
      const label = typeof item.label === "function" ? item.label(thing) : item.label;
      if (typeof label !== "string" || !label.trim()) continue;
      out.push({ label, action: () => run(() => item.action(thing)) });
    } catch (e) {
      console.warn("A menu entry was left out:", e);
    }
  }
  return out;
}

function run(action: () => unknown) {
  try {
    Promise.resolve(action()).catch((e) => toasts.error(e));
  } catch (e) {
    toasts.error(e);
  }
}
