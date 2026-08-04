import { describe, expect, test } from "vitest";

import { formatFindings, scanText } from "../../scripts/secret-scan.js";

/**
 * The scanner runs in two places that fail for different reasons: the
 * pre-commit hook, where the problem is in the index, and CI, where it is in a
 * commit range that is already pushed. A report that says "staged changes" to
 * someone reading a pull request check log names the wrong thing to go fix.
 */

const LEAK = "const account = 4147202233445566;";

describe("Given findings reported from the pre-commit hook", () => {
  test("When they are formatted with no subject, then the index is named", () => {
    const report = formatFindings(scanText(LEAK, "src/example.ts"));

    expect(report).toContain("staged changes");
  });
});

describe("Given findings reported from a commit range", () => {
  test("When they are formatted with that range, then the range is named", () => {
    const report = formatFindings(scanText(LEAK, "src/example.ts"), "changes in abc123..def456");

    expect(report).toContain("changes in abc123..def456");
    // "Commit rejected" was the old fixed prefix; in CI nothing is being
    // committed, so it described a step the reader is not performing.
    expect(report).not.toContain("staged changes");
  });

  test("When a finding is reported, then its file and line survive formatting", () => {
    const report = formatFindings(scanText(LEAK, "src/example.ts"), "changes in a..b");

    // The location is the actionable part of the report; a range-mode run in CI
    // is the case where the reader has no local diff to look at.
    expect(report).toContain("src/example.ts:1");
    expect(report).toContain("account-number-shape");
  });
});
