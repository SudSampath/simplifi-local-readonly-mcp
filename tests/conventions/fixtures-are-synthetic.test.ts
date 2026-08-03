import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { TESTS_ROOT, relativeToTests } from "../support/test-sources.js";

/**
 * The privacy rule covers test data. A fixture pasted from a real Simplifi
 * response is a real transaction committed to a git history that outlives every
 * later decision about this repo.
 *
 * Two mechanical checks here:
 *   1. Anything acting as a fixture declares its provenance as SYNTHETIC, so a
 *      reviewer never has to guess where a value came from.
 *   2. No long digit run anywhere under tests/, because that is what a real
 *      account number, routing number, or card number looks like.
 *
 * Institution-name scanning is deliberately NOT here — it belongs to the
 * commit-time scanner in SUD-7, which sees the whole staged diff rather than
 * only this directory.
 */

const PROVENANCE_MARKER = "SYNTHETIC";
/** Eight or more consecutive digits — an account or card number shape. */
const LONG_DIGIT_RUN = /\d{8,}/;

function filesUnderTests(predicate: (relativePath: string) => boolean): string[] {
  return readdirSync(TESTS_ROOT, { recursive: true, encoding: "utf8" })
    .map((entry) => path.join(TESTS_ROOT, entry))
    .filter((absolutePath) => absolutePath.endsWith(".ts") || absolutePath.endsWith(".json"))
    .filter((absolutePath) => predicate(relativeToTests(absolutePath)))
    .sort();
}

describe("Given every fixture file in the suite", () => {
  const fixtureFiles = filesUnderTests(
    (relativePath) => relativePath.includes("fixtures") || relativePath.endsWith(".json"),
  );

  test("When I look for fixture files, then at least one exists to check", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  test("When I read each fixture file, then it declares its provenance as synthetic", () => {
    const undeclared = fixtureFiles
      .filter((absolutePath) => !readFileSync(absolutePath, "utf8").includes(PROVENANCE_MARKER))
      .map(relativeToTests);

    expect(undeclared, `every fixture must state ${PROVENANCE_MARKER} provenance`).toEqual([]);
  });
});

// The account-number-shape scan that used to live here has moved to
// conventions/no-real-data-committed.test.ts, which covers the whole tracked tree
// rather than only tests/.
//
// It was removed rather than relocated as-is: it skipped entire files that needed
// to contain the pattern in order to test against it, and a whole-file skip is a
// hole — a real account number pasted into one of those files would have passed.
// The replacement declares narrow allowances naming the exact permitted value, so
// one known-safe literal cannot shelter a different one in the same file.
