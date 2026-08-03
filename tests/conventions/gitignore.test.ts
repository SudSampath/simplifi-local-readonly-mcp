import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { TESTS_ROOT } from "../support/test-sources.js";

/**
 * Asserts what git actually does, not what .gitignore appears to say. Parsing the
 * file would re-implement git's precedence, negation, and directory rules — and
 * get them subtly wrong, which is the failure mode that leaves an export
 * committable while the test reports success.
 *
 * `git check-ignore` answers for paths that do not exist, so nothing is written
 * to disk here.
 */

const REPO_ROOT = path.resolve(TESTS_ROOT, "..");

function isIgnored(relativePath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", relativePath], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("Given a data export left in the working tree", () => {
  test("When git is asked, then a loose CSV is ignored", () => {
    expect(isIgnored("transactions.csv")).toBe(true);
    expect(isIgnored("some/nested/dir/spending-2026.csv")).toBe(true);
  });

  test("When git is asked, then a spreadsheet is ignored", () => {
    expect(isIgnored("budget.xlsx")).toBe(true);
    expect(isIgnored("export.tsv")).toBe(true);
  });

  test("When git is asked, then JSON dumped into an export directory is ignored", () => {
    expect(isIgnored("exports/transactions.json")).toBe(true);
    expect(isIgnored("out/response.json")).toBe(true);
    expect(isIgnored("tmp/dump.json")).toBe(true);
    expect(isIgnored("scratch/notes.json")).toBe(true);
  });

  test("When git is asked, then the local cache database is ignored in every form", () => {
    expect(isIgnored("data/cache.sqlite")).toBe(true);
    expect(isIgnored("cache.sqlite")).toBe(true);
    expect(isIgnored("cache.sqlite-wal")).toBe(true);
    expect(isIgnored("cache.db")).toBe(true);
    expect(isIgnored("cache.db-wal")).toBe(true);
  });
});

describe("Given the repo's own tracked configuration", () => {
  test("When git is asked, then package.json is not ignored", () => {
    // The blanket *.json rule this project's notes once claimed to have would
    // have hidden these. The rule is directory-scoped precisely so it cannot.
    expect(isIgnored("package.json")).toBe(false);
    expect(isIgnored("package-lock.json")).toBe(false);
    expect(isIgnored("tsconfig.json")).toBe(false);
    expect(isIgnored("tsconfig.test.json")).toBe(false);
  });

  test("When git is asked, then source and tests are not ignored", () => {
    expect(isIgnored("src/index.ts")).toBe(false);
    expect(isIgnored("tests/support/fixtures.ts")).toBe(false);
    expect(isIgnored(".github/workflows/ci.yml")).toBe(false);
  });
});

describe("Given credential files", () => {
  test("When git is asked, then .env and its variants are ignored", () => {
    expect(isIgnored(".env")).toBe(true);
    expect(isIgnored(".env.local")).toBe(true);
    expect(isIgnored(".env.production")).toBe(true);
  });

  test("When git is asked, then .env.example stays tracked so the variables are documented", () => {
    // The negation matters: without it, the one file that tells a new host which
    // variables exist would be invisible.
    expect(isIgnored(".env.example")).toBe(false);
  });
});
