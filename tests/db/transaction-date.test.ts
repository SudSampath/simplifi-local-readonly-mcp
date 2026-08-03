import { describe, expect, test } from "vitest";

import { DatabaseContext } from "../../src/db/database.js";
import { resolveTransactionDate } from "../../src/transaction-date.js";
import type { Transaction } from "../../src/types.js";

/**
 * `postedOn` is the settlement date. It can differ from `cpData.txnOn` and cross
 * a month boundary, so transaction-date filtering must prefer `txnOn`.
 */

const IN_MEMORY = ":memory:";

function aTransaction(overrides: Partial<Transaction> & { id: string }): Transaction {
  return { payee: "Fictional Llama Emporium", amount: -10, ...overrides };
}

function withDb<T>(use: (db: DatabaseContext) => T): T {
  const db = new DatabaseContext(IN_MEMORY);
  try {
    return use(db);
  } finally {
    db.close();
  }
}

describe("Given a transaction carrying both a settlement date and a transaction date", () => {
  test("When its date is resolved, then the transaction date wins and its source is named", () => {
    const resolved = resolveTransactionDate(
      aTransaction({ id: "a", postedOn: "2026-08-02", cpData: { txnOn: "2026-07-30" } }),
    );

    expect(resolved).toEqual({ date: "2026-07-30", source: "cpData.txnOn" });
  });

  test("When the two fall in different months, then it is attributed to the transaction date's month", () => {
    withDb((db) => {
      db.upsertTransactions([
        aTransaction({ id: "crosses-month", postedOn: "2026-08-02", cpData: { txnOn: "2026-07-30" } }),
      ]);

      const july = db.listTransactions({ limit: 10, dateFrom: "2026-07-01", dateTo: "2026-07-31" });
      const august = db.listTransactions({ limit: 10, dateFrom: "2026-08-01", dateTo: "2026-08-31" });

      expect(july.items.map((item) => item.id)).toEqual(["crosses-month"]);
      expect(august.items).toEqual([]);
    });
  });
});

describe("Given a transaction with no connected-provider data", () => {
  test("When its date is resolved, then the settlement date is used and named as the fallback", () => {
    const resolved = resolveTransactionDate(aTransaction({ id: "manual", postedOn: "2026-08-02" }));

    expect(resolved).toEqual({ date: "2026-08-02", source: "postedOn" });
  });

  test("When it is filtered by date, then the fallback still places it in a period", () => {
    // Manual entries and other rows can carry no cpData. They must not vanish
    // from filters merely because only the settlement date is available.
    withDb((db) => {
      db.upsertTransactions([aTransaction({ id: "manual", postedOn: "2026-08-02" })]);

      const found = db.listTransactions({ limit: 10, dateFrom: "2026-08-01", dateTo: "2026-08-31" });

      expect(found.items.map((item) => item.id)).toEqual(["manual"]);
    });
  });

  test("When cpData exists but carries no txnOn, then it still falls back rather than losing the date", () => {
    const resolved = resolveTransactionDate(
      aTransaction({ id: "partial", postedOn: "2026-08-02", cpData: { payee: "x" } }),
    );

    expect(resolved).toEqual({ date: "2026-08-02", source: "postedOn" });
  });

  test("When neither date is present, then it resolves to nothing rather than to today", () => {
    expect(resolveTransactionDate(aTransaction({ id: "dateless" }))).toBeUndefined();
  });
});

describe("Given a date field that arrives as a timestamp rather than a plain date", () => {
  test("When it is resolved, then it is truncated so range comparison still works", () => {
    const resolved = resolveTransactionDate(
      aTransaction({ id: "stamped", cpData: { txnOn: "2026-07-30T14:05:00Z" } }),
    );

    expect(resolved).toEqual({ date: "2026-07-30", source: "cpData.txnOn" });
  });
});

describe("Given transactions read back from the cache", () => {
  test("When they are returned, then each names the date it was filtered on", () => {
    withDb((db) => {
      db.upsertTransactions([
        aTransaction({ id: "from-provider", postedOn: "2026-08-02", cpData: { txnOn: "2026-07-30" } }),
        aTransaction({ id: "from-posted", postedOn: "2026-07-29" }),
      ]);

      const page = db.listTransactions({ limit: 10 });
      const byId = new Map(page.items.map((item) => [item.id, item]));

      expect(byId.get("from-provider")?.transactionDate).toBe("2026-07-30");
      expect(byId.get("from-provider")?.transactionDateSource).toBe("cpData.txnOn");
      expect(byId.get("from-posted")?.transactionDate).toBe("2026-07-29");
      expect(byId.get("from-posted")?.transactionDateSource).toBe("postedOn");
    });
  });

  test("When they are ordered, then ordering follows the transaction date rather than the settlement date", () => {
    withDb((db) => {
      // Settlement order is the reverse of transaction order here, so the two
      // rules produce visibly different results.
      db.upsertTransactions([
        aTransaction({ id: "happened-first", postedOn: "2026-08-10", cpData: { txnOn: "2026-07-01" } }),
        aTransaction({ id: "happened-second", postedOn: "2026-08-01", cpData: { txnOn: "2026-07-20" } }),
      ]);

      const page = db.listTransactions({ limit: 10 });

      expect(page.items.map((item) => item.id)).toEqual(["happened-second", "happened-first"]);
    });
  });
});
