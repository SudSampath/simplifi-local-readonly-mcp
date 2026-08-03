import { describe, expect, test } from "vitest";

import { classifyTransfer, isTransferShaped, partitionTransfers } from "../../src/transfers.js";
import type { CachedTransaction } from "../../src/types.js";

/**
 * Transfers between our own accounts are not spending. Simplifi marks them with
 * `coa.type === "ACCOUNT"` and links each leg to its counterpart by id.
 *
 * Fixtures below are synthetic. Ids and payees are invented.
 */

function aTransaction(overrides: Partial<CachedTransaction> & { id: string }): CachedTransaction {
  return {
    payee: "Fictional Llama Emporium",
    amountCents: -1234,
    transactionDate: "2026-07-15",
    coa: { type: "CATEGORY", id: "cat-1" },
    ...overrides,
  };
}

/** One transfer, as Simplifi represents it: both legs ACCOUNT, each naming the other. */
function aTransferPair(amountCents: number): [CachedTransaction, CachedTransaction] {
  return [
    aTransaction({
      id: "leg-out",
      amountCents: -amountCents,
      coa: { type: "ACCOUNT", id: "acct-b" },
      transfer: { id: "leg-in" },
    }),
    aTransaction({
      id: "leg-in",
      amountCents,
      coa: { type: "ACCOUNT", id: "acct-a" },
      transfer: { id: "leg-out" },
    }),
  ];
}

describe("Given a pair of transactions representing one transfer between our own accounts", () => {
  test("When spending is computed, then neither leg is counted", () => {
    const pair = aTransferPair(50_000);
    const groceries = aTransaction({ id: "groceries" });

    const summary = partitionTransfers([...pair, groceries]);

    expect(summary.spending.map((item) => item.id)).toEqual(["groceries"]);
    expect(summary.transfers.map((item) => item.id).sort()).toEqual(["leg-in", "leg-out"]);
  });

  test("When the pair is identified, then each leg names its counterpart rather than standing alone", () => {
    const [out, back] = aTransferPair(50_000);
    const known = new Map([out, back].map((t) => [t.id, t]));

    expect(classifyTransfer(out, known)).toEqual({ kind: "transfer", counterpartId: "leg-in" });
    expect(classifyTransfer(back, known)).toEqual({ kind: "transfer", counterpartId: "leg-out" });
  });

  test("When the excluded legs are summed, then they net to exactly zero", () => {
    const summary = partitionTransfers(aTransferPair(50_000));

    // A non-zero net here means legs were paired that do not belong together.
    expect(summary.excludedNetCents).toBe(0);
    expect(summary.excludedCount).toBe(2);
  });

  test("When the legs post on different dates, then they still pair, because pairing is by id", () => {
    // The ticket anticipated a date-and-amount tolerance. The explicit link
    // makes it unnecessary: differing dates change nothing.
    const [out, back] = aTransferPair(50_000);
    out.transactionDate = "2026-07-15";
    back.transactionDate = "2026-07-19";

    const summary = partitionTransfers([out, back]);

    expect(summary.excludedCount).toBe(2);
    expect(summary.unmatched).toEqual([]);
  });
});

describe("Given a payment to an external party that resembles a transfer", () => {
  test("When transfers are identified, then it is not excluded from spending", () => {
    // Same amount and date as a transfer leg, but categorised rather than
    // pointed at an account. The false-positive case, asserted as its own.
    const [out] = aTransferPair(50_000);
    const lookalike = aTransaction({
      id: "external-payment",
      amountCents: out.amountCents,
      transactionDate: out.transactionDate,
      coa: { type: "CATEGORY", id: "cat-rent" },
    });

    const summary = partitionTransfers([lookalike]);

    expect(isTransferShaped(lookalike)).toBe(false);
    expect(summary.spending.map((item) => item.id)).toEqual(["external-payment"]);
    expect(summary.excludedCount).toBe(0);
  });

  test("When a transaction merely carries a transfer id but is not account-typed, then it is still spending", () => {
    const oddity = aTransaction({ id: "odd", coa: { type: "CATEGORY", id: "c" }, transfer: { id: "somewhere" } });

    expect(classifyTransfer(oddity, new Map([[oddity.id, oddity]]))).toEqual({ kind: "spending" });
  });
});

