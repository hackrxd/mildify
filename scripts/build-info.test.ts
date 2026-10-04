// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backendId, buildInfo, normalise } from "./build-info";

let root: string;

function write(rel: string, contents: string) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function release(version: string) {
  write("package.json", JSON.stringify({ version }));
  write("src-tauri/Cargo.toml", `[package]\nname = "mildify"\nversion = "${version}"\n\n[dependencies]\nserde = "1"\n`);
  write(
    "src-tauri/Cargo.lock",
    `[[package]]\nname = "itoa"\nversion = "1.1.1"\n\n[[package]]\nname = "mildify"\nversion = "${version}"\n`,
  );
  write("src-tauri/tauri.conf.json", `{\n  "productName": "Mildify",\n  "version": "${version}"\n}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mildify-build-info-"));
  release("1.1.1");
  write("src-tauri/src/lib.rs", "fn main() {}\n");
  write(
    "package-lock.json",
    JSON.stringify({
      packages: {
        "node_modules/@tauri-apps/api": { version: "2.12.1" },
        "node_modules/@tauri-apps/cli": { version: "2.12.1" },
        "node_modules/svelte": { version: "5.0.0" },
      },
    }),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("backend id", () => {
  it("survives a version bump that changes nothing else", () => {
    const before = backendId(root);
    release("1.2.0");
    expect(backendId(root)).toBe(before);
    expect(buildInfo(root)).toEqual({ version: "1.2.0", backend: before });
  });

  it("changes with any backend source, dependency or config", () => {
    const before = backendId(root);
    write("src-tauri/src/ui.rs", "\n");
    const added = backendId(root);
    expect(added).not.toBe(before);

    write("src-tauri/Cargo.lock", `[[package]]\nname = "itoa"\nversion = "1.1.2"\n\n[[package]]\nname = "mildify"\nversion = "1.1.1"\n`);
    expect(backendId(root)).not.toBe(added);
  });

  it("changes with the JavaScript side of Tauri, not other packages", () => {
    const lock = (api: string, cli: string, svelte: string) =>
      write(
        "package-lock.json",
        JSON.stringify({
          packages: {
            "node_modules/@tauri-apps/api": { version: api },
            "node_modules/@tauri-apps/cli": { version: cli },
            "node_modules/svelte": { version: svelte },
          },
        }),
      );
    const before = backendId(root);
    lock("2.12.1", "2.13.0", "5.1.0");
    expect(backendId(root)).toBe(before);
    lock("2.13.0", "2.13.0", "5.1.0");
    expect(backendId(root)).not.toBe(before);
  });

  it("ignores build output, generated schemas and dotfiles", () => {
    const before = backendId(root);
    write("src-tauri/target/release/mildify", "binary");
    write("src-tauri/gen/schemas/desktop-schema.json", "{}");
    write("src-tauri/src/.DS_Store", "x");
    expect(backendId(root)).toBe(before);
  });

  it("is the same for a CRLF checkout", () => {
    const before = backendId(root);
    write("src-tauri/src/lib.rs", "fn main() {}\r\n");
    expect(backendId(root)).toBe(before);
  });
});

describe("normalise", () => {
  it("only drops the app's own version from the lock file", () => {
    const lock = `[[package]]\nname = "itoa"\nversion = "1.1.1"\n\n[[package]]\nname = "mildify"\nversion = "1.1.1"\n`;
    expect(normalise("Cargo.lock", Buffer.from(lock)).toString()).toBe(
      `[[package]]\nname = "itoa"\nversion = "1.1.1"\n\n[[package]]\nname = "mildify"\nversion = ""\n`,
    );
  });

  it("leaves other files' versions alone", () => {
    expect(normalise("src/lib.rs", Buffer.from('version = "1.1.1"\n')).toString()).toBe('version = "1.1.1"\n');
  });
});
