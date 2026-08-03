import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { LOCAL_CONFIG_FILE, loadLocalInstitutions, scanText, scanUnifiedDiff } from "../../scripts/secret-scan.js";
import { TESTS_ROOT } from "../support/test-sources.js";

const REPO_ROOT = path.resolve(TESTS_ROOT, "..");

/**
 * The scanner is the last cheap net before a real value becomes permanent in git
 * history. Both directions matter: a scanner that misses the mistake is useless,
 * and one that fires on ordinary code trains people to bypass it — which is
 * worse, because then it catches nothing while looking like it does.
 */

describe("Given content containing an account-number shape", () => {
  test("When I scan it, then the long digit run is reported with its location", () => {
    const findings = scanText("const account = 4147202233445566;", "src/example.ts");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("account-number-shape");
    expect(findings[0]?.file).toBe("src/example.ts");
    expect(findings[0]?.line).toBe(1);
  });

  test("When the digits are only seven long, then it is not reported", () => {
    expect(scanText("const port = 1234567;")).toEqual([]);
  });

  describe("And the digits are part of ordinary code", () => {
    test("When I scan a timestamp in milliseconds, then it is still reported as a shape", () => {
      // Deliberate: a 13-digit epoch does match. Accepting this false positive
      // keeps the rule simple, and the fix at the call site is to write
      // 1_700_000_000_000 or Date.now() rather than to weaken the scan.
      expect(scanText("const t = 1700000000000;")).toHaveLength(1);
    });

    test("When digits are grouped with underscores, then it is not reported", () => {
      expect(scanText("const t = 1_700_000_000_000;")).toEqual([]);
    });

    test("When digits are separated by hyphens, then it is not reported", () => {
      expect(scanText("const id = 'txn-2026-01-15-0001';")).toEqual([]);
    });
  });
});

/**
 * The leak this rule was written for: real net totals from the live account were
 * written into source comments to justify a classification rule, and every
 * existing rule looked straight past them. A formatted amount is neither an 8+
 * digit run nor a credential-shaped literal.
 *
 * The cents are the signal. A total measured from a real account carries
 * arbitrary cents; an illustrative stand-in is written round. That makes the
 * convention self-enforcing instead of a growing list of exceptions.
 */
describe("Given a currency amount in a source comment", () => {
  test("When its cents are not round, then it is reported as a measured total", () => {
    const findings = scanText("// 1,432 rows netting +$123,456.78 in total", "src/example.ts");
    const amount = findings.find((finding) => finding.rule === "measured-currency-amount");

    expect(amount?.file).toBe("src/example.ts");
    expect(amount?.line).toBe(1);
  });

  test("When the amount is round, then it passes as an illustrative stand-in", () => {
    expect(scanText("// netting a large positive sum (illustrative: +$500,000.00)")).toEqual([]);
  });

  test("When a large amount has no separator but odd cents, then it is still reported", () => {
    expect(scanText("// drops $7321.46 from spending").map((finding) => finding.rule)).toContain(
      "measured-currency-amount",
    );
  });

  test("When the amount is small, then it is left alone as ordinary arithmetic", () => {
    // Money-formatting tests are full of these. A scanner that flags them gets
    // bypassed, which is strictly worse than no scanner.
    expect(scanText("expect(formatCents(-1234 as Cents)).toBe('-$12.34');")).toEqual([]);
  });

  test("When dataset counts appear without an amount, then they are still reported as household data", () => {
    const findings = scanText("// 1,432 BALANCE_ADJUSTMENT rows, 2,276 reciprocal legs");

    expect(findings.map((finding) => finding.rule)).toEqual([
      "dataset-derived-count",
      "dataset-derived-count",
    ]);
  });
});

