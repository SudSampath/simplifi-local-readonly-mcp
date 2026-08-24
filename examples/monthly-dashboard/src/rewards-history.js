import { evaluateRewardPurchase } from "./rewards-model.js";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertMonth(value, label) {
  if (!MONTH_PATTERN.test(value)) throw new Error(`${label} must be YYYY-MM.`);
}

function monthsThrough(completedThrough) {
  const year = completedThrough.slice(0, 4);
  const last = Number(completedThrough.slice(5, 7));
  return Array.from({ length: last }, (_unused, index) => `${year}-${String(index + 1).padStart(2, "0")}`);
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

function groupRows(rows, keyFor, describe) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) ?? { ...describe(row), rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ rows: componentRows, ...identity }) => {
    const eligibleSpendCents = sum(componentRows, "eligibleSpendCents");
    const estimatedUnits = sum(componentRows, "estimatedUnits");
    const valuationKeys = new Set(componentRows.map((row) => JSON.stringify(row.valuationAssumption)));
    const consistentlyValued = componentRows.every((row) => row.estimatedLowValueCents !== undefined && row.estimatedHighValueCents !== undefined) && valuationKeys.size === 1;
    const estimatedLowValueCents = consistentlyValued ? sum(componentRows, "estimatedLowValueCents") : undefined;
    const estimatedHighValueCents = consistentlyValued ? sum(componentRows, "estimatedHighValueCents") : undefined;
    return {
      ...identity,
      eligibleSpendCents,
      estimatedUnits,
      ...(estimatedLowValueCents === undefined || estimatedHighValueCents === undefined ? {} : {
        estimatedLowValueCents,
        estimatedHighValueCents,
        effectiveReturnLowPercent: eligibleSpendCents === 0 ? null : (estimatedLowValueCents / eligibleSpendCents) * 100,
        effectiveReturnHighPercent: eligibleSpendCents === 0 ? null : (estimatedHighValueCents / eligibleSpendCents) * 100,
        ...(estimatedLowValueCents === estimatedHighValueCents ? {
          estimatedValueCents: estimatedLowValueCents,
          effectiveReturnPercent: eligibleSpendCents === 0 ? null : (estimatedLowValueCents / eligibleSpendCents) * 100,
        } : {}),
        valuationAssumption: componentRows[0].valuationAssumption,
      }),
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function rollup(rows, period) {
  const cards = groupRows(
    rows,
    (row) => row.cardKey,
    (row) => ({ cardKey: row.cardKey, ownerKey: row.ownerKey, programKey: row.programKey, rewardCurrency: row.rewardCurrency }),
  );
  const programs = groupRows(
    rows,
    (row) => `${row.programKey}\u0000${row.rewardCurrency}`,
    (row) => ({ programKey: row.programKey, rewardCurrency: row.rewardCurrency }),
  );
  const categories = groupRows(
    rows,
    (row) => `${row.cardKey}\u0000${row.rewardCurrency}\u0000${row.confidence}\u0000${row.earningCategory}`,
    (row) => ({
      cardKey: row.cardKey,
      programKey: row.programKey,
      rewardCurrency: row.rewardCurrency,
      confidence: row.confidence,
      earningCategory: row.earningCategory,
    }),
  );
  const eligibleSpendCents = sum(rows, "eligibleSpendCents");
  const programReconciliation = programs.map((program) => {
    const matchingCards = cards.filter((card) => card.programKey === program.programKey && card.rewardCurrency === program.rewardCurrency);
    const matchingCategories = categories.filter((category) => category.programKey === program.programKey && category.rewardCurrency === program.rewardCurrency);
    return {
      programKey: program.programKey,
      rewardCurrency: program.rewardCurrency,
      estimatedUnits: program.estimatedUnits,
      cardUnits: sum(matchingCards, "estimatedUnits"),
      componentUnits: sum(matchingCategories, "estimatedUnits"),
      unitDifference: program.estimatedUnits - sum(matchingCategories, "estimatedUnits"),
    };
  });
  return {
    period,
    basis: "estimated",
    eligibleSpendCents,
    cards,
    programs,
    categories,
    reconciliation: {
      eligibleSpendCents,
      cardSpendCents: sum(cards, "eligibleSpendCents"),
      programSpendCents: sum(programs, "eligibleSpendCents"),
      componentSpendCents: sum(categories, "eligibleSpendCents"),
      spendDifferenceCents: eligibleSpendCents - sum(categories, "eligibleSpendCents"),
      programs: programReconciliation,
    },
  };
}

/**
 * Build deterministic monthly and selected-month reward summaries. Inputs may
 * contain private classified rows; output contains stable keys and totals only.
 */
export function estimateRewardHistory({
  cards,
  purchases,
  rules,
  completedThrough,
  selectedMonth,
  coverageStartMonth,
  activatedRuleIds = [],
}) {
  assertMonth(completedThrough, "completedThrough");
  const availableMonths = monthsThrough(completedThrough);
  const selected = selectedMonth ?? availableMonths.at(-1);
  assertMonth(selected, "selectedMonth");
  if (!availableMonths.includes(selected)) throw new Error("selectedMonth must be a completed month in completedThrough's year.");

  const cardByKey = new Map(cards.map((card) => [card.key, card]));
  const priorSpendCentsByRule = {};
  const rows = [];
  const sortedPurchases = [...purchases]
    .filter((purchase) => purchase.eligible !== false)
    .filter((purchase) => purchase.occurredOn.slice(0, 7) <= completedThrough)
    .sort((left, right) => left.occurredOn.localeCompare(right.occurredOn) || left.key.localeCompare(right.key));

  for (const purchase of sortedPurchases) {
    const card = cardByKey.get(purchase.cardKey);
    if (!card) throw new Error(`Unknown reward card key ${purchase.cardKey}.`);
    const result = evaluateRewardPurchase({ card, purchase, rules, activatedRuleIds, priorSpendCentsByRule });
    const programKey = card.poolKey ? `pool:${card.poolKey}` : `owner:${card.ownerKey ?? "unassigned"}`;
    const configuredRange = card.valuationRangeCentsPerUnit ?? (card.valuationCentsPerUnit === undefined ? undefined : {
      low: card.valuationCentsPerUnit,
      high: card.valuationCentsPerUnit,
    });
    const valuationAssumption = configuredRange === undefined ? undefined : {
      lowCentsPerUnit: configuredRange.low,
      highCentsPerUnit: configuredRange.high,
      label: card.valuationLabel ?? (configuredRange.low === configuredRange.high ? "Configured cents-per-unit assumption" : "Configured cents-per-unit range"),
    };
    const appliedSpendCents = sum(result.appliedRules, "amountCents");
    const components = [
      ...result.appliedRules,
      ...(appliedSpendCents < purchase.amountCents ? [{
        ruleId: null,
        amountCents: purchase.amountCents - appliedSpendCents,
        estimatedUnits: 0,
      }] : []),
    ];
    for (const applied of components) {
      if (applied.ruleId) {
        priorSpendCentsByRule[applied.ruleId] = (priorSpendCentsByRule[applied.ruleId] ?? 0) + applied.amountCents;
      }
      rows.push({
        month: purchase.occurredOn.slice(0, 7),
        cardKey: card.key,
        ownerKey: card.ownerKey ?? "unassigned",
        programKey,
        rewardCurrency: card.rewardCurrency,
        confidence: purchase.confidence,
        earningCategory: purchase.rewardCategory,
        appliedRuleId: applied.ruleId,
        eligibleSpendCents: applied.amountCents,
        estimatedUnits: applied.estimatedUnits,
        ...(valuationAssumption === undefined ? {} : {
          estimatedLowValueCents: Math.round(applied.estimatedUnits * valuationAssumption.lowCentsPerUnit),
          estimatedHighValueCents: Math.round(applied.estimatedUnits * valuationAssumption.highCentsPerUnit),
          ...(valuationAssumption.lowCentsPerUnit === valuationAssumption.highCentsPerUnit ? {
            estimatedValueCents: Math.round(applied.estimatedUnits * valuationAssumption.lowCentsPerUnit),
          } : {}),
          valuationAssumption,
        }),
      });
    }
  }

  const monthly = availableMonths.map((month) => rollup(rows.filter((row) => row.month === month), month));
  const selectedIndex = availableMonths.indexOf(selected);
  const selectedSummary = monthly[selectedIndex];
  const previousSummary = selectedIndex === 0 ? undefined : monthly[selectedIndex - 1];
  const ytdRows = rows.filter((row) => row.month.startsWith(selected.slice(0, 4)) && row.month <= selected);
  const ytd = rollup(ytdRows, `${selected.slice(0, 4)}-YTD`);
  const previousPrograms = new Map((previousSummary?.programs ?? []).map((program) => [`${program.programKey}\u0000${program.rewardCurrency}`, program]));
  const ytdPrograms = new Map(ytd.programs.map((program) => [`${program.programKey}\u0000${program.rewardCurrency}`, program]));
  const trends = selectedSummary.programs.map((program) => {
    const key = `${program.programKey}\u0000${program.rewardCurrency}`;
    const previous = previousPrograms.get(key);
    return {
      programKey: program.programKey,
      rewardCurrency: program.rewardCurrency,
      selectedEstimatedUnits: program.estimatedUnits,
      previousEstimatedUnits: previous?.estimatedUnits ?? 0,
      monthOverMonthUnitChange: program.estimatedUnits - (previous?.estimatedUnits ?? 0),
      yearToDateEstimatedUnits: ytdPrograms.get(key)?.estimatedUnits ?? 0,
    };
  });

  const startMonth = coverageStartMonth ?? availableMonths[0];
  assertMonth(startMonth, "coverageStartMonth");
  return {
    selectedMonth: selected,
    latestCompletedMonth: completedThrough,
    availableMonths,
    monthly,
    selected: selectedSummary,
    previous: previousSummary,
    ytd,
    trends,
    coverage: {
      startMonth,
      completeFromStartOfYear: startMonth <= availableMonths[0],
      status: startMonth <= availableMonths[0] ? "estimated-full-period" : "estimated-partial-period",
      actualComparisonEligible: false,
      note: "Transaction-derived earnings are estimates; issuer balances are not projected backward.",
    },
  };
}
