import { beforeEach, describe, expect, it, vi } from "vitest";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { backend } from "./ipc";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.1.0") }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  backend: { uiUpdate: vi.fn(), applyUiUpdate: vi.fn() },
}));
vi.mock("./toasts.svelte", () => ({ toasts: { show: vi.fn(), error: vi.fn() } }));

const uiUpdate = vi.mocked(backend.uiUpdate);
const fullCheck = vi.mocked(check);

function fullUpdate(version: string) {
  return { version, download: vi.fn(async () => {}), install: vi.fn(async () => {}) } as unknown as Update;
}

let updater: typeof import("./updater.svelte").updater;

beforeEach(async () => {
  vi.resetModules();
  uiUpdate.mockReset();
  fullCheck.mockReset();
  vi.mocked(backend.applyUiUpdate).mockReset().mockResolvedValue(true);
  ({ updater } = await import("./updater.svelte"));
});

describe("checking", () => {
  it("offers a reload for an interface update, without the full updater", async () => {
    uiUpdate.mockResolvedValue({ status: "ready", version: "1.2.0" });
    await updater.check();
    expect(updater.state).toBe("ready");
    expect(updater.available).toBe("1.2.0");
    expect(updater.needsRestart).toBe(false);
    expect(fullCheck).not.toHaveBeenCalled();
  });

  it("is up to date when the interface is, even if the app is older", async () => {
    uiUpdate.mockResolvedValue({ status: "up_to_date" });
    await updater.check();
    expect(updater.state).toBe("up_to_date");
    expect(fullCheck).not.toHaveBeenCalled();
  });

  it("downloads the full update and warns of a restart when the app itself changes", async () => {
    uiUpdate.mockResolvedValue({ status: "restart", version: "1.3.0" });
    const update = fullUpdate("1.3.0");
    fullCheck.mockResolvedValue(update);
    await updater.check();
    expect(update.download).toHaveBeenCalled();
    expect(updater.state).toBe("ready");
    expect(updater.available).toBe("1.3.0");
    expect(updater.needsRestart).toBe(true);
  });

  it("falls back to the full updater when there's no interface update to go by", async () => {
    uiUpdate.mockRejectedValue({ kind: "network", message: "404", status: null });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fullCheck.mockResolvedValue(fullUpdate("1.3.0"));
    await updater.check();
    expect(updater.state).toBe("ready");
    expect(updater.needsRestart).toBe(true);
  });
});

describe("applying", () => {
  it("restarts only for a full update", async () => {
    uiUpdate.mockResolvedValue({ status: "restart", version: "1.3.0" });
    const update = fullUpdate("1.3.0");
    fullCheck.mockResolvedValue(update);
    await updater.check();
    await updater.apply();
    expect(backend.applyUiUpdate).not.toHaveBeenCalled();
    expect(update.install).toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalled();
  });

  it("switches the interface for an interface update, without restarting", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    uiUpdate.mockResolvedValue({ status: "ready", version: "1.2.0" });
    await updater.check();
    await updater.apply();
    expect(backend.applyUiUpdate).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
