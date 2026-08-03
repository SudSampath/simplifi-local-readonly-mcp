import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { monthlyBurn, recurringChargeChanges, spendingByCategoryByMonth } from "../../src/analysis/index.js";
import { TESTS_ROOT } from "../support/test-sources.js";
import { aCachedTransaction } from "../support/fixtures.js";

/**
 * SUD-16's last acceptance criterion, and the one the app depends on: every
 * aggregation is a typed function returning structured data, and no aggregation
 * logic lives in an MCP tool handler.
 *
 * The reason is drift. A front end that cannot call this code directly will grow
 * its own copy of it, and two implementations of "what counts as spending" agree
 * only until the first change to either. Keeping the arithmetic on one side of
 * this line is what makes an agent and the app answer the same question the same
 * way.
 *
 * Fixtures are SYNTHETIC; see support/fixtures.ts.
 */

const REPO_ROOT = path.resolve(TESTS_ROOT, "..");
const ANALYSIS_DIR = path.join(REPO_ROOT, "src", "analysis");
const SERVER_SOURCE = readFileSync(path.join(REPO_ROOT, "src", "mcp", "server.ts"), "utf8");

function analysisSources(): Array<{ file: string; source: string }> {
  return readdirSync(ANALYSIS_DIR, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => ({ file: entry, source: readFileSync(path.join(ANALYSIS_DIR, entry), "utf8") }));
}

const TRANSACTIONS = [
  aCachedTransaction({ id: "one", amountCents: -1_000, transactionDate: "2026-01-05" }),
  aCachedTransaction({ id: "two", amountCents: -2_000, transactionDate: "2026-02-05" }),
];

const RANGE = {
  transactions: TRANSACTIONS,
  from: "2026-01-01",
  to: "2026-02-28",
  asOf: "2026-04-01",
  cachedEarliest: "2025-01-01",
  cachedLatest: "2026-03-31",
} as const;

describe("Given the analysis layer called from code that is not an MCP server", () => {
  test("When I call each aggregation directly, then it returns structured data rather than a wire format", () => {
    // No server, no transport, no database — just data in and objects out. A
    // `content: [{ type: "text" }]` wrapper here would mean the only way to
    // reach these numbers was through MCP.
    for (const report of [
      spendingByCategoryByMonth(RANGE),
      monthlyBurn(RANGE),
      recurringChargeChanges(RANGE),
    ]) {
      expect(report).toBeTypeOf("object");
      expect(report).not.toHaveProperty("content");
      expect(report.coverage.requested).toEqual({ from: "2026-01-01", to: "2026-02-28" });
      expect(report.provenance.dateField).toBe("transactionDate");
      expect(Array.isArray(report.exclusions)).toBe(true);
      expect(Array.isArray(report.undetermined)).toBe(true);
    }
  });

  test("When I call an aggregation twice with the same input, then it returns the same answer", () => {
    // Nothing in here reads a clock or a database, which is what makes the
    // as-of date a parameter rather than an ambient fact.
    expect(monthlyBurn(RANGE)).toEqual(monthlyBurn(RANGE));
  });

  test("When I read every file in the analysis layer, then none imports the database, the client, or MCP", () => {
    const offenders = analysisSources()
      .filter(({ source }) => /from "\.\.\/(db|mcp|simplifi|sync|services)\//.test(source))
      .map(({ file }) => file);

    expect(offenders, "the analysis layer must be callable without any of them").toEqual([]);
  });

  test("When I count the files scanned, then there are enough for the scan above to mean anything", () => {
    // Guard: the import scan is vacuous if the directory read finds nothing.
    expect(analysisSources().length).toBeGreaterThan(4);
  });
});

describe("Given the MCP tool handlers for the analysis tools", () => {
  /** The body of each analysis tool's handler, keyed by tool name. */
  function handlerBodies(): Map<string, string> {
    const bodies = new Map<string, string>();
    const pattern =
      /mcp\.tool\(\s*"(spending_by_category|monthly_burn|recurring_charge_changes)"[\s\S]*?async \(input: any\) => \{([\s\S]*?)\n {4}\},/g;

    for (const match of SERVER_SOURCE.matchAll(pattern)) {
      bodies.set(match[1]!, match[2]!);
    }

    return bodies;
  }

  test("When I locate them in the source, then all three are found", () => {
    // Without this the assertions below would pass by matching nothing.
    expect([...handlerBodies().keys()].sort()).toEqual([
      "monthly_burn",
      "recurring_charge_changes",
      "spending_by_category",
    ]);
  });

  test("When I read each handler, then it delegates to the service and returns, and does nothing else", () => {
    for (const [name, body] of handlerBodies()) {
      const statements = body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      expect(statements, `${name} must be an adapter, not an implementation`).toEqual([
        expect.stringMatching(/^const result = await analysisService\.\w+\(input \?\? \{\}\);$/),
        "return toToolResponse(result);",
      ]);
    }
  });

  test("When I read the whole server module, then it contains no aggregation arithmetic", () => {
    // Named tokens rather than a shape check, so logic added anywhere in the
    // file — not only inside the three handlers — is caught.
    const forbidden = ["reduce(", "sumCents", "toCents", "amountCents", "partitionSpending", "partitionTransfers"];
    const found = forbidden.filter((token) => SERVER_SOURCE.includes(token));

    expect(found, "aggregation belongs in src/analysis, not in a tool handler").toEqual([]);
  });
});
