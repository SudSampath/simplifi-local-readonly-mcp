import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRewardPurchase, summarizeRewardResults } from "../src/rewards-model.js";
import { aRewardCard, aRewardPurchase, aRewardRule } from "./support/rewards-fixtures.mjs";

test("Given overlapping base and bonus rules, when an eligible purchase is evaluated, then the highest active rate is applied once", () => {
  const result = evaluateRewardPurchase({
    card: aRewardCard(),
    purchase: aRewardPurchase({ amountCents: 10_000, rewardCategory: "dining" }),
    rules: [
      aRewardRule({ id: "rule-base", unitsPerDollar: 1 }),
      aRewardRule({ id: "rule-dining", category: "dining", unitsPerDollar: 3 }),
    ],
  });

  assert.equal(result.rewardCurrency, "synthetic-points");
  assert.equal(result.estimatedUnits, 300);
  assert.deepEqual(result.appliedRules.map((rule) => rule.ruleId), ["rule-dining"]);
});

test("Given a bonus rule requires activation, when it is not activated, then the base rate applies and the unavailable reason is returned", () => {
  const result = evaluateRewardPurchase({
    card: aRewardCard(),
    purchase: aRewardPurchase({ rewardCategory: "grocery" }),
    rules: [
      aRewardRule({ id: "rule-base" }),
      aRewardRule({ id: "rule-grocery", category: "grocery", unitsPerDollar: 5, requiresActivation: true }),
    ],
  });

  assert.deepEqual(result.appliedRules.map((rule) => rule.ruleId), ["rule-base"]);
  assert.deepEqual(result.unavailable, [{ ruleId: "rule-grocery", reason: "activation-required" }]);
});

test("Given a capped bonus has partial capacity, when a purchase crosses the cap, then the remainder earns the base rate without double counting", () => {
  const result = evaluateRewardPurchase({
    card: aRewardCard(),
    purchase: aRewardPurchase({ amountCents: 5_000, rewardCategory: "travel" }),
    rules: [
      aRewardRule({ id: "rule-base", unitsPerDollar: 1 }),
      aRewardRule({ id: "rule-travel", category: "travel", unitsPerDollar: 4, capCents: 12_000 }),
    ],
    priorSpendCentsByRule: { "rule-travel": 10_000 },
  });

  assert.equal(result.estimatedUnits, 110);
  assert.deepEqual(result.appliedRules, [
    { ruleId: "rule-travel", amountCents: 2_000, unitsPerDollar: 4, estimatedUnits: 80 },
    { ruleId: "rule-base", amountCents: 3_000, unitsPerDollar: 1, estimatedUnits: 30 },
  ]);
});

test("Given historical rule versions, when purchases occur before and after a change, then each date uses its effective version", () => {
  const rules = [
    aRewardRule({ id: "rule-old", effectiveTo: "2026-06-30", unitsPerDollar: 2 }),
    aRewardRule({ id: "rule-new", effectiveFrom: "2026-07-01", unitsPerDollar: 3 }),
  ];
  const before = evaluateRewardPurchase({ card: aRewardCard(), purchase: aRewardPurchase({ occurredOn: "2026-06-30" }), rules });
  const after = evaluateRewardPurchase({ card: aRewardCard(), purchase: aRewardPurchase({ occurredOn: "2026-07-01" }), rules });

  assert.equal(before.appliedRules[0].ruleId, "rule-old");
  assert.equal(after.appliedRules[0].ruleId, "rule-new");
  assert.deepEqual(before.unavailable, [{ ruleId: "rule-new", reason: "not-yet-effective" }]);
  assert.deepEqual(after.unavailable, [{ ruleId: "rule-old", reason: "expired" }]);
});

test("Given stale and unverified rule metadata, when a purchase is evaluated, then deterministic warnings are returned without network access", () => {
  const stale = evaluateRewardPurchase({
    card: aRewardCard(),
    purchase: aRewardPurchase({ occurredOn: "2026-08-01" }),
    rules: [aRewardRule({ id: "rule-stale", verifiedThrough: "2026-06-30" })],
  });
  const unverified = evaluateRewardPurchase({
    card: aRewardCard(),
    purchase: aRewardPurchase(),
    rules: [aRewardRule({ id: "rule-unverified", verifiedThrough: undefined })],
  });

  assert.deepEqual(stale.warnings, ["rule-stale is stale after 2026-06-30."]);
  assert.deepEqual(unverified.warnings, ["rule-unverified is unverified."]);
});

test("Given a portal-only bonus, when portal evidence is absent, then the base rule applies and the missing evidence is explicit", () => {
  const rules = [
    aRewardRule({ id: "rule-base" }),
    aRewardRule({ id: "rule-portal", category: "travel", unitsPerDollar: 8, requiredEvidenceTags: ["portal:synthetic-travel"] }),
  ];
  const withoutEvidence = evaluateRewardPurchase({
    card: aRewardCard(),
    purchase: aRewardPurchase({ rewardCategory: "travel" }),
    rules,
  });
  const withEvidence = evaluateRewardPurchase({
    card: aRewardCard(),
    purchase: aRewardPurchase({ rewardCategory: "travel", evidenceTags: ["portal:synthetic-travel"] }),
    rules,
  });

  assert.equal(withoutEvidence.appliedRules[0].ruleId, "rule-base");
  assert.deepEqual(withoutEvidence.unavailable, [{ ruleId: "rule-portal", reason: "evidence-required", missingEvidenceTags: ["portal:synthetic-travel"] }]);
  assert.equal(withEvidence.appliedRules[0].ruleId, "rule-portal");
  assert.deepEqual(withEvidence.sources, [{ ruleId: "rule-portal", sourceUrl: "https://example.invalid/synthetic-reward-terms", verifiedThrough: "2026-12-31" }]);
});

test("Given a configurable redemption range, when points are valued, then low and high values remain distinct", () => {
  const result = evaluateRewardPurchase({
    card: aRewardCard({ valuationRangeCentsPerUnit: { low: 1.5, high: 2 }, valuationLabel: "Synthetic range" }),
    purchase: aRewardPurchase({ amountCents: 10_000 }),
    rules: [aRewardRule({ unitsPerDollar: 2 })],
  });

  assert.equal(result.estimatedUnits, 200);
  assert.equal(result.estimatedLowValueCents, 300);
  assert.equal(result.estimatedHighValueCents, 400);
  assert.equal("estimatedValueCents" in result, false);
  assert.deepEqual(result.valuationAssumption, { low: 1.5, high: 2, label: "Synthetic range" });
});

test("Given results in unlike reward currencies, when totals are summarized, then currencies remain separate and values require explicit valuations", () => {
  const points = evaluateRewardPurchase({
    card: aRewardCard(),
    purchase: aRewardPurchase(),
    rules: [aRewardRule()],
  });
  const cash = evaluateRewardPurchase({
    card: aRewardCard({ key: "card-synthetic-cash", rewardCurrency: "cash-back-cents", valuationCentsPerUnit: 1 }),
    purchase: aRewardPurchase({ cardKey: "card-synthetic-cash" }),
    rules: [aRewardRule({ cardKey: "card-synthetic-cash", id: "rule-cash", unitsPerDollar: 2 })],
  });
  const summary = summarizeRewardResults([points, cash]);

  assert.deepEqual(summary, [
    { rewardCurrency: "cash-back-cents", estimatedUnits: 80, estimatedLowValueCents: 80, estimatedHighValueCents: 80, estimatedValueCents: 80 },
    { rewardCurrency: "synthetic-points", estimatedUnits: 40 },
  ]);
  assert.equal("endingBalanceUnits" in points, false);
});