describe("Given institution names supplied by local configuration", () => {
  // Invented institutions, passed in explicitly. The scanner ships no household
  // names — committing the list of banks we use would leak exactly the identifying
  // detail the scanner exists to catch — so the rule is covered with names that
  // belong to nobody. See .secret-scan.local.example.json.
  const institutions = ["Bank of Testville", "Nonexistent Credit Union"];

  test("When content names a configured institution, then it is reported", () => {
    const findings = scanText("payee: 'BANK OF TESTVILLE AUTOPAY'", "tests/support/fixtures.ts", 1, { institutions });

    expect(findings.map((finding) => finding.rule)).toContain("institution-name");
  });

  test("When the name appears in different casing, then it is still reported", () => {
    expect(scanText("bank of testville", "<input>", 1, { institutions }).map((finding) => finding.rule)).toContain(
      "institution-name",
    );
  });

  test("When a word merely contains a configured name as a substring, then it is not reported", () => {
    // Word boundaries, using an invented name whose prefix is a common word.
    expect(scanText("const testvillager = 1;", "<input>", 1, { institutions: ["Testville"] })).toEqual([]);
  });

  test("When no institutions are configured, then the rule contributes nothing", () => {
    // This is the state of a fresh clone and of CI. Documented rather than
    // pretended away: institution detection is a local-machine capability.
    expect(scanText("Bank of Testville", "<input>", 1, { institutions: [] })).toEqual([]);
  });

  test("When a configured name contains regex metacharacters, then it is matched literally", () => {
    const findings = scanText("paid to A.B. Savings (Holdings)", "<input>", 1, {
      institutions: ["A.B. Savings (Holdings)"],
    });

    expect(findings.map((finding) => finding.rule)).toContain("institution-name");
  });
});

