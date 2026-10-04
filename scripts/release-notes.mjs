// Prints a release's section of CHANGELOG.md, for its GitHub release notes:
//   node scripts/release-notes.mjs 1.2.0
// Fails when the changelog has no section for that version, so a release can't go out without one.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The body of `## <version>`, up to the next `## `, or null if there's none or it's empty. */
export function releaseNotes(changelog, version) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l.trimEnd() === `## ${version}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = (process.argv[2] ?? "").replace(/^v/, "");
  const notes = releaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no section for ${version || "(no version given)"}`);
    process.exit(1);
  }
  console.log(notes);
}
