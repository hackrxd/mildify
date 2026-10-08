// Checks that every platform a release is built for gets the same direct dependencies:
//   node scripts/platform-deps.mjs
// A `[target.'cfg(…)'.dependencies]` table runs to the next table, so a shared dependency written below one
// quietly becomes that platform's only, and the other builds lose it. CI tests on Linux alone; this asks Cargo
// for each release target's dependency graph, which needs no cross-compiler.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The release builds' targets (.github/workflows/build.yml). */
export const TARGETS = ["x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu"];

/** Dependencies meant for some platforms only, by name. */
export const PER_PLATFORM = new Set([]);

/** The root package's direct, normal dependencies, from `cargo metadata --filter-platform` output. */
export function directDependencies(metadata) {
  const root = metadata.resolve.nodes.find((n) => n.id === metadata.resolve.root);
  return new Set(root.deps.filter((d) => d.dep_kinds.some((k) => k.kind === null)).map((d) => d.name));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = new URL("../src-tauri/Cargo.toml", import.meta.url).pathname;
  const byTarget = {};
  for (const target of TARGETS) {
    const json = execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--filter-platform", target, "--manifest-path", manifest],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
    );
    byTarget[target] = directDependencies(JSON.parse(json));
  }
  const lacking = missing(byTarget);
  if (Object.keys(lacking).length) {
    for (const [target, deps] of Object.entries(lacking)) console.error(`${target} lacks: ${deps.join(", ")}`);
    console.error("A shared dependency may be sitting under a [target.'cfg(…)'.dependencies] table in Cargo.toml.");
    process.exit(1);
  }
  console.log(`Every release target has the same ${byTarget[TARGETS[0]].size} direct dependencies.`);
}
