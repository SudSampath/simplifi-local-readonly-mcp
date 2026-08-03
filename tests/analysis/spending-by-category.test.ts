import { describe, expect, test } from "vitest";

import { spendingByCategoryByMonth } from "../../src/analysis/index.js";
import type { TracedFigure } from "../../src/analysis/types.js";
import type { CachedTransaction } from "../../src/types.js";
import { aCachedTransaction, aCachedTransferPair } from "../support/fixtures.js";

/**
 * SUD-16, first acceptance criterion: a figure travels with the transactions
 * that produced it, and re-summing them reproduces it exactly.
 *
 * The re-summing assertion is the one that matters. It is not a restatement of
 * the implementation — it walks from the reported ids back to the fixtures and
 * adds them up independently, which is exactly what a person auditing one of
 * these numbers would do by hand.
 *
 * Fixtures are SYNTHETIC; see support/fixtures.ts.
 */

const CATEGORY_NAMES = new Map([
  ["cat-supplies", "Llama Supplies"],
  ["cat-rent", "Rent"],
]);

/** Adds up the cited ids from the source set, the way an auditor would. */
function resumFromIds(figure: TracedFigure, source: readonly CachedTransaction[]): number {
  const byId = new Map(source.map((transaction) => [transaction.id, transaction]));

  return figure.transactionIds.reduce((total, id) => {
    const transaction = byId.get(id);
    if (transaction === undefined) {
      throw new Error(`Figure cited ${id}, which is not in the source set`);
    }
    return total + (transaction.amountCents ?? 0);
  }, 0);
}

const JANUARY = [
  aCachedTransaction({ id: "jan-supplies-1", amountCents: -1_050, transactionDate: "2026-01-04" }),
  aCachedTransaction({ id: "jan-supplies-2", amountCents: -2_575, transactionDate: "2026-01-19" }),
  aCachedTransaction({
    id: "jan-rent",
    amountCents: -180_000,
    transactionDate: "2026-01-01",
    coa: { type: "CATEGORY", id: "cat-rent" },
  }),
];

const FEBRUARY = [
  aCachedTransaction({ id: "feb-supplies", amountCents: -3_333, transactionDate: "2026-02-11" }),
  aCachedTransaction({
    id: "feb-rent",
    amountCents: -180_000,
    transactionDate: "2026-02-01",
    coa: { type: "CATEGORY", id: "cat-rent" },
  }),
];

const ALL = [...JANUARY, ...FEBRUARY];

function report(transactions: readonly CachedTransaction[] = ALL) {
  return spendingByCategoryByMonth({
    transactions,
    from: "2026-01-01",
    to: "2026-02-28",
    asOf: "2026-03-15",
    cachedEarliest: "2025-01-01",
    cachedLatest: "2026-03-14",
    categoryNames: CATEGORY_NAMES,
  });
}

