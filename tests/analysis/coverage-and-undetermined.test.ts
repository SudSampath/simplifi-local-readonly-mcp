import { describe, expect, test } from "vitest";

import { monthlyBurn, spendingByCategoryByMonth } from "../../src/analysis/index.js";
import { aCachedTransaction } from "../support/fixtures.js";

/**
 * SUD-16, third and fourth acceptance criteria: say what could not be
 * determined, do not substitute an estimate, and never present a partial period
 * as complete.
 *
 * Future-dated bill projections must not become measured spending; a request can
 * begin before the cache's synthetic coverage boundary; and the current month is
 * always partial. Each case can otherwise produce a plausible but misleading zero.
 *
 * Fixtures are SYNTHETIC; see support/fixtures.ts.
 */

const HISTORY = [
  aCachedTransaction({ id: "jun-out", amountCents: -50_000, transactionDate: "2026-06-10" }),
  aCachedTransaction({ id: "jul-out", amountCents: -60_000, transactionDate: "2026-07-10" }),
  aCachedTransaction({ id: "aug-out", amountCents: -3_000, transactionDate: "2026-08-01" }),
];

/** A bill Simplifi has scheduled but which has not happened. */
const PROJECTED = aCachedTransaction({
  id: "sep-projected",
  amountCents: -70_000,
  transactionDate: "2026-09-01",
  state: "PENDING",
});

describe("Given a range that runs past today", () => {
  const report = monthlyBurn({
    transactions: [...HISTORY, PROJECTED],
    from: "2026-06-01",
    to: "2026-09-30",
    asOf: "2026-08-02",
    cachedEarliest: "2022-01-01",
    cachedLatest: "2026-08-01",
  });

  test("When the analysis runs, then future-dated rows are excluded rather than counted as spending", () => {
    const september = report.months.find((month) => month.period.month === "2026-09");

    expect(september?.net.transactionIds).toEqual([]);
    expect(report.months.flatMap((month) => month.net.transactionIds)).not.toContain("sep-projected");
  });

  test("When the analysis runs, then the projection is reported as an exclusion with its reason", () => {
    const projected = report.exclusions.find((line) => line.kind === "projected");

    expect(projected).toMatchObject({ count: 1, netCents: -70_000 });
    expect(projected?.transactionIds).toEqual(["sep-projected"]);
    expect(projected?.reason).toContain("as-of date");
  });

  test("When the analysis runs, then it states that the range reaches past what it can measure", () => {
    const shortfall = report.coverage.shortfalls.find(
      (entry) => entry.kind === "requested-range-extends-beyond-as-of",
    );

    expect(shortfall?.detail).toContain("2026-08-02");
    expect(report.coverage.complete).toBe(false);
  });

  test("When a month has not finished, then it is flagged incomplete rather than reported as a full month", () => {
    const august = report.months.find((month) => month.period.month === "2026-08");

    expect(august?.period.complete).toBe(false);
    expect(august?.period.incompleteReasons).toContain("month-not-finished");
  });

  test("When the average is computed, then the unfinished month is left out of it", () => {
    expect(report.completeMonthsUsed).toEqual(["2026-06", "2026-07"]);
    expect(report.averageMonthlyOutflowCents).toBe(-55_000);
  });
});

