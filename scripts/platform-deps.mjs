// Checks that every platform a release is built for gets the same direct dependencies:
//   node scripts/platform-deps.mjs
// A `[target.'cfg(…)'.dependencies]` table runs to the next table, so a shared dependency written below one
// quietly becomes that platform's only, and the other builds lose it. CI tests on Linux alone; this asks Cargo
// for each release target's dependency tree, which needs no cross-compiler.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The release builds' targets (.github/workflows/build.yml). */
export const TARGETS = ["x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu"];

/** Dependencies meant for some platforms only, by name. */
export const PER_PLATFORM = new Set([]);

/** The package's direct dependencies, from `cargo tree --depth 1 --prefix none --format {p}`: the package's own line
 * first, then one per dependency. Cargo leaves out what the target doesn't build with, by kind and by platform
 * (`cargo metadata` doesn't: it lists every way a dependency is declared once any one applies). */
export function directDependencies(tree) {
  return new Set(tree.split("\n").slice(1).map((line) => line.split(" ")[0]).filter(Boolean));
}

/** Each target's dependencies that some other target has and it lacks, leaving out the per-platform ones. */
export function missing(byTarget, perPlatform = PER_PLATFORM) {
  const all = new Set(Object.values(byTarget).flatMap((deps) => [...deps]));
  const out = {};
  for (const [target, deps] of Object.entries(byTarget)) {
    const lacks = [...all].filter((d) => !deps.has(d) && !perPlatform.has(d)).sort();
    if (lacks.length) out[target] = lacks;
  }
  return out;
}

/** Whether node was asked to run this file, by whatever path (a symlinked one included). */
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const manifest = fileURLToPath(new URL("../src-tauri/Cargo.toml", import.meta.url));
  const byTarget = {};
  for (const target of TARGETS) {
    const tree = execFileSync(
      "cargo",
      ["tree", "-e", "normal", "--target", target, "--depth", "1", "--prefix", "none", "--format", "{p}", "--manifest-path", manifest],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
    );
    byTarget[target] = directDependencies(tree);
  }
  const lacking = missing(byTarget);
  if (Object.keys(lacking).length) {
    for (const [target, deps] of Object.entries(lacking)) console.error(`${target} lacks: ${deps.join(", ")}`);
    console.error("A shared dependency may be sitting under a [target.'cfg(…)'.dependencies] table in Cargo.toml.");
    process.exit(1);
  }
  console.log(`Every release target has the same ${byTarget[TARGETS[0]].size} direct dependencies.`);
}
