// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseNotes } from "./release-notes.mjs";

const md = `# Changelog

## Unreleased

### Added

- Next thing

## 1.2.0 - 2026-10-04

### Fixed

- A fix

## 1.1.0 - 2026-10-01

### Added

- Older
`;

describe("release notes", () => {
  it("cuts one version's section", () => {
    expect(releaseNotes(md, "1.2.0")).toBe("### Fixed\n\n- A fix");
    expect(releaseNotes(md, "1.1.0")).toBe("### Added\n\n- Older");
  });

  it("has none for a version without a section", () => {
    expect(releaseNotes(md, "1.3.0")).toBeNull();
    expect(releaseNotes(md, "1.2")).toBeNull();
    expect(releaseNotes("## 1.3.0 - 2026-10-05\n\n## 1.2.0\n- x", "1.3.0")).toBeNull();
  });

  it("has a section for the version being built", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(releaseNotes(changelog, version), `CHANGELOG.md needs a "## ${version} - <date>" section`).not.toBeNull();
  });
});