describe("Given a range only partly covered by the cache", () => {
  const report = spendingByCategoryByMonth({
    transactions: HISTORY,
    from: "2019-01-01",
    to: "2026-08-02",
    asOf: "2026-08-02",
    cachedEarliest: "2022-01-01",
    cachedLatest: "2026-08-01",
  });

  test("When an aggregation runs over it, then the response states the range actually covered", () => {
    expect(report.coverage.requested).toEqual({ from: "2019-01-01", to: "2026-08-02" });
    expect(report.coverage.covered).toEqual({ from: "2022-01-01", to: "2026-08-01" });
  });

  test("When an aggregation runs over it, then the shortfall at each end is flagged", () => {
    const kinds = report.coverage.shortfalls.map((entry) => entry.kind);

    expect(kinds).toContain("cache-starts-after-requested-from");
    expect(kinds).toContain("cache-ends-before-requested-to");
    expect(report.coverage.complete).toBe(false);
  });

  test("When an aggregation runs over it, then the shortfall is also stated as something undetermined", () => {
    // A caller reading only `undetermined` must not miss it, and a caller
    // reading only `coverage` must not either.
    const undetermined = report.undetermined.filter((entry) => entry.what.includes("not fully covered"));

    expect(undetermined.length).toBe(report.coverage.shortfalls.length);
    expect(undetermined[0]?.why).toContain("2022-01-01");
  });

  test("When a month precedes the cache, then it is flagged rather than reported as a month of no spending", () => {
    const before = report.months.find((month) => month.period.month === "2019-01");

    expect(before?.total.totalCents).toBe(0);
    expect(before?.period.complete).toBe(false);
    expect(before?.period.incompleteReasons).toContain("month-starts-before-cache-coverage");
  });
});

describe("Given a range in which no month is both finished and fully cached", () => {
  const report = monthlyBurn({
    transactions: [aCachedTransaction({ id: "aug-out", amountCents: -3_000, transactionDate: "2026-08-01" })],
    from: "2026-08-01",
    to: "2026-08-31",
    asOf: "2026-08-02",
    cachedEarliest: "2022-01-01",
    cachedLatest: "2026-08-01",
  });

  test("When the average is requested, then no figure is given rather than one extrapolated from two days", () => {
    expect(report.averageMonthlyOutflowCents).toBeUndefined();
    expect(report.averageMonthlyOutflowFormatted).toBeUndefined();
    expect(report.completeMonthsUsed).toEqual([]);
  });

  test("When no average is given, then the response says so and says why", () => {
    const undetermined = report.undetermined.find((entry) => entry.what.includes("Average monthly outflow"));

    expect(undetermined?.why).toContain("partial month");
  });

  test("When the month's own figures are reported, then they are still returned, marked incomplete", () => {
    // "Incomplete" is not "unavailable". Two days of August is a real fact about
    // two days of August.
    const august = report.months[0];

    expect(august?.outflow.totalCents).toBe(-3_000);
    expect(august?.period.complete).toBe(false);
  });
});

describe("Given a transaction with no usable date", () => {
  const report = spendingByCategoryByMonth({
    transactions: [
      ...HISTORY,
      aCachedTransaction({ id: "undated", amountCents: -1_500, transactionDate: undefined }),
    ],
    from: "2026-06-01",
    to: "2026-07-31",
    asOf: "2026-08-02",
    cachedEarliest: "2022-01-01",
    cachedLatest: "2026-08-01",
  });

  test("When the analysis runs, then it is excluded and reported rather than dropped by the range filter", () => {
    const undated = report.exclusions.find((line) => line.kind === "undated");

    expect(undated).toMatchObject({ count: 1, netCents: -1_500 });
    expect(undated?.transactionIds).toEqual(["undated"]);
  });

  test("When the analysis runs, then it appears in no month's figures", () => {
    expect(report.months.flatMap((month) => month.total.transactionIds)).not.toContain("undated");
  });
});

describe("Given an empty cache", () => {
  const report = monthlyBurn({
    transactions: [],
    from: "2026-01-01",
    to: "2026-03-31",
    asOf: "2026-08-02",
  });

  test("When an aggregation runs, then the zeros are labelled as absent data rather than as no spending", () => {
    const shortfall = report.coverage.shortfalls.find((entry) => entry.kind === "cache-is-empty");

    expect(shortfall?.detail).toContain("for want of data");
    expect(report.coverage.covered).toEqual({});
    expect(report.months.every((month) => month.period.complete === false)).toBe(true);
  });
});
