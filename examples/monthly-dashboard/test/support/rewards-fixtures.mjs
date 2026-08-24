/**
 * Synthetic rewards fixtures. Every name, identifier, date, and amount in this
 * module was invented for tests and does not describe a real card or household.
 */

export function aRewardCard(overrides = {}) {
  return {
    key: "card-synthetic-travel",
    displayName: "Synthetic Travel Card",
    rewardCurrency: "synthetic-points",
    ownerKey: "owner-synthetic-a",
    annualFeeCents: 9_500,
    annualFeeSourceUrl: "https://example.invalid/synthetic-card-fees",
    annualFeeVerifiedThrough: "2026-12-31",
    ...overrides,
  };
}

export function aRewardRule(overrides = {}) {
  return {
    id: "rule-synthetic-base",
    cardKey: "card-synthetic-travel",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    unitsPerDollar: 1,
    category: "all-eligible-purchases",
    requiresActivation: false,
    capCents: null,
    verifiedThrough: "2026-12-31",
    sourceUrl: "https://example.invalid/synthetic-reward-terms",
    requiredEvidenceTags: [],
    ...overrides,
  };
}

export function aRewardPurchase(overrides = {}) {
  return {
    key: "purchase-synthetic-0001",
    cardKey: "card-synthetic-travel",
    occurredOn: "2026-01-15",
    amountCents: 4_000,
    rewardCategory: "general",
    confidence: "medium",
    eligible: true,
    evidenceTags: [],
    ...overrides,
  };
}

export function aRewardStatement(overrides = {}) {
  return {
    cardKey: "card-synthetic-travel",
    month: "2026-01",
    issuerEarnedUnits: 4_000,
    endingBalanceUnits: 24_000,
    asOf: "2026-01-31",
    ...overrides,
  };
}
