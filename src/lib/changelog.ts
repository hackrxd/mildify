// CHANGELOG.md, parsed for the What's new page. scripts/release-notes.mjs cuts the same sections for GitHub.

export interface ChangeGroup {
  /** "Added", "Changed", "Fixed", … */
  title: string;
  items: string[];
}

export interface Release {
  /** A version, or "Unreleased". */
  version: string;
  date: string | null;
  groups: ChangeGroup[];
}

export const UNRELEASED = "Unreleased";

/** `## 1.2.0 - 2026-10-04` sections of `### Added` groups of `- ` items; indented lines continue an item. */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let group: ChangeGroup | null = null;
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const release = /^## (\S+)(?:\s+-\s+(\S+))?/.exec(line);
    if (release) {
      releases.push({ version: release[1], date: release[2] ?? null, groups: [] });
      group = null;
      continue;
    }
    const current = releases.at(-1);
    if (!current) continue;
    const heading = /^### (.+)/.exec(line);
    if (heading) {
      group = { title: heading[1].trim(), items: [] };
      current.groups.push(group);
    } else if (line.startsWith("- ")) {
      if (!group) {
        group = { title: "Changes", items: [] };
        current.groups.push(group);
      }
      group.items.push(line.slice(2).trim());
    } else if (/^\s+\S/.test(line) && group?.items.length) {
      group.items[group.items.length - 1] += ` ${line.trim()}`;
    }
  }
  return releases.filter((r) => r.groups.some((g) => g.items.length));
}

/** Splits an item on `code` spans, so they can be set apart without rendering HTML. */
export function inlineCode(text: string): { text: string; code: boolean }[] {
  return text
    .split("`")
    .map((part, i) => ({ text: part, code: i % 2 === 1 }))
    .filter((part) => part.text);
}

function parts(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `a` is a later release than `b`. Unreleased comes after every version; anything unparsable, never. */
export function isNewer(a: string, b: string): boolean {
  if (a === UNRELEASED) return b !== UNRELEASED;
  const [pa, pb] = [parts(a), parts(b)];
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}
