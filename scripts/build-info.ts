// What a built UI needs from the binary it runs in. Every build writes it to dist/build.json, and
// src-tauri/src/ui.rs reads it to decide whether a downloaded UI can be loaded with a reload or
// the release needs the full updater and a restart.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  version: string;
  /** Hash of everything that only ships inside the binary: a UI runs only on a binary with the same one. */
  backend: string;
}

/** Build output and files tauri-build generates, which aren't inputs to the binary. */
const SKIP_DIRS = new Set(["target", "gen"]);

/** `src-tauri` files, relative and with `/` separators, sorted. Dotfiles (`.DS_Store`, editor swap files) are skipped. */
function backendFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!prefix && SKIP_DIRS.has(entry.name)) continue;
      files.push(...backendFiles(dir, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

/**
 * Drops the app's own version where a release bumps it, so a release that changes nothing else keeps the
 * hash. Line endings are normalised because Windows checkouts get CRLF.
 */
export function normalise(rel: string, contents: Buffer): Buffer {
  const text = contents.toString("latin1").replace(/\r\n/g, "\n");
  let out = text;
  if (rel === "Cargo.toml") out = text.replace(/^version = "[^"]*"$/m, 'version = ""');
  else if (rel === "Cargo.lock") out = text.replace(/(\nname = "mildify"\nversion = )"[^"]*"/, '$1""');
  else if (rel === "tauri.conf.json") out = text.replace(/"version": "[^"]*"/, '"version": ""');
  return Buffer.from(out, "latin1");
}

/**
 * The JavaScript halves of Tauri and its plugins talk to the Rust halves in the binary, so a different
 * version of one needs a different binary too.
 */
function tauriPackages(root: string): string {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  return Object.entries(lock.packages)
    .filter(([path]) => /^node_modules\/@tauri-apps\/(api|plugin-[^/]+)$/.test(path))
    .map(([path, pkg]) => `${path}@${pkg.version}`)
    .sort()
    .join("\n");
}

export function backendId(root: string): string {
  const dir = join(root, "src-tauri");
  const hash = createHash("sha256");
  for (const rel of backendFiles(dir)) {
    const digest = createHash("sha256").update(normalise(rel, readFileSync(join(dir, rel)))).digest("hex");
    hash.update(`${rel}\0${digest}\n`);
  }
  hash.update(`package-lock.json\0${tauriPackages(root)}\n`);
  return hash.digest("hex");
}

export function buildInfo(root: string): BuildInfo {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  return { version: pkg.version, backend: backendId(root) };
}
