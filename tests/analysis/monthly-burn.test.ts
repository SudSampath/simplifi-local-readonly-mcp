import { describe, expect, test } from "vitest";

import { monthlyBurn } from "../../src/analysis/index.js";
import type { CachedTransaction } from "../../src/types.js";
import { aCachedTransaction, aCachedTransferPair } from "../support/fixtures.js";

/**
 * SUD-16, second acceptance criterion: a burn figure excludes transfers, says so,
 * and states the date field and range it used.
 *
 * The date field is not a formality. Settlement and transaction dates can land
 * in different months, so a burn number that does not name its date field has
 * month boundaries that cannot be checked.
 *
 * Fixtures are SYNTHETIC; see support/fixtures.ts.
 */

const SPENDING = [
  aCachedTransaction({ id: "jan-out-1", amountCents: -30_000, transactionDate: "2026-01-05" }),
  aCachedTransaction({ id: "jan-out-2", amountCents: -12_500, transactionDate: "2026-01-20" }),
  aCachedTransaction({ id: "jan-in", amountCents: 250_000, transactionDate: "2026-01-31" }),
  aCachedTransaction({ id: "feb-out", amountCents: -44_000, transactionDate: "2026-02-14" }),
  aCachedTransaction({ id: "feb-in", amountCents: 250_000, transactionDate: "2026-02-28" }),
];

const TRANSFER = aCachedTransferPair({
  outId: "jan-transfer-out",
  inId: "jan-transfer-in",
  amountCents: 100_000,
  transactionDate: "2026-01-15",
});

function burn(transactions: readonly CachedTransaction[] = [...SPENDING, ...TRANSFER]) {
  return monthlyBurn({
    transactions,
    from: "2026-01-01",
    to: "2026-02-28",
    asOf: "2026-04-01",
    cachedEarliest: "2025-06-01",
    cachedLatest: "2026-03-31",
  });
}

describe("Given a monthly burn query over a range containing a transfer", () => {
  test("When it returns a figure, then neither leg of the transfer is counted in it", () => {
    const january = burn().months.find((month) => month.period.month === "2026-01");

    expect(january?.outflow.transactionIds.sort()).toEqual(["jan-out-1", "jan-out-2"]);
    expect(january?.inflow.transactionIds).toEqual(["jan-in"]);
    expect(january?.outflow.totalCents).toBe(-42_500);
  });

  test("When it returns a figure, then the exclusion is reported with its count and net", () => {
    const transfers = burn().exclusions.find((line) => line.kind === "transfer");

    expect(transfers).toMatchObject({ count: 2, netCents: 0 });
    expect(transfers?.transactionIds.sort()).toEqual(["jan-transfer-in", "jan-transfer-out"]);
  });

  test("When nothing was excluded, then the exclusion list is empty rather than missing", () => {
    const exclusions = burn(SPENDING).exclusions;

    expect(Array.isArray(exclusions)).toBe(true);
    expect(exclusions).toEqual([]);
  });

  test("When it returns a figure, then the response states which date field it grouped by", () => {
    const provenance = burn().provenance;

    expect(provenance.dateField).toBe("transactionDate");
    expect(provenance.dateFieldSources["cpData.txnOn"]).toBe(5);
    expect(provenance.dateFieldSources.postedOn).toBe(0);
  });

  test("When a transaction fell back to the settlement date, then the response says how many did", () => {
    // Missing connected-provider data makes the settlement-date fallback
    // necessary, and a reader is entitled to know how much of a total rests on it.
    const fellBack = aCachedTransaction({
      id: "jan-manual",
      amountCents: -1_000,
      transactionDate: "2026-01-08",
      transactionDateSource: "postedOn",
    });

    expect(burn([...SPENDING, fellBack]).provenance.dateFieldSources.postedOn).toBe(1);
  });

  test("When it returns a figure, then the response states the date range it used", () => {
    expect(burn().provenance).toMatchObject({
      requestedFrom: "2026-01-01",
      requestedTo: "2026-02-28",
      asOf: "2026-04-01",
    });
  });

  test("When the outflow and inflow are added, then they reproduce the reported net exactly", () => {
    for (const month of burn().months) {
      expect(month.outflow.totalCents + month.inflow.totalCents).toBe(month.net.totalCents);
    }
  });

  test("When the range is bounded, then a transaction outside it is not counted", () => {
    const stray = aCachedTransaction({ id: "dec-out", amountCents: -99_000, transactionDate: "2025-12-31" });
    const months = burn([...SPENDING, stray]).months;

    expect(months.flatMap((month) => month.net.transactionIds)).not.toContain("dec-out");
  });
});

describe("Given a range whose months are all finished and fully cached", () => {
  test("When the average monthly outflow is computed, then it is taken over exactly those months", () => {
    const report = burn();

    expect(report.completeMonthsUsed).toEqual(["2026-01", "2026-02"]);
    // (-42,500 + -44,000) / 2
    expect(report.averageMonthlyOutflowCents).toBe(-43_250);
    expect(report.averageMonthlyOutflowFormatted).toBe("-432.50");
  });

  test("When the average is reported, then it is an integer number of cents", () => {
    // Three months of an odd total is where a float would appear if one could.
    const report = monthlyBurn({
      transactions: [
        aCachedTransaction({ id: "a", amountCents: -1_001, transactionDate: "2026-01-05" }),
        aCachedTransaction({ id: "b", amountCents: -1_000, transactionDate: "2026-02-05" }),
        aCachedTransaction({ id: "c", amountCents: -1_000, transactionDate: "2026-03-05" }),
      ],
      from: "2026-01-01",
      to: "2026-03-31",
      asOf: "2026-05-01",
      cachedEarliest: "2025-01-01",
      cachedLatest: "2026-04-30",
    });

    expect(Number.isSafeInteger(report.averageMonthlyOutflowCents)).toBe(true);
    expect(report.averageMonthlyOutflowCents).toBe(-1_000);
  });
});
