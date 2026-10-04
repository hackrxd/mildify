import { describe, expect, it } from "vitest";
import changelog from "../../CHANGELOG.md?raw";
import { inlineCode, isNewer, parseChangelog } from "./changelog";

describe("parsing", () => {
  it("reads releases, groups and wrapped items", () => {
    const md = [
      "# Changelog",
      "",
      "Intro text, not a release.",
      "",
      "## Unreleased",
      "",
      "## 1.2.0 - 2026-10-04",
      "",
      "### Added",
      "",
      "- One line",
      "- Two lines,",
      "  wrapped",
      "",
      "### Fixed",
      "- A fix",
      "",
      "## 1.1.0",
      "- Loose item",
    ].join("\r\n");
    expect(parseChangelog(md)).toEqual([
      {
        version: "1.2.0",
        date: "2026-10-04",
        groups: [
          { title: "Added", items: ["One line", "Two lines, wrapped"] },
          { title: "Fixed", items: ["A fix"] },
        ],
      },
      { version: "1.1.0", date: null, groups: [{ title: "Changes", items: ["Loose item"] }] },
    ]);
  });

  it("parses the real changelog, newest first", () => {
    const releases = parseChangelog(changelog).filter((r) => r.version !== "Unreleased");
    expect(releases.length).toBeGreaterThan(0);
    for (const r of releases) expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (let i = 1; i < releases.length; i++) expect(isNewer(releases[i - 1].version, releases[i].version)).toBe(true);
  });
});

describe("helpers", () => {
  it("compares versions", () => {
    expect(isNewer("1.10.0", "1.9.9")).toBe(true);
    expect(isNewer("1.2.0", "1.2.0")).toBe(false);
    expect(isNewer("1.2.0", "1.10.0")).toBe(false);
    expect(isNewer("Unreleased", "9.0.0")).toBe(true);
    expect(isNewer("1.0.0", "Unreleased")).toBe(false);
    expect(isNewer("soon", "1.0.0")).toBe(false);
  });

  it("splits out code spans", () => {
    expect(inlineCode("Run `npm test` now")).toEqual([
      { text: "Run ", code: false },
      { text: "npm test", code: true },
      { text: " now", code: false },
    ]);
  });
});
