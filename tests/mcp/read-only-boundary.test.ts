import { describe, expect, test } from "vitest";

import type { AccountService } from "../../src/services/account-service.js";
import type { AnalysisService } from "../../src/services/analysis-service.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { TransactionToolService } from "../../src/services/transaction-tool-service.js";

/**
 * The read-only boundary, asserted at the place a caller actually reaches: the
 * registered tool list.
 *
 * "No writes" is enforced by absence of capability, not by a flag or a permission
 * check — a tool that does not exist cannot be talked into firing by a mistaken or
 * adversarial prompt, and our household's real financial records are behind this
 * process. The point of testing it here is that the guarantee survives someone
 * adding a tool later without thinking about it.
 */

/**
 * The full expected tool surface. This is a snapshot on purpose: adding a tool
 * fails this test until the name is added deliberately, which is the review
 * checkpoint we want. Every entry is a read.
 */
const EXPECTED_TOOLS = [
  "get_transaction",
  "list_accounts",
  "list_categories",
  "list_credit_card_statements",
  "list_tags",
  "list_transactions",
  "list_uncategorized_transactions",
  "list_upcoming_bills",
  "monthly_burn",
  "net_worth",
  "recurring_charge_changes",
  "search_categories",
  "search_merchants",
  "search_tags",
  "search_transactions",
  "spending_by_category",
  "suggest_categories_for_merchant",
] as const;

/** Tools upstream shipped that must never come back. */
const FORBIDDEN_TOOLS = ["update_transaction", "categorize_transaction"] as const;

/**
 * Verbs that indicate a mutation. Checked against tool names so a future
 * `delete_tag` or `set_category` fails even before anyone reads its body.
 */
const MUTATING_VERBS = ["update", "create", "delete", "set", "put", "patch", "categorize", "write", "modify", "remove"];

function registeredToolNames(): string[] {
  // The service is never called — registration does not invoke handlers, and the
  // sealed environment would reject any network access if it did.
  const server = createMcpServer(
    {} as TransactionToolService,
    {} as AccountService,
    {} as AnalysisService,
    60_000,
  );
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;

  return Object.keys(registered).sort();
}

describe("Given the MCP server as it is constructed", () => {
  test("When I enumerate its tools, then the list matches the expected read-only surface exactly", () => {
    expect(registeredToolNames()).toEqual([...EXPECTED_TOOLS]);
  });

  test("When I look for the write tools upstream shipped, then neither is registered", () => {
    const names = registeredToolNames();

    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(names, `${forbidden} must not exist`).not.toContain(forbidden);
    }
  });

  test("When I check every tool name for a mutating verb, then none is present", () => {
    const offenders = registeredToolNames().filter((name) =>
      MUTATING_VERBS.some((verb) => name.split("_").includes(verb)),
    );

    expect(offenders, "tool names must not describe a mutation").toEqual([]);
  });

  test("When I count the tools, then the list is not silently empty", () => {
    // Without this, a change to how tools are registered could make every
    // assertion above pass by finding nothing at all.
    expect(registeredToolNames().length).toBe(EXPECTED_TOOLS.length);
    expect(registeredToolNames().length).toBeGreaterThan(5);
  });
});

describe("Given the transaction tool service class", () => {
  const methodNames = Object.getOwnPropertyNames(TransactionToolService.prototype).filter(
    (name) => name !== "constructor",
  );

  test("When I inspect its methods, then none is named for a mutation", () => {
    const offenders = methodNames.filter((name) =>
      MUTATING_VERBS.some((verb) => name.toLowerCase().startsWith(verb)),
    );

    expect(offenders, "no service method may describe a mutation").toEqual([]);
  });

  test("When I look for the removed write methods, then neither exists", () => {
    expect(methodNames).not.toContain("updateTransaction");
    expect(methodNames).not.toContain("categorizeTransaction");
  });

  test("When I enumerate them, then there are methods to check", () => {
    expect(methodNames.length).toBeGreaterThan(3);
  });
});
