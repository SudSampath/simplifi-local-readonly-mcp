import { describe, expect, test } from "vitest";

import { aTransaction, someTransactions } from "../support/fixtures.js";

/**
 * The template. Copy this shape when writing tests for a real ticket.
 *
 * Three things it demonstrates:
 *   - Given/When/Then in the names, so a CI failure reads as a violated
 *     behavior rather than as a function name.
 *   - Fixtures built from the synthetic factory, overriding only the fields the
 *     test is actually about.
 *   - One behavior per test, so a failure localises to one claim.
 *
 * It asserts against the fixture factory itself, which is the only production
 * code that exists at this point in the project. Ticket tests replace that with
 * the module under examination.
 */

describe("Given the synthetic transaction factory", () => {
  test("When I build a transaction without overrides, then it returns a complete synthetic record", () => {
    const transaction = aTransaction();

    expect(transaction.id).toBe("txn-synthetic-0001");
    expect(transaction.accountId).toBe("acct-teal");
    expect(transaction.state).toBe("POSTED");
  });

  test("When I override one field, then only that field changes", () => {
    const transaction = aTransaction({ amount: -19.99 });

    expect(transaction.amount).toBe(-19.99);
    expect(transaction.payee).toBe(aTransaction().payee);
  });

  test("When I override the nested category, then the other category fields survive", () => {
    const transaction = aTransaction({ coa: { id: "cat-groceries" } as { type: string; id: string } });

    expect(transaction.coa.id).toBe("cat-groceries");
    expect(transaction.coa.type).toBe("CATEGORY");
  });

  describe("And I need a series rather than a single record", () => {
    test("When I request three transactions, then each has a distinct id", () => {
      const transactions = someTransactions(3);

      const ids = transactions.map((transaction) => transaction.id);

      expect(ids).toEqual(["txn-synthetic-0001", "txn-synthetic-0002", "txn-synthetic-0003"]);
      expect(new Set(ids).size).toBe(3);
    });

    test("When I request a series with an override, then every record carries it", () => {
      const transactions = someTransactions(2, { accountId: "acct-amber" });

      expect(transactions.every((transaction) => transaction.accountId === "acct-amber")).toBe(true);
    });
  });
});
