import { describe, expect, test } from "vitest";

import { DatabaseContext } from "../../src/db/database.js";
import type { Account, ScheduledTransaction } from "../../src/types.js";

/**
 * Accounts and scheduled transactions, cached so that "what do we owe and when"
 * is answerable without a live call per question.
 *
 * Fixtures below are synthetic and exercise complete collection replacement,
 * optional statement fields, filtering, and integer money boundaries.
 */

function withDb<T>(use: (db: DatabaseContext) => T): T {
  const db = new DatabaseContext(":memory:");
  try {
    return use(db);
  } finally {
    db.close();
  }
}

function anAccount(overrides: Partial<Account> & { id: string }): Account {
  return { name: "Fictional Credit Union", type: "BANK", currency: "USD", ...overrides };
}

function aScheduled(overrides: Partial<ScheduledTransaction> & { id: string }): ScheduledTransaction {
  return {
    type: "BILL",
    dueOn: "2026-08-15",
    recurrence: { frequency: "MONTHLY", interval: 1 },
    transaction: { accountId: "acct-1", payee: "Fictional Mortgage Co", amount: -2500.5, isBill: true },
    ...overrides,
  };
}

describe("Given accounts synced from Simplifi", () => {
  test("When they are cached and read back, then every money field is integer cents", () => {
    withDb((db) => {
      db.replaceAccounts([
        anAccount({
          id: "acct-credit",
          type: "CREDIT",
          balanceAsOf: -1234.56,
          creditLimit: 10000,
          statementDueAmount: 432.1,
          statementMinPayment: 35,
        }),
      ]);

      const [account] = db.listAccounts();

      expect(account?.balanceCents).toBe(-123_456);
      expect(account?.balanceFormatted).toBe("-1234.56");
      expect(account?.creditLimitCents).toBe(1_000_000);
      expect(account?.statementDueAmountCents).toBe(43_210);
      expect(account?.statementMinPaymentCents).toBe(3_500);
      // The decimal the API sent must not be reachable by a caller.
      expect(account).not.toHaveProperty("balanceAsOf");
      expect(account).not.toHaveProperty("statementDueAmount");
    });
  });

  test("When an account carries no statement fields, then they are absent rather than zero", () => {
    // Reporting a missing statement as zero would read as a bill of nothing
    // rather than as no bill.
    withDb((db) => {
      db.replaceAccounts([anAccount({ id: "acct-bank", balanceAsOf: 100 })]);

      const [account] = db.listAccounts();

      expect(account?.statementDueAmountCents).toBeUndefined();
      expect(account?.statementDueAt).toBeUndefined();
    });
  });

  test("When a closed account exists, then it is excluded unless asked for", () => {
    withDb((db) => {
      db.replaceAccounts([anAccount({ id: "open" }), anAccount({ id: "shut", isClosed: true })]);

      expect(db.listAccounts().map((a) => a.id)).toEqual(["open"]);
      expect(db.listAccounts({ includeClosed: true }).map((a) => a.id).sort()).toEqual(["open", "shut"]);
    });
  });

  test("When a sync no longer returns an account, then the stale row is removed", () => {
    // An upsert alone would leave it behind forever, and a stale balance in a
    // net-worth total is worse than a missing one.
    withDb((db) => {
      db.replaceAccounts([anAccount({ id: "kept" }), anAccount({ id: "gone" })]);
      db.replaceAccounts([anAccount({ id: "kept" })]);

      expect(db.listAccounts().map((a) => a.id)).toEqual(["kept"]);
    });
  });

  test("When accounts are filtered by type, then only that type is returned", () => {
    withDb((db) => {
      db.replaceAccounts([
        anAccount({ id: "a-credit", type: "CREDIT" }),
        anAccount({ id: "b-bank", type: "BANK" }),
      ]);

      expect(db.listAccounts({ type: "credit" }).map((a) => a.id)).toEqual(["a-credit"]);
    });
  });

  test("When balance variants disagree, then the canonical current value follows the documented precedence", () => {
    withDb((db) => {
      db.replaceAccounts([
        anAccount({
          id: "all-fields",
          normalizedBalance: 10.01,
          onlineBalance: 20.02,
          currentBalanceAsOf: 30.03,
          balanceAsOf: 40.04,
        }),
        anAccount({ id: "online", onlineBalance: 20.02, currentBalanceAsOf: 30.03, balanceAsOf: 40.04 }),
        anAccount({ id: "current", currentBalanceAsOf: 30.03, balanceAsOf: 40.04 }),
        anAccount({ id: "balance", balanceAsOf: 40.04 }),
      ]);

      const accounts = Object.fromEntries(db.listAccounts().map((account) => [account.id, account]));

      expect(accounts["all-fields"]).toMatchObject({
        valueCents: 1_001,
        valueFormatted: "10.01",
        valueSource: "normalizedBalance",
      });
      expect(accounts.online).toMatchObject({ valueCents: 2_002, valueSource: "onlineBalance" });
      expect(accounts.current).toMatchObject({ valueCents: 3_003, valueSource: "currentBalanceAsOf" });
      expect(accounts.balance).toMatchObject({ valueCents: 4_004, valueSource: "balanceAsOf" });
    });
  });

  test("When normalized balance is zero, then zero is a value rather than a missing field", () => {
    withDb((db) => {
      db.replaceAccounts([anAccount({ id: "zero", normalizedBalance: 0, onlineBalance: 99 })]);

      expect(db.listAccounts()[0]).toMatchObject({
        valueCents: 0,
        valueFormatted: "0.00",
        valueSource: "normalizedBalance",
      });
    });
  });
});

