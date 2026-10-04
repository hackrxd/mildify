import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backend, type AppError, type AppStatus } from "./ipc";
import * as sp from "./spotify";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  backend: { status: vi.fn() },
}));
vi.mock("./spotify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spotify")>()),
  me: vi.fn(),
  myPlaylists: vi.fn(),
}));
vi.mock("./toasts.svelte", () => ({ toasts: { show: vi.fn(), error: vi.fn() } }));

const me = vi.mocked(sp.me);
const myPlaylists = vi.mocked(sp.myPlaylists);
const limited: AppError = { kind: "rate_limited", message: "Rate limited, retry in 20s", status: 429 };

let session: typeof import("./session.svelte").session;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.mocked(backend.status).mockResolvedValue({ config: { client_id: "id" }, signed_in: true } as AppStatus);
  me.mockReset().mockResolvedValue({ id: "u" } as never);
  myPlaylists.mockReset().mockResolvedValue({ items: [{ id: "p" }], next: null } as never);
  ({ session } = await import("./session.svelte"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loading the user", () => {
  it("tries again once a rate limit at launch is over", async () => {
    me.mockRejectedValueOnce(limited);
    await session.init();
    expect(session.user).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(me).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.user).toEqual({ id: "u" });
    expect(session.playlists).toEqual([{ id: "p" }]);
  });

  it("doesn't try again after other errors", async () => {
    me.mockRejectedValueOnce({ kind: "api", message: "Spotify API error 500: x", status: 500 } satisfies AppError);
    await session.init();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(me).toHaveBeenCalledTimes(1);
  });
});
