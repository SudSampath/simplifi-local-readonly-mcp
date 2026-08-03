import { describe, expect, test } from "vitest";

import { DatabaseContext } from "../../src/db/database.js";
import { AccountService } from "../../src/services/account-service.js";
import type { SimplifiClient } from "../../src/simplifi/client.js";
import type { Account } from "../../src/types.js";

function account(overrides: Partial<Account> & { id: string }): Account {
  return { name: "Synthetic Account", type: "BANK", ...overrides };
}

describe("Given cached accounts with assets, liabilities, and exclusions", () => {
  test("When net worth is calculated, then the signed total is traceable to included and excluded accounts", () => {
    const db = new DatabaseContext(":memory:");
    try {
      db.replaceAccounts([
        account({ id: "asset", normalizedBalance: 100 }),
        account({ id: "liability", type: "CREDIT", normalizedBalance: -25 }),
        account({ id: "closed", isClosed: true, normalizedBalance: 999 }),
        account({ id: "ignored", isIgnored: true, normalizedBalance: 888 }),
        account({ id: "missing" }),
      ]);
      const service = new AccountService(db, {} as SimplifiClient);

      const report = service.netWorth();

      expect(report.totalCents).toBe(7_500);
      expect(report.totalFormatted).toBe("75.00");
      expect(report.accounts.map((line) => [line.accountId, line.valueCents, line.valueSource])).toEqual([
        ["asset", 10_000, "normalizedBalance"],
        ["liability", -2_500, "normalizedBalance"],
      ]);
      expect(report.exclusions.map((line) => [line.accountId, line.reason])).toEqual([
        ["closed", "closed"],
        ["ignored", "ignored"],
        ["missing", "no-current-value"],
      ]);
    } finally {
      db.close();
    }
  });
});
