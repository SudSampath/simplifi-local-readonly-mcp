import { describe, expect, test } from "vitest";

import { classifySpending, partitionSpending } from "../../src/analysis/index.js";
import type { CachedTransaction } from "../../src/types.js";
import { aCachedTransaction, aCachedTransferPair } from "../support/fixtures.js";

/**
 * What counts as spending, asserted one rule at a time.
 *
 * Transfers, balance adjustments, investment activity, and future-dated bill
 * projections are each excluded for a distinct reason, and each is reported.
 *
 * Fixtures are SYNTHETIC; see support/fixtures.ts.
 */

const AS_OF = "2026-08-02";

function classifyAlone(transaction: CachedTransaction) {
  return classifySpending(transaction, new Map([[transaction.id, transaction]]), AS_OF);
}

describe("Given a reconciliation entry Simplifi inserted to make a balance agree", () => {
  test("When it is classified, then it is a balance adjustment rather than spending", () => {
    const adjustment = aCachedTransaction({
      id: "adj",
      amountCents: 130_000,
      transactionDate: "2026-07-01",
      coa: { type: "BALANCE_ADJUSTMENT", id: "0" },
    });

    expect(classifyAlone(adjustment)).toEqual({ kind: "balance-adjustment" });
  });
});

describe("Given a purchase inside an investment account", () => {
  test("When it is classified, then it is investment activity rather than spending", () => {
    const buy = aCachedTransaction({
      id: "buy",
      amountCents: -500_000,
      transactionDate: "2026-07-02",
      type: "INVESTMENT",
    });

    expect(classifyAlone(buy)).toEqual({ kind: "investment" });
  });

  test("When an ordinary cash-flow row sits in the same range, then it is unaffected", () => {
    const groceries = aCachedTransaction({ id: "groceries", transactionDate: "2026-07-02" });

    expect(classifyAlone(groceries)).toEqual({ kind: "spending" });
  });
});

describe("Given a bill Simplifi has scheduled for a date that has not arrived", () => {
  test("When it is classified, then it is a projection rather than spending", () => {
    const projected = aCachedTransaction({ id: "future", amountCents: -70_000, transactionDate: "2026-09-01" });

    expect(classifyAlone(projected)).toEqual({ kind: "projected" });
  });

  test("When it falls on the as-of date itself, then it counts, because that day has happened", () => {
    const today = aCachedTransaction({ id: "today", amountCents: -1_000, transactionDate: AS_OF });

    expect(classifyAlone(today)).toEqual({ kind: "spending" });
  });
});

describe("Given a transaction that is both a transfer and dated in the future", () => {
  test("When it is classified, then it is reported once, as a projection", () => {
    // Precedence has to be total: a row counted in two exclusion lines would make
    // the counts stop summing to the input, and the invariant below is what makes
    // "nothing was silently dropped" checkable rather than asserted.
    const [out, back] = aCachedTransferPair({
      outId: "future-out",
      inId: "future-in",
      amountCents: 20_000,
      transactionDate: "2026-12-01",
    });

    const summary = partitionSpending([out, back], {
      known: new Map([out, back].map((leg) => [leg.id, leg])),
      asOf: AS_OF,
    });

    expect(summary.exclusions.map((line) => line.kind)).toEqual(["projected"]);
    expect(summary.exclusions[0]?.count).toBe(2);
  });
});

describe("Given a mixed set of transactions being partitioned", () => {
  const [out, back] = aCachedTransferPair({
    outId: "t-out",
    inId: "t-in",
    amountCents: 30_000,
    transactionDate: "2026-07-10",
  });

  const mixed = [
    aCachedTransaction({ id: "spend-1", amountCents: -1_000, transactionDate: "2026-07-01" }),
    aCachedTransaction({ id: "spend-2", amountCents: -2_000, transactionDate: "2026-07-02" }),
    out,
    back,
    aCachedTransaction({
      id: "adj",
      amountCents: 5_000,
      transactionDate: "2026-07-03",
      coa: { type: "BALANCE_ADJUSTMENT", id: "0" },
    }),
    aCachedTransaction({ id: "inv", amountCents: -8_000, transactionDate: "2026-07-04", type: "INVESTMENT" }),
    aCachedTransaction({ id: "future", amountCents: -9_000, transactionDate: "2026-10-01" }),
    aCachedTransaction({ id: "undated", amountCents: -700, transactionDate: undefined }),
  ];

  const summary = partitionSpending(mixed, {
    known: new Map(mixed.map((transaction) => [transaction.id, transaction])),
    asOf: AS_OF,
  });

  test("When the partition is returned, then every transaction lands in exactly one bucket", () => {
    const excludedCount = summary.exclusions.reduce((total, line) => total + line.count, 0);

    expect(summary.spending.length + excludedCount).toBe(mixed.length);
  });

  test("When the partition is returned, then the cited ids across all buckets are the input ids, once each", () => {
    const cited = [
      ...summary.spending.map((transaction) => transaction.id),
      ...summary.exclusions.flatMap((line) => line.transactionIds),
    ].sort();

    expect(cited).toEqual(mixed.map((transaction) => transaction.id).sort());
  });

  test("When the partition is returned, then the exclusion lines are ordered the same way every time", () => {
    expect(summary.exclusions.map((line) => line.kind)).toEqual([
      "balance-adjustment",
      "investment",
      "projected",
      "transfer",
      "undated",
    ]);
  });

  test("When a kind of exclusion did not occur, then it is absent rather than reported as zero", () => {
    // The list describes what happened to this data, not a fixed form with
    // blanks. A zero line reads as a measurement of nothing; absence reads as
    // "this did not come up", and only one of those is true.
    expect(summary.exclusions.map((line) => line.kind)).not.toContain("unmatched-transfer");
  });
});

describe("Given a transfer whose counterpart falls outside the range being summarised", () => {
  test("When the wider set is passed as known, then the pair is still recognised rather than reported unmatched", () => {
    // A leg reported as unmatched because the other one fell in the previous
    // month would be an exclusion invented by the query window, not found in the
    // data — and it would send someone looking for a problem that is not there.
    const [july, august] = aCachedTransferPair({
      outId: "straddle-out",
      inId: "straddle-in",
      amountCents: 40_000,
      transactionDate: "2026-07-31",
    });
    august.transactionDate = "2026-08-01";

    const summary = partitionSpending([july], {
      known: new Map([july, august].map((leg) => [leg.id, leg])),
      asOf: AS_OF,
    });

    expect(summary.exclusions.map((line) => line.kind)).toEqual(["transfer"]);
    // Only one leg is inside, so the net of what was excluded is not zero — and
    // it is reported rather than hidden, because that asymmetry is real.
    expect(summary.exclusions[0]).toMatchObject({ count: 1, netCents: -40_000 });
  });

  test("When only the narrow set is known, then the leg is reported unmatched rather than counted as spending", () => {
    const [july] = aCachedTransferPair({
      outId: "straddle-out",
      inId: "straddle-in",
      amountCents: 40_000,
      transactionDate: "2026-07-31",
    });

    const summary = partitionSpending([july], {
      known: new Map([[july.id, july]]),
      asOf: AS_OF,
    });

    expect(summary.spending).toEqual([]);
    expect(summary.exclusions.map((line) => line.kind)).toEqual(["unmatched-transfer"]);
  });
});
