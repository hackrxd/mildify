// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TARGETS, directDependencies, missing } from "./platform-deps.mjs";

const node = (name: string, kinds: (string | null)[]) => ({ name, dep_kinds: kinds.map((kind) => ({ kind })) });

describe("platform dependencies", () => {
  it("reads the root package's direct, normal dependencies", () => {
    const metadata = {
      resolve: {
        root: "app",
        nodes: [
          { id: "app", deps: [node("serde", [null]), node("tauri-build", ["build"]), node("tempfile", ["dev", null])] },
          { id: "serde", deps: [node("serde_derive", [null])] },
        ],
      },
    };
    expect([...directDependencies(metadata)].sort()).toEqual(["serde", "tempfile"]);
  });

  it("names what a target lacks that the others have", () => {
    // A shared dependency written under the Linux table: Windows and macOS lose it.
    const linux = new Set(["keyring", "librespot-core", "serde"]);
    const other = new Set(["keyring", "serde"]);
    expect(missing({ linux, windows: other, mac: other })).toEqual({ windows: ["librespot-core"], mac: ["librespot-core"] });
    expect(missing({ linux, windows: linux })).toEqual({});
    expect(missing({ linux, windows: other }, new Set(["librespot-core"]))).toEqual({});
  });

  it("checks the targets the release builds", () => {
    const workflow = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
    expect(workflow).toContain("platform-deps.mjs");
    for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
      expect(workflow).toContain(target);
      expect(TARGETS).toContain(target);
    }
  });
});
