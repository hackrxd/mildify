// A single app-wide context menu.

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
