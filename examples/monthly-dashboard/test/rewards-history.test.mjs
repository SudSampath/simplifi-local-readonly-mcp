import assert from "node:assert/strict";
import test from "node:test";

import { estimateRewardHistory } from "../src/rewards-history.js";
import { aRewardCard, aRewardPurchase, aRewardRule } from "./support/rewards-fixtures.mjs";

test("Given classified purchases and effective rules, when a completed month is estimated, then card, category, confidence, value, and return totals reconcile", () => {
  const result = estimateRewardHistory({
    cards: [aRewardCard({ valuationCentsPerUnit: 1.25, valuationLabel: "Synthetic test valuation" })],
    purchases: [
      aRewardPurchase({ key: "purchase-synthetic-dining", amountCents: 10_000, rewardCategory: "dining", confidence: "high" }),
      aRewardPurchase({ key: "purchase-synthetic-general", amountCents: 5_000, rewardCategory: "general", confidence: "medium" }),
    ],
    rules: [aRewardRule(), aRewardRule({ id: "rule-dining", category: "dining", unitsPerDollar: 3 })],
    completedThrough: "2026-01",
  });

  assert.equal(result.selected.eligibleSpendCents, 15_000);
  assert.equal(result.selected.cards[0].estimatedUnits, 350);
  assert.equal(result.selected.cards[0].estimatedValueCents, 438);
  assert.equal(result.selected.cards[0].effectiveReturnPercent, 2.92);
  assert.equal(result.selected.categories.length, 2);
  assert.deepEqual(result.selected.reconciliation, {
    eligibleSpendCents: 15_000,
    cardSpendCents: 15_000,
    programSpendCents: 15_000,
    componentSpendCents: 15_000,
    spendDifferenceCents: 0,
    programs: [{
      programKey: "owner:owner-synthetic-a",
      rewardCurrency: "synthetic-points",
      estimatedUnits: 350,
      cardUnits: 350,
      componentUnits: 350,
      unitDifference: 0,
    }],
  });
  assert.equal(result.selected.cards[0].valuationAssumption.label, "Synthetic test valuation");
});

test("Given prior completed months, when a historical month is selected, then month-over-month and year-to-date stop at that month", () => {
  const result = estimateRewardHistory({
    cards: [aRewardCard()],
    purchases: [
      aRewardPurchase({ key: "purchase-synthetic-jan", occurredOn: "2026-01-15", amountCents: 4_000 }),
      aRewardPurchase({ key: "purchase-synthetic-feb", occurredOn: "2026-02-15", amountCents: 6_000 }),
      aRewardPurchase({ key: "purchase-synthetic-mar", occurredOn: "2026-03-15", amountCents: 8_000 }),
    ],
    rules: [aRewardRule()],
    completedThrough: "2026-03",
    selectedMonth: "2026-02",
  });

  assert.equal(result.selectedMonth, "2026-02");
  assert.equal(result.latestCompletedMonth, "2026-03");
  assert.equal(result.selected.programs[0].estimatedUnits, 60);
  assert.equal(result.previous.programs[0].estimatedUnits, 40);
  assert.equal(result.ytd.programs[0].estimatedUnits, 100);
  assert.deepEqual(result.trends[0], {
    programKey: "owner:owner-synthetic-a",
    rewardCurrency: "synthetic-points",
    selectedEstimatedUnits: 60,
    previousEstimatedUnits: 40,
    monthOverMonthUnitChange: 20,
    yearToDateEstimatedUnits: 100,
  });
});

test("Given a household point-value range, when history is rolled up, then value and effective return remain low-to-high ranges", () => {
  const result = estimateRewardHistory({
    cards: [aRewardCard({ valuationRangeCentsPerUnit: { low: 1.5, high: 2 }, valuationLabel: "Synthetic range" })],
    purchases: [aRewardPurchase({ amountCents: 10_000 })],
    rules: [aRewardRule({ unitsPerDollar: 2 })],
    completedThrough: "2026-01",
  });

  assert.equal(result.selected.cards[0].estimatedLowValueCents, 300);
  assert.equal(result.selected.cards[0].estimatedHighValueCents, 400);
  assert.equal(result.selected.cards[0].effectiveReturnLowPercent, 3);
  assert.equal(result.selected.cards[0].effectiveReturnHighPercent, 4);
  assert.equal("estimatedValueCents" in result.selected.cards[0], false);
  assert.deepEqual(result.selected.cards[0].valuationAssumption, {
    lowCentsPerUnit: 1.5,
    highCentsPerUnit: 2,
    label: "Synthetic range",
  });
});

test("Given no selected month, when history is estimated, then the latest completed month is the default", () => {
  const result = estimateRewardHistory({
    cards: [aRewardCard()],
    purchases: [aRewardPurchase({ occurredOn: "2026-03-15" })],
    rules: [aRewardRule()],
    completedThrough: "2026-03",
  });

  assert.equal(result.selectedMonth, "2026-03");
  assert.deepEqual(result.availableMonths, ["2026-01", "2026-02", "2026-03"]);
});

test("Given multiple owners and reward currencies, when a household summary is produced, then programs remain separate unless explicitly pooled", () => {
  const cards = [
    aRewardCard(),
    aRewardCard({ key: "card-synthetic-b", ownerKey: "owner-synthetic-b", rewardCurrency: "synthetic-points" }),
    aRewardCard({ key: "card-synthetic-c", ownerKey: "owner-synthetic-b", poolKey: "pool-synthetic", rewardCurrency: "synthetic-miles" }),
    aRewardCard({ key: "card-synthetic-d", ownerKey: "owner-synthetic-c", poolKey: "pool-synthetic", rewardCurrency: "synthetic-miles" }),
  ];
  const purchases = cards.map((card, index) => aRewardPurchase({
    key: `purchase-synthetic-${index}`,
    cardKey: card.key,
    amountCents: 1_000,
  }));
  const rules = cards.map((card, index) => aRewardRule({ id: `rule-synthetic-${index}`, cardKey: card.key }));
  const result = estimateRewardHistory({ cards, purchases, rules, completedThrough: "2026-01" });

  assert.deepEqual(result.selected.programs.map(({ programKey, rewardCurrency, estimatedUnits }) => ({ programKey, rewardCurrency, estimatedUnits })), [
    { programKey: "owner:owner-synthetic-a", rewardCurrency: "synthetic-points", estimatedUnits: 10 },
    { programKey: "owner:owner-synthetic-b", rewardCurrency: "synthetic-points", estimatedUnits: 10 },
    { programKey: "pool:pool-synthetic", rewardCurrency: "synthetic-miles", estimatedUnits: 20 },
  ]);
});

test("Given history predates issuer statements, when coverage is partial, then months are estimated and no balance or actual comparison is invented", () => {
  const result = estimateRewardHistory({
    cards: [aRewardCard()],
    purchases: [aRewardPurchase({ occurredOn: "2026-03-15" })],
    rules: [aRewardRule()],
    completedThrough: "2026-03",
    coverageStartMonth: "2026-03",
  });

  assert.equal(result.coverage.status, "estimated-partial-period");
  assert.equal(result.coverage.actualComparisonEligible, false);
  assert.equal(result.monthly.every((month) => month.basis === "estimated"), true);
  assert.equal(JSON.stringify(result).includes("endingBalance"), false);
  assert.match(result.coverage.note, /issuer balances are not projected backward/i);
});