describe("Given the local configuration loader", () => {
  test("When the config file is absent, then it returns no institutions rather than throwing", () => {
    expect(loadLocalInstitutions(path.join(REPO_ROOT, "tests", "support"))).toEqual([]);
  });

  test("When the config file is malformed, then it returns no institutions and says so", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "secret-scan-config-"));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeFileSync(path.join(directory, LOCAL_CONFIG_FILE), "{ not valid json", "utf8");

      expect(loadLocalInstitutions(directory)).toEqual([]);
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("could not be parsed"));
    } finally {
      stderrWrite.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("When the config file lists institutions, then they are returned", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "secret-scan-config-"));
    try {
      writeFileSync(
        path.join(directory, LOCAL_CONFIG_FILE),
        JSON.stringify({ institutions: ["Bank of Testville", "  "] }),
        "utf8",
      );

      // Blank entries are dropped: one empty string in the list would otherwise
      // build a regex that matches everywhere.
      expect(loadLocalInstitutions(directory)).toEqual(["Bank of Testville"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Given a pasted .env line assigning a credential", () => {
  test("When a real-looking secret is assigned, then it is reported", () => {
    const findings = scanText("SIMPLIFI_PASSWORD=hunter2-correct-horse");

    expect(findings.map((finding) => finding.rule)).toContain("credential-literal-env");
  });

  test("When the value is an obvious placeholder, then it is not reported", () => {
    expect(scanText("SIMPLIFI_PASSWORD=your-simplifi-password")).toEqual([]);
    expect(scanText("OAUTH_JWT_SECRET=replace-with-a-long-random-secret")).toEqual([]);
    expect(scanText("OAUTH_LOGIN_PASSWORD=change-me")).toEqual([]);
  });

  test("When the value is too short to be a real secret, then it is not reported", () => {
    expect(scanText("OAUTH_JWT_SECRET=abc")).toEqual([]);
  });
});

describe("Given source code assigning a credential to a quoted literal", () => {
  test("When the literal looks real, then it is reported", () => {
    const findings = scanText('const password = "hunter2correcthorse";');

    expect(findings.map((finding) => finding.rule)).toContain("credential-literal-quoted");
  });

  test("When the value reads from the environment, then it is not reported", () => {
    expect(scanText("const password = process.env.SIMPLIFI_PASSWORD;")).toEqual([]);
    expect(scanText("password: ${SIMPLIFI_PASSWORD}")).toEqual([]);
  });
});

describe("Given ordinary source that merely mentions tokens", () => {
  test("When credentials are passed around as property references, then nothing is reported", () => {
    // An earlier, looser version of the credential rule flagged 17 lines like
    // these across src/. A scanner that cries wolf gets bypassed, which is
    // strictly worse than no scanner — so these cases are pinned as negatives.
    const ordinary = [
      "accessToken: row.access_token,",
      "refreshToken: row.refresh_token,",
      "access_token = excluded.access_token,",
      "const refreshToken = randomToken(48);",
      "public async exchangeRefreshToken(refreshToken: string): Promise<void> {",
      "password: this.config.password,",
      "const accessToken = jwt.sign(accessPayload, secret);",
    ].join("\n");

    expect(scanText(ordinary)).toEqual([]);
  });
});

describe("Given ordinary source from this repo", () => {
  test("When I scan a typical line, then nothing is reported", () => {
    const ordinary = [
      'import { describe, expect, test } from "vitest";',
      "const limit = 200;",
      'url.searchParams.set("limit", String(input.limit ?? this.config.pageLimit));',
      "export interface Transaction { id: string; amount?: number }",
    ].join("\n");

    expect(scanText(ordinary)).toEqual([]);
  });
});

describe("Given a staged unified diff", () => {
  const institutions = ["Bank of Testville"];
  const diff = [
    "diff --git a/src/leak.ts b/src/leak.ts",
    "--- a/src/leak.ts",
    "+++ b/src/leak.ts",
    "@@ -10,0 +11,2 @@",
    "+  payee: 'BANK OF TESTVILLE AUTOPAY',",
    "+  accountId: '9988776655443322',",
  ].join("\n");

  test("When I scan it, then added lines are reported against the right file", () => {
    const findings = scanUnifiedDiff(diff, { institutions });

    expect(findings.length).toBeGreaterThan(0);
    expect(new Set(findings.map((finding) => finding.file))).toEqual(new Set(["src/leak.ts"]));
  });

  test("When I scan it, then line numbers come from the hunk header", () => {
    const findings = scanUnifiedDiff(diff, { institutions });

    expect(findings.find((finding) => finding.rule === "institution-name")?.line).toBe(11);
    expect(findings.find((finding) => finding.rule === "account-number-shape")?.line).toBe(12);
  });

  test("When a sensitive value appears only on a removed line, then it is not reported", () => {
    // Removing a bad value must not be blocked by the hook that wanted it gone.
    const removal = [
      "--- a/tests/support/fixtures.ts",
      "+++ b/tests/support/fixtures.ts",
      "@@ -11,1 +11,0 @@",
      "-  accountId: '4147202233445566',",
    ].join("\n");

    expect(scanUnifiedDiff(removal)).toEqual([]);
  });

  test("When the diff is empty, then nothing is reported", () => {
    expect(scanUnifiedDiff("")).toEqual([]);
  });
});

/**
 * The second form of the same leak. `measured-currency-amount` was written first
 * and missed a test header that named a seven-figure sum in words: no currency
 * symbol, no digits to key on. A magnitude in words discloses the size of an
 * account exactly as the figure does.
 */
describe("Given a money magnitude written in words", () => {
  test("When prose names an amount in words, then it is reported", () => {
    const findings = scanText("// 1,432 rows netting nearly a million dollars", "tests/example.test.ts");

    expect(findings.map((finding) => finding.rule)).toContain("money-magnitude-in-prose");
  });

  test("When a row count appears without a magnitude, then it is still reported", () => {
    expect(
      scanText("// 1,432 balance adjustments netting a large positive sum").map((finding) => finding.rule),
    ).toContain("dataset-derived-count");
  });

  test("When prose names a cache boundary, then it is reported as household history", () => {
    expect(scanText("// the cache starts at 2021-11-10").map((finding) => finding.rule)).toContain(
      "dataset-derived-boundary",
    );
  });
});
