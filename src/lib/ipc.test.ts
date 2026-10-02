import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, errorMessage, isAppError, onAuthLost, type AppError } from "./ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const appError = (kind: AppError["kind"], message = "boom", status: number | null = null): AppError => ({
  kind,
  message,
  status,
});

beforeEach(() => {
  invokeMock.mockReset();
  onAuthLost(() => {});
});

describe("isAppError", () => {
  it("recognises the backend's error shape", () => {
    expect(isAppError(appError("api", "x", 404))).toBe(true);
    expect(isAppError({ kind: "other", message: "x" })).toBe(true);
  });

  it.each([null, undefined, "error", 42, new Error("x"), { message: "x" }, { kind: "api" }])("rejects %o", (v) => {
    expect(isAppError(v)).toBe(false);
  });
});

describe("errorMessage", () => {
  it("reads the message from backend errors, Errors and anything else", () => {
    expect(errorMessage(appError("network", "offline"))).toBe("offline");
    expect(errorMessage(new TypeError("bad"))).toBe("bad");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("api", () => {
  it("invokes the api command with method, path and body", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await expect(api("PUT", "/me/player", { body: { play: true } })).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("api", {
      method: "PUT",
      path: "/me/player",
      query: undefined,
      body: { play: true },
    });
  });

  it("stringifies query values and drops undefined and null ones", async () => {
    invokeMock.mockResolvedValue(null);
    await api("GET", "/search", { query: { q: "x", limit: 10, flag: false, device_id: undefined, other: null } });
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      query: [
        ["q", "x"],
        ["limit", "10"],
        ["flag", "false"],
      ],
    });
  });

  it("reports a lost session, then rethrows", async () => {
    const lost = vi.fn();
    onAuthLost(lost);
    const err = appError("not_signed_in");
    invokeMock.mockRejectedValue(err);
    await expect(api("GET", "/me")).rejects.toBe(err);
    expect(lost).toHaveBeenCalledOnce();
  });

  it("rethrows other errors without reporting a lost session", async () => {
    const lost = vi.fn();
    onAuthLost(lost);
    const err = appError("api", "Not found", 404);
    invokeMock.mockRejectedValue(err);
    await expect(api("GET", "/albums/x")).rejects.toBe(err);
    expect(lost).not.toHaveBeenCalled();
  });
});
