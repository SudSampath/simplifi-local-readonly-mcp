import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ALLOWANCES, UNSCANNED_FILES, scanText } from "../../scripts/secret-scan.js";
import { TESTS_ROOT } from "../support/test-sources.js";

/**
 * The pre-commit hook scans what a commit adds. This scans what is already
 * committed — the whole tracked tree, every run.
 *
 * Both are needed. The hook cannot catch anything that landed before it existed,
 * and this repo inherited its entire history from upstream. If a real value is
 * ever committed, this is the assertion that keeps failing until it is dealt with
 * rather than forgotten.
 */

const REPO_ROOT = path.resolve(TESTS_ROOT, "..");

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((file) => file.length > 0 && !UNSCANNED_FILES.has(file));
}

describe("Given every file tracked in the repository", () => {
  const files = trackedFiles();

  test("When I enumerate them, then there are files to scan", () => {
    // Guards against git failing quietly and making the scan vacuous.
    expect(files.length).toBeGreaterThan(10);
  });

  test("When I scan all of them, then nothing reads as our real financial data", () => {
    const findings = files.flatMap((file) => {
      let content: string;
      try {
        content = readFileSync(path.join(REPO_ROOT, file), "utf8");
      } catch {
        return [];
      }
      return scanText(content, file);
    });

    const report = findings.map(
      (finding) => `${finding.file}:${finding.line} [${finding.rule}] ${finding.detail} — matched: ${finding.match}`,
    );

    expect(report).toEqual([]);
  });
});

describe("Given the declared scanner exceptions", () => {
  test("When I read each one, then it pins one exact value by digest rather than a whole file", () => {
    // A file-wide exception would let a different real value hide behind an
    // allowance granted for something harmless. A digest permits exactly one
    // string — no substring slop — and keeps the value itself out of the repo.
    for (const allowance of ALLOWANCES) {
      expect(allowance.matchSha256, `exception for ${allowance.file} must pin a digest`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("When I read each one, then it says what was allowed and why", () => {
    for (const allowance of ALLOWANCES) {
      const label = `${allowance.file}:${allowance.rule}`;
      expect(allowance.describes.length, `${label} must describe the value`).toBeGreaterThan(15);
      expect(allowance.reason.length, `${label} needs a reason`).toBeGreaterThan(30);
    }
  });

  test("When I look for duplicates, then no value is allowed twice", () => {
    const keys = ALLOWANCES.map((allowance) => `${allowance.file}|${allowance.rule}|${allowance.matchSha256}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  test("When I count exceptions outside the test suite, then there are very few", () => {
    // The split matters. Allowances on test files are scanner *inputs* — a rule
    // cannot be proven to fire without feeding it something that matches. Those
    // are cheap and expected. Allowances on shipped files are the ones that
    // erode the guardrail, so they are held to a much tighter budget.
    const outsideTests = ALLOWANCES.filter((allowance) => !allowance.file.startsWith("tests/"));

    expect(outsideTests.map((allowance) => `${allowance.file} — ${allowance.describes}`)).toHaveLength(2);
  });

  test("When I count them all, then the list stays reviewable by eye", () => {
    expect(ALLOWANCES.length).toBeLessThanOrEqual(15);
  });
});
