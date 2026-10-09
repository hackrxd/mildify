// A single app-wide context menu.
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

  show(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    this.items = items;
    this.x = e.clientX;
    this.y = e.clientY;
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

export const menu = new Menu();

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
