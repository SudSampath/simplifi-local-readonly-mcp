import { describe, expect, test } from "vitest";

import { classifyCardPurchases } from "../../src/rewards/classify.js";
import type { CachedTransaction } from "../../src/types.js";
import { aCachedTransaction } from "../support/fixtures.js";

const classify = (transactions: CachedTransaction[]) => classifyCardPurchases(transactions, {
  cardKeyForAccount: (accountId) => accountId === "acct-teal" ? "card-synthetic" : undefined,
  merchantMatch: (transaction) => transaction.payee?.includes("Llama")
    ? { rewardCategory: "synthetic-market", confidence: "high" }
    : undefined,
  categoryMatch: (transaction) => transaction.coa?.id === "cat-supplies"
    ? { rewardCategory: "general", confidence: "medium" }
    : undefined,
});

describe("Given cached activity connected to a configured card", () => {
  test("When purchases and refunds are classified, then net eligible spend reconciles without exposing source identifiers", () => {
    const result = classify([
      aCachedTransaction({ id: "txn-synthetic-purchase", amountCents: -10_000 }),
      aCachedTransaction({ id: "txn-synthetic-refund", amountCents: 2_500 }),
    ]);

    expect(result.summaries).toEqual([expect.objectContaining({
      cardKey: "card-synthetic",
      eligibleNetCents: 7_500,
      purchaseCents: 10_000,
      refundCents: 2_500,
      purchaseCount: 1,
      refundCount: 1,
    })]);
    expect(JSON.stringify(result)).not.toMatch(/acct-teal|txn-synthetic|Fictional Llama/);
  });

  test("When merchant and category matches are available, then merchant confidence wins and unmapped activity remains low confidence", () => {
    const result = classify([
      aCachedTransaction({ id: "txn-synthetic-high" }),
      aCachedTransaction({ id: "txn-synthetic-medium", payee: "Imaginary Otter Arcade" }),
      aCachedTransaction({ id: "txn-synthetic-low", payee: "Imaginary Otter Arcade", coa: { type: "CATEGORY", id: "cat-unknown" } }),
    ]);

    expect(result.summaries[0]?.categories).toEqual([
      { rewardCategory: "general", confidence: "medium", eligibleNetCents: 4_250 },
      { rewardCategory: "synthetic-market", confidence: "high", eligibleNetCents: 4_250 },
      { rewardCategory: "unmapped", confidence: "low", eligibleNetCents: 4_250 },
    ]);
    expect(result.classificationCaveat).toMatch(/issuer merchant-category coding may differ/i);
  });

  test("When a purchase is reversed by a credit, then the pair is handled once and eligible net spend is zero", () => {
    const result = classify([
      aCachedTransaction({ id: "txn-synthetic-charge", amountCents: -4_250 }),
      aCachedTransaction({ id: "txn-synthetic-reversal", amountCents: 4_250 }),
    ]);

    expect(result.summaries[0]).toEqual(expect.objectContaining({
      eligibleNetCents: 0,
      purchaseCents: 4_250,
      refundCents: 4_250,
      purchaseCount: 1,
      refundCount: 1,
    }));
  });
});

describe("Given cached rows that cannot earn purchase rewards", () => {
  test("When payments, fees, duplicates, and unresolved splits are classified, then each is excluded once with a reason", () => {
    const purchase = aCachedTransaction({ id: "txn-synthetic-duplicate" });
    const withFeeRule = classifyCardPurchases([
      ...[purchase, purchase],
      aCachedTransaction({ id: "txn-synthetic-payment", coa: { type: "ACCOUNT", id: "acct-plum" } }),
      aCachedTransaction({ id: "txn-synthetic-fee", payee: "Imaginary Otter", coa: { type: "CATEGORY", id: "cat-fee" } }),
      aCachedTransaction({ id: "txn-synthetic-split", split: { items: [{ coa: { type: "CATEGORY", id: "cat-supplies" } }] } }),
    ], {
      cardKeyForAccount: () => "card-synthetic",
      categoryMatch: (transaction) => transaction.coa?.id === "cat-fee"
        ? { rewardCategory: "annual fee", confidence: "medium" }
        : { rewardCategory: "general", confidence: "medium" },
    });

    expect(withFeeRule.inputCount).toBe(5);
    expect(withFeeRule.exclusions.map((entry) => entry.reason)).toEqual([
      "duplicate",
      "fee-or-interest",
      "split-detail-unavailable",
      "transfer-or-payment",
    ]);
    expect(withFeeRule.summaries[0]?.eligibleNetCents).toBe(4_250);
  });

  test("When a private adapter expands a split, then eligible and excluded components reconcile without double counting", () => {
    const result = classifyCardPurchases([
      aCachedTransaction({
        id: "txn-synthetic-split-components",
        amountCents: -10_000,
        split: { items: [{ coa: { type: "CATEGORY", id: "cat-supplies" } }, { coa: { type: "CATEGORY", id: "cat-fee" } }] },
      }),
    ], {
      cardKeyForAccount: () => "card-synthetic",
      splitComponents: () => [
        { amountCents: -8_500, match: { rewardCategory: "general", confidence: "medium" } },
        { amountCents: -1_500, match: { rewardCategory: "cash-like", confidence: "high" } },
      ],
    });

    expect(result.summaries[0]?.eligibleNetCents).toBe(8_500);
    expect(result.exclusions).toEqual([{ reason: "fee-or-interest", count: 1, netCents: -1_500 }]);
    expect((result.summaries[0]?.eligibleNetCents ?? 0) - result.exclusions[0]!.netCents).toBe(10_000);
  });
});