describe("Given a transfer leg whose counterpart is missing", () => {
  test("When it is classified, then it is flagged rather than silently included or excluded", () => {
    const orphan = aTransaction({
      id: "orphan",
      coa: { type: "ACCOUNT", id: "acct-x" },
      transfer: { id: "not-in-cache" },
    });

    const summary = partitionTransfers([orphan]);

    expect(summary.spending).toEqual([]);
    expect(summary.transfers).toEqual([]);
    expect(summary.unmatched).toHaveLength(1);
    expect(summary.unmatched[0]?.classification).toEqual({
      kind: "unmatched-transfer",
      reason: "counterpart-not-cached",
      counterpartId: "not-in-cache",
    });
  });

  test("When it carries no counterpart id at all, then that is reported as a distinct reason", () => {
    const bare = aTransaction({ id: "bare", coa: { type: "ACCOUNT", id: "acct-y" }, transfer: undefined });

    const summary = partitionTransfers([bare]);

    expect(summary.unmatched[0]?.classification).toEqual({
      kind: "unmatched-transfer",
      reason: "no-counterpart-id",
    });
  });

  test("When the counterpart exists but names someone else, then the pair is not accepted", () => {
    // Accepting a one-way link as a balanced pair would silently drop its
    // imbalance from spending. The values below are synthetic and deliberately
    // do not cancel.
    const oneWay = aTransaction({
      id: "one-way",
      amountCents: -500_000,
      coa: { type: "ACCOUNT", id: "acct-x" },
      transfer: { id: "elsewhere" },
    });
    const elsewhere = aTransaction({
      id: "elsewhere",
      amountCents: -100,
      coa: { type: "ACCOUNT", id: "acct-y" },
      transfer: { id: "someone-else" },
    });

    const summary = partitionTransfers([oneWay, elsewhere]);

    expect(summary.transfers).toEqual([]);
    expect(summary.excludedNetCents).toBe(0);
    expect(summary.unmatched.map((entry) => entry.classification.kind)).toEqual([
      "unmatched-transfer",
      "unmatched-transfer",
    ]);
    expect(summary.unmatched[0]?.classification).toMatchObject({
      reason: "counterpart-does-not-reciprocate",
      counterpartId: "elsewhere",
    });
  });

  test("When an unmatched leg exists, then it is not counted in the excluded total either", () => {
    // Counting it as excluded would imply a pair was removed when one was not.
    const orphan = aTransaction({
      id: "orphan",
      amountCents: -9_999,
      coa: { type: "ACCOUNT", id: "acct-x" },
      transfer: { id: "not-in-cache" },
    });

    const summary = partitionTransfers([orphan]);

    expect(summary.excludedCount).toBe(0);
    expect(summary.excludedNetCents).toBe(0);
  });
});

describe("Given any set of transactions being summarised", () => {
  test("When the partition is returned, then the count and net of what was excluded come with it", () => {
    const summary = partitionTransfers([...aTransferPair(25_000), aTransaction({ id: "coffee", amountCents: -450 })]);

    // No code path returns a total that silently excluded transactions.
    expect(summary).toMatchObject({ excludedCount: 2, excludedNetCents: 0 });
    expect(summary.spending).toHaveLength(1);
  });

  test("When nothing is a transfer, then the exclusion report is present and zero rather than absent", () => {
    const summary = partitionTransfers([aTransaction({ id: "a" }), aTransaction({ id: "b" })]);

    expect(summary.excludedCount).toBe(0);
    expect(summary.unmatched).toEqual([]);
    expect(summary.spending).toHaveLength(2);
  });
});
