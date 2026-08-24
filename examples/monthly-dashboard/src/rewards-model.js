const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(value, label) {
  if (!DAY_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be an ISO calendar date.`);
  }
}

function activeOn(rule, occurredOn) {
  return rule.effectiveFrom <= occurredOn && (rule.effectiveTo === null || occurredOn <= rule.effectiveTo);
}

function categoryMatches(rule, category) {
  return rule.category === "all-eligible-purchases" || rule.category === category;
}

function verificationWarning(rule, occurredOn) {
  if (!rule.verifiedThrough) return `${rule.id} is unverified.`;
  return rule.verifiedThrough < occurredOn ? `${rule.id} is stale after ${rule.verifiedThrough}.` : undefined;
}

function unitsFor(amountCents, unitsPerDollar) {
  return Math.floor((amountCents * unitsPerDollar) / 100);
}

function configuredValuation(card) {
  if (card.valuationRangeCentsPerUnit !== undefined) {
    const { low, high } = card.valuationRangeCentsPerUnit;
    if (![low, high].every((value) => Number.isFinite(value) && value >= 0) || low > high) {
      throw new Error("card.valuationRangeCentsPerUnit requires non-negative low and high values with low <= high.");
    }
    return { low, high, label: card.valuationLabel ?? "Configured cents-per-unit range" };
  }
  if (card.valuationCentsPerUnit === undefined) return undefined;
  if (!Number.isFinite(card.valuationCentsPerUnit) || card.valuationCentsPerUnit < 0) {
    throw new Error("card.valuationCentsPerUnit must be a non-negative number.");
  }
  return { low: card.valuationCentsPerUnit, high: card.valuationCentsPerUnit, label: card.valuationLabel ?? "Configured cents-per-unit assumption" };
}

/**
 * Evaluate one already-classified eligible purchase against deterministic,
 * effective-dated reward rules. Merchant and transaction classification belongs
 * to the private adapter; this function consumes only summary-safe fields.
 */
export function evaluateRewardPurchase({
  card,
  purchase,
  rules,
  activatedRuleIds = [],
  priorSpendCentsByRule = {},
}) {
  assertDay(purchase.occurredOn, "purchase.occurredOn");
  if (!Number.isSafeInteger(purchase.amountCents) || purchase.amountCents < 0) {
    throw new Error("purchase.amountCents must be a non-negative integer.");
  }

  const activated = new Set(activatedRuleIds);
  const evidence = new Set(purchase.evidenceTags ?? []);
  const unavailable = [];
  const matchingRules = rules
    .filter((rule) => rule.cardKey === card.key)
    .filter((rule) => categoryMatches(rule, purchase.rewardCategory));
  for (const rule of matchingRules) {
    if (purchase.occurredOn < rule.effectiveFrom) {
      unavailable.push({ ruleId: rule.id, reason: "not-yet-effective" });
    } else if (rule.effectiveTo !== null && purchase.occurredOn > rule.effectiveTo) {
      unavailable.push({ ruleId: rule.id, reason: "expired" });
    }
  }
  const candidates = matchingRules
    .filter((rule) => activeOn(rule, purchase.occurredOn))
    .sort((left, right) => right.unitsPerDollar - left.unitsPerDollar || left.id.localeCompare(right.id));

  const available = candidates.filter((rule) => {
    if (rule.requiresActivation && !activated.has(rule.id)) {
      unavailable.push({ ruleId: rule.id, reason: "activation-required" });
      return false;
    }
    const missingEvidence = (rule.requiredEvidenceTags ?? []).filter((tag) => !evidence.has(tag));
    if (missingEvidence.length > 0) {
      unavailable.push({ ruleId: rule.id, reason: "evidence-required", missingEvidenceTags: missingEvidence });
      return false;
    }
    const priorSpend = priorSpendCentsByRule[rule.id] ?? 0;
    if (rule.capCents !== null && priorSpend >= rule.capCents) {
      unavailable.push({ ruleId: rule.id, reason: "cap-reached" });
      return false;
    }
    return true;
  });

  const selected = available[0];
  if (!selected) {
    return {
      cardKey: card.key,
      rewardCurrency: card.rewardCurrency,
      estimatedUnits: 0,
      unavailable,
      appliedRules: [],
      sources: [],
      warnings: [`No active reward rule matched ${purchase.rewardCategory}.`],
    };
  }

  const priorSpend = priorSpendCentsByRule[selected.id] ?? 0;
  const selectedAmount = selected.capCents === null
    ? purchase.amountCents
    : Math.min(purchase.amountCents, Math.max(0, selected.capCents - priorSpend));
  const remainder = purchase.amountCents - selectedAmount;
  const baseRule = remainder > 0
    ? available.find((rule) => rule.id !== selected.id && rule.category === "all-eligible-purchases")
    : undefined;
  const appliedRules = [{
    ruleId: selected.id,
    amountCents: selectedAmount,
    unitsPerDollar: selected.unitsPerDollar,
    estimatedUnits: unitsFor(selectedAmount, selected.unitsPerDollar),
  }];

  if (remainder > 0) {
    if (baseRule) {
      appliedRules.push({
        ruleId: baseRule.id,
        amountCents: remainder,
        unitsPerDollar: baseRule.unitsPerDollar,
        estimatedUnits: unitsFor(remainder, baseRule.unitsPerDollar),
      });
    } else {
      unavailable.push({ ruleId: selected.id, reason: "cap-reached-without-fallback", amountCents: remainder });
    }
  }

  const estimatedUnits = appliedRules.reduce((sum, rule) => sum + rule.estimatedUnits, 0);
  const valuation = configuredValuation(card);
  const warnings = [...new Set(appliedRules
    .map((applied) => candidates.find((rule) => rule.id === applied.ruleId))
    .map((rule) => rule && verificationWarning(rule, purchase.occurredOn))
    .filter(Boolean))];

  return {
    cardKey: card.key,
    rewardCurrency: card.rewardCurrency,
    estimatedUnits,
    ...(valuation === undefined ? {} : {
      estimatedLowValueCents: Math.round(estimatedUnits * valuation.low),
      estimatedHighValueCents: Math.round(estimatedUnits * valuation.high),
      ...(valuation.low === valuation.high ? { estimatedValueCents: Math.round(estimatedUnits * valuation.low) } : {}),
      valuationAssumption: valuation,
    }),
    unavailable,
    appliedRules,
    sources: [...new Map(appliedRules.map((applied) => {
      const rule = candidates.find((candidate) => candidate.id === applied.ruleId);
      return [rule?.id, { ruleId: rule?.id, sourceUrl: rule?.sourceUrl ?? null, verifiedThrough: rule?.verifiedThrough ?? null }];
    })).values()],
    warnings,
  };
}

export function summarizeRewardResults(results) {
  const currencies = new Map();
  for (const result of results) {
    const current = currencies.get(result.rewardCurrency) ?? { rewardCurrency: result.rewardCurrency, estimatedUnits: 0 };
    current.estimatedUnits += result.estimatedUnits;
    if (result.estimatedLowValueCents !== undefined && result.estimatedHighValueCents !== undefined) {
      current.estimatedLowValueCents = (current.estimatedLowValueCents ?? 0) + result.estimatedLowValueCents;
      current.estimatedHighValueCents = (current.estimatedHighValueCents ?? 0) + result.estimatedHighValueCents;
    }
    if (result.estimatedValueCents !== undefined) {
      current.estimatedValueCents = (current.estimatedValueCents ?? 0) + result.estimatedValueCents;
    }
    currencies.set(result.rewardCurrency, current);
  }
  return [...currencies.values()].sort((left, right) => left.rewardCurrency.localeCompare(right.rewardCurrency));
}

/**
 * Summarize current published card fees without implying that a fee was charged
 * in the selected report month. Card agreements, waivers, and observed private
 * transactions remain the responsibility of the private adapter.
 */
export function summarizeConfiguredAnnualFees(cards, { asOf }) {
  assertDay(asOf, "asOf");
  const rows = cards.map((card) => {
    if (!Number.isSafeInteger(card.annualFeeCents) || card.annualFeeCents < 0) {
      throw new Error(`${card.key}.annualFeeCents must be a non-negative integer.`);
    }
    if (typeof card.annualFeeSourceUrl !== "string" || !card.annualFeeSourceUrl.startsWith("https://")) {
      throw new Error(`${card.key}.annualFeeSourceUrl must be an HTTPS issuer or program URL.`);
    }
    assertDay(card.annualFeeVerifiedThrough, `${card.key}.annualFeeVerifiedThrough`);
    return {
      cardKey: card.key,
      annualFeeCents: card.annualFeeCents,
      basis: "current-standard",
      sourceUrl: card.annualFeeSourceUrl,
      verifiedThrough: card.annualFeeVerifiedThrough,
      ...(card.annualFeeCaveat ? { caveat: card.annualFeeCaveat } : {}),
      warnings: card.annualFeeVerifiedThrough < asOf
        ? [`Annual fee source is stale after ${card.annualFeeVerifiedThrough}.`]
        : [],
    };
  });
  return {
    asOf,
    basis: "current-standard",
    totalAnnualFeeCents: rows.reduce((sum, card) => sum + card.annualFeeCents, 0),
    cards: rows,
  };
}