describe("Given scheduled transactions synced from Simplifi", () => {
  test("When they are read back, then the amount is integer cents and the decimal is gone", () => {
    withDb((db) => {
      db.replaceScheduledTransactions([aScheduled({ id: "sched-1" })]);

      const [scheduled] = db.listScheduledTransactions();

      expect(scheduled?.transaction?.amountCents).toBe(-250_050);
      expect(scheduled?.transaction?.amountFormatted).toBe("-2500.50");
      expect(scheduled?.transaction).not.toHaveProperty("amount");
    });
  });

  test("When a date range is given, then only entries due inside it are returned, soonest first", () => {
    withDb((db) => {
      db.replaceScheduledTransactions([
        aScheduled({ id: "later", dueOn: "2026-09-01" }),
        aScheduled({ id: "sooner", dueOn: "2026-08-05" }),
        aScheduled({ id: "past", dueOn: "2026-07-01" }),
      ]);

      const upcoming = db.listScheduledTransactions({ from: "2026-08-01", to: "2026-09-30" });

      expect(upcoming.map((s) => s.id)).toEqual(["sooner", "later"]);
    });
  });

  test("When entries are filtered by type, then bills and subscriptions are distinguishable", () => {
    withDb((db) => {
      db.replaceScheduledTransactions([
        aScheduled({ id: "bill", type: "BILL" }),
        aScheduled({ id: "sub", type: "SUBSCRIPTION" }),
        aScheduled({ id: "xfer", type: "TRANSFER" }),
      ]);

      expect(db.listScheduledTransactions({ type: "SUBSCRIPTION" }).map((s) => s.id)).toEqual(["sub"]);
    });
  });

  test("When an entry is completed, then it is excluded unless asked for", () => {
    withDb((db) => {
      db.replaceScheduledTransactions([
        aScheduled({ id: "pending" }),
        aScheduled({ id: "done", isCompleted: true }),
      ]);

      expect(db.listScheduledTransactions().map((s) => s.id)).toEqual(["pending"]);
      expect(db.listScheduledTransactions({ includeCompleted: true }).map((s) => s.id).sort()).toEqual([
        "done",
        "pending",
      ]);
    });
  });

  test("When a sync no longer returns an entry, then the stale row is removed", () => {
    withDb((db) => {
      db.replaceScheduledTransactions([aScheduled({ id: "kept" }), aScheduled({ id: "cancelled" })]);
      db.replaceScheduledTransactions([aScheduled({ id: "kept" })]);

      expect(db.listScheduledTransactions().map((s) => s.id)).toEqual(["kept"]);
    });
  });

  test("When an entry carries a due timestamp rather than a date, then range comparison still works", () => {
    withDb((db) => {
      db.replaceScheduledTransactions([aScheduled({ id: "stamped", dueOn: "2026-08-15T09:00:00Z" })]);

      expect(db.listScheduledTransactions({ from: "2026-08-01", to: "2026-08-31" }).map((s) => s.id)).toEqual([
        "stamped",
      ]);
    });
  });
});

describe("Given an account whose every money-shaped field is populated", () => {
  test("When it is read back, then no field holding money is still a decimal", () => {
    // Asserted generically so a newly added money field cannot bypass conversion
    // and reach callers as a float.
    withDb((db) => {
      db.replaceAccounts([
        anAccount({
          id: "acct-full",
          type: "CREDIT",
          balanceAsOf: -1234.56,
          currentBalanceAsOf: -1200.01,
          onlineBalance: -1199.99,
          creditLimit: 10000,
          statementDueAmount: 432.1,
          statementMinPayment: 35,
          statementPastDueAmount: 12.34,
          statementCloseBalance: 987.65,
          statementLastPaymentAmount: 500.25,
          normalizedBalance: -1234.56,
          goalBalance: 250.75,
        }),
      ]);

      const [account] = db.listAccounts();
      const leaked = Object.entries(account ?? {}).filter(
        ([key, value]) =>
          typeof value === "number" &&
          /amount|balance|payment|limit/i.test(key) &&
          !key.endsWith("Cents") &&
          !Number.isInteger(value),
      );

      expect(leaked, "money must reach callers as integer cents").toEqual([]);
      expect(account?.statementLastPaymentAmountCents).toBe(50_025);
      expect(account?.normalizedBalanceCents).toBe(-123_456);
      expect(account?.goalBalanceCents).toBe(25_075);
    });
  });
});

describe("Given the cached schema for the new tables", () => {
  test("When I inspect their money columns, then none is REAL", () => {
    withDb((db) => {
      const schema = db.describeSchema();
      const offenders: string[] = [];

      for (const table of ["accounts", "scheduled_transactions"]) {
        for (const column of schema.columns[table] ?? []) {
          if (/amount|balance|payment|limit/i.test(column.name) && column.type === "REAL") {
            offenders.push(`${table}.${column.name}`);
          }
        }
      }

      expect(offenders).toEqual([]);
      expect(schema.tables).toContain("accounts");
      expect(schema.tables).toContain("scheduled_transactions");
    });
  });
});