describe("Given a spending-by-category-by-month query", () => {
  test("When it returns a figure, then the transaction ids composing that figure come with it", () => {
    const january = report().months.find((month) => month.period.month === "2026-01");
    const supplies = january?.categories.find((category) => category.categoryId === "cat-supplies");

    expect(supplies?.figure.transactionIds.sort()).toEqual(["jan-supplies-1", "jan-supplies-2"]);
    expect(supplies?.figure.transactionCount).toBe(2);
  });

  test("When I re-sum those transactions in cents, then the total reproduces the figure exactly", () => {
    const january = report().months.find((month) => month.period.month === "2026-01");

    for (const category of january?.categories ?? []) {
      expect(resumFromIds(category.figure, ALL)).toBe(category.figure.totalCents);
    }

    expect(january?.categories.length).toBeGreaterThan(1);
  });

  test("When I re-sum the ids on a month total, then it reproduces the month total exactly", () => {
    for (const month of report().months) {
      expect(resumFromIds(month.total, ALL)).toBe(month.total.totalCents);
    }
  });

  test("When the category figures are added together, then they partition the month total exactly", () => {
    // The categories are the same transactions regrouped, so anything else means
    // a transaction was counted twice or lost between the two views.
    for (const month of report().months) {
      const summed = month.categories.reduce((total, category) => total + category.figure.totalCents, 0);
      expect(summed).toBe(month.total.totalCents);

      const cited = month.categories.flatMap((category) => category.figure.transactionIds).sort();
      expect(cited).toEqual([...month.total.transactionIds].sort());
    }
  });

  test("When a category has a name in the reference data, then the figure carries it rather than only an id", () => {
    const january = report().months.find((month) => month.period.month === "2026-01");

    expect(january?.categories.map((category) => category.categoryName)).toContain("Rent");
  });

  test("When a month in the range has no transactions, then it appears with a zero total rather than being absent", () => {
    // An absent month reads as "no data"; a zero month reads as "nothing
    // happened". Only one of those is true, and the range says which.
    const months = spendingByCategoryByMonth({
      transactions: JANUARY,
      from: "2026-01-01",
      to: "2026-03-31",
      asOf: "2026-06-01",
      cachedEarliest: "2025-01-01",
      cachedLatest: "2026-05-31",
    }).months;

    expect(months.map((month) => month.period.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(months[1]?.total.totalCents).toBe(0);
    expect(months[1]?.total.transactionIds).toEqual([]);
  });

  test("When the amounts are reported, then money is integer cents and the formatted value is a string", () => {
    const january = report().months.find((month) => month.period.month === "2026-01");

    expect(Number.isSafeInteger(january?.total.totalCents)).toBe(true);
    expect(january?.total.totalFormatted).toBe("-1836.25");
  });
});

describe("Given transactions that are not spending mixed into the range", () => {
  const withNoise = [
    ...JANUARY,
    ...aCachedTransferPair({
      outId: "jan-transfer-out",
      inId: "jan-transfer-in",
      amountCents: 50_000,
      transactionDate: "2026-01-10",
    }),
    aCachedTransaction({
      id: "jan-adjustment",
      amountCents: 120_000,
      transactionDate: "2026-01-12",
      coa: { type: "BALANCE_ADJUSTMENT", id: "adj" },
    }),
    aCachedTransaction({
      id: "jan-stock-buy",
      amountCents: -75_000,
      transactionDate: "2026-01-14",
      type: "INVESTMENT",
      coa: { type: "UNCATEGORIZED", id: "0" },
    }),
  ];

  test("When the report is produced, then none of them appears in any category figure", () => {
    const january = report(withNoise).months.find((month) => month.period.month === "2026-01");
    const cited = january?.categories.flatMap((category) => category.figure.transactionIds) ?? [];

    expect(cited).not.toContain("jan-transfer-out");
    expect(cited).not.toContain("jan-adjustment");
    expect(cited).not.toContain("jan-stock-buy");
  });

  test("When the report is produced, then the month total is unchanged by their presence", () => {
    const withoutNoise = report().months.find((month) => month.period.month === "2026-01");
    const withThem = report(withNoise).months.find((month) => month.period.month === "2026-01");

    expect(withThem?.total.totalCents).toBe(withoutNoise?.total.totalCents);
  });

  test("When the report is produced, then each kind of exclusion is reported with its count and net", () => {
    const exclusions = report(withNoise).exclusions;
    const byKind = new Map(exclusions.map((line) => [line.kind, line]));

    expect(byKind.get("transfer")).toMatchObject({ count: 2, netCents: 0 });
    expect(byKind.get("balance-adjustment")).toMatchObject({ count: 1, netCents: 120_000 });
    expect(byKind.get("investment")).toMatchObject({ count: 1, netCents: -75_000 });
    expect(byKind.get("balance-adjustment")?.transactionIds).toEqual(["jan-adjustment"]);
  });

  test("When an exclusion is reported, then it states in prose why those transactions do not count", () => {
    // The reader of a number is often not the person who wrote the query, so the
    // reason has to travel in the response rather than in a source comment.
    for (const line of report(withNoise).exclusions) {
      expect(line.reason.length).toBeGreaterThan(20);
    }
  });
});

describe("Given a split transaction, which carries its categories on its line items", () => {
  const withSplit = [
    ...JANUARY,
    aCachedTransaction({
      id: "jan-split",
      amountCents: -9_900,
      transactionDate: "2026-01-20",
      coa: undefined,
      split: { items: [{ coa: { type: "CATEGORY", id: "cat-rent" } }, { coa: { type: "CATEGORY", id: "cat-supplies" } }] },
    }),
  ];

  test("When the report is produced, then its amount is still counted in the month total", () => {
    const january = report(withSplit).months.find((month) => month.period.month === "2026-01");

    expect(january?.total.transactionIds).toContain("jan-split");
  });

  test("When the report is produced, then it is bucketed apart from uncategorized rather than mistaken for one", () => {
    const january = report(withSplit).months.find((month) => month.period.month === "2026-01");
    const bucket = january?.categories.find((category) => category.figure.transactionIds.includes("jan-split"));

    expect(bucket?.categoryName).toBe("(split — category not determined)");
    expect(bucket?.categoryName).not.toBe("(uncategorized)");
  });

  test("When the report is produced, then the undetermined attribution is stated with the ids it applies to", () => {
    const undetermined = report(withSplit).undetermined.find((entry) => entry.what.includes("split"));

    expect(undetermined?.transactionIds).toEqual(["jan-split"]);
    expect(undetermined?.why).toContain("line items");
  });
});

describe("Given a transaction with no category at all", () => {
  test("When the report is produced, then it lands in a named uncategorized bucket rather than vanishing", () => {
    const uncategorized = aCachedTransaction({
      id: "jan-mystery",
      amountCents: -700,
      transactionDate: "2026-01-22",
      coa: { type: "UNCATEGORIZED", id: "0" },
    });

    const january = report([...JANUARY, uncategorized]).months.find((month) => month.period.month === "2026-01");
    const bucket = january?.categories.find((category) => category.categoryName === "(uncategorized)");

    expect(bucket?.figure.transactionIds).toEqual(["jan-mystery"]);
    expect(january?.total.transactionIds).toContain("jan-mystery");
  });
});
