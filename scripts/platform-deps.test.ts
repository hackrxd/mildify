// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TARGETS, directDependencies, missing } from "./platform-deps.mjs";

describe("platform dependencies", () => {
  it("reads the package's direct dependencies from Cargo's tree, after the package's own line", () => {
    const tree = [
      "mildify v1.3.0 (/home/me/My Projects/mildify/src-tauri)",
      "keyring v3.6.3",
      "librespot-core v0.8.0 (/home/me/My Projects/mildify/src-tauri/vendor/librespot-core)",
      "serde v1.0.228",
      "",
    ].join("\n");
    expect([...directDependencies(tree)].sort()).toEqual(["keyring", "librespot-core", "serde"]);
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
