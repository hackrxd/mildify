import { errorMessage } from "./ipc";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
}

class Toasts {
  items = $state<Toast[]>([]);
  #next = 1;

  show(message: string, tone: Toast["tone"] = "info", ms = 4000) {
    const id = this.#next++;
    this.items = [...this.items.filter((t) => t.message !== message), { id, message, tone }];
    setTimeout(() => this.dismiss(id), ms);
  }

  error(e: unknown) {
    this.show(errorMessage(e), "error", 6000);
  }

  dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new Toasts();
