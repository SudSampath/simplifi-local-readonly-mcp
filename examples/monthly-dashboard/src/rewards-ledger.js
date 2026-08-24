const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OPTIONAL_INTEGER_FIELDS = [
  "issuerEarnedUnits",
  "endingBalanceUnits",
  "redeemedUnits",
  "statementCreditsCents",
  "annualFeeCents",
];

function assertIntegerOrUnknown(value, label) {
  if (value !== null && value !== undefined && !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer or null.`);
  }
}

/** Validate manual issuer data without turning an omitted value into zero. */
export function validateRewardLedgerEntry(entry) {
  if (!entry.cardKey && !entry.walletKey) throw new Error("A ledger entry requires cardKey or walletKey.");
  if (!MONTH_PATTERN.test(entry.month)) throw new Error("entry.month must be YYYY-MM.");
  if (!DAY_PATTERN.test(entry.asOf) || Number.isNaN(Date.parse(`${entry.asOf}T00:00:00Z`))) {
    throw new Error("entry.asOf must be an ISO calendar date.");
  }
  if (entry.asOf.slice(0, 7) < entry.month) throw new Error("entry.asOf cannot precede entry.month.");
  for (const field of OPTIONAL_INTEGER_FIELDS) assertIntegerOrUnknown(entry[field], `entry.${field}`);
  return {
    cardKey: entry.cardKey ?? null,
    walletKey: entry.walletKey ?? null,
    month: entry.month,
    asOf: entry.asOf,
    ...Object.fromEntries(OPTIONAL_INTEGER_FIELDS.map((field) => [field, entry[field] ?? null])),
    benefits: (entry.benefits ?? []).map((benefit) => ({
      benefitKey: benefit.benefitKey,
      usedOn: benefit.usedOn ?? null,
      usedValueCents: benefit.usedValueCents ?? null,
    })),
  };
}

/** Compare transaction-derived earning with issuer-reported earning. */
export function reconcileRewardMonth({ estimated, ledgerEntry, tolerance = {} }) {
  const entry = ledgerEntry ? validateRewardLedgerEntry(ledgerEntry) : undefined;
  const issuerEarnedUnits = entry?.issuerEarnedUnits ?? null;
  if (issuerEarnedUnits === null) {
    return {
      cardKey: estimated.cardKey,
      month: estimated.month,
      estimatedUnits: estimated.estimatedUnits,
      issuerEarnedUnits: null,
      varianceUnits: null,
      variancePercent: null,
      status: "estimated-only",
    };
  }

  const varianceUnits = issuerEarnedUnits - estimated.estimatedUnits;
  const variancePercent = estimated.estimatedUnits === 0
    ? (issuerEarnedUnits === 0 ? 0 : null)
    : (varianceUnits / estimated.estimatedUnits) * 100;
  const withinUnits = Math.abs(varianceUnits) <= (tolerance.units ?? 0);
  const withinPercent = variancePercent !== null && Math.abs(variancePercent) <= (tolerance.percent ?? 0);
  return {
    cardKey: estimated.cardKey,
    month: estimated.month,
    estimatedUnits: estimated.estimatedUnits,
    issuerEarnedUnits,
    varianceUnits,
    variancePercent,
    status: withinUnits || withinPercent ? "reconciled" : "mismatch",
  };
}

/**
 * Return only a balance recorded on or before the selected month. This never
 * backfills a current balance into earlier history.
 */
export function recordedBalanceForMonth(entries, { walletKey, cardKey, selectedMonth }) {
  const eligible = entries
    .map(validateRewardLedgerEntry)
    .filter((entry) => walletKey ? entry.walletKey === walletKey : entry.cardKey === cardKey)
    .filter((entry) => entry.endingBalanceUnits !== null)
    .filter((entry) => entry.asOf.slice(0, 7) <= selectedMonth)
    .sort((left, right) => right.asOf.localeCompare(left.asOf));
  const latest = eligible[0];
  return latest ? {
    endingBalanceUnits: latest.endingBalanceUnits,
    asOf: latest.asOf,
    sourceMonth: latest.month,
  } : null;
}

/** Produce rendering-safe reconciliation summaries, never raw purchase detail. */
export function buildRewardReconciliationSummary({ estimates, ledgerEntries, selectedMonth, tolerance }) {
  const validatedEntries = ledgerEntries.map(validateRewardLedgerEntry);
  const entriesByCardMonth = new Map(validatedEntries
    .filter((entry) => entry.cardKey)
    .map((entry) => [`${entry.cardKey}\u0000${entry.month}`, entry]));
  const reconciliations = estimates
    .filter((estimate) => estimate.month <= selectedMonth)
    .map((estimated) => reconcileRewardMonth({
      estimated,
      ledgerEntry: entriesByCardMonth.get(`${estimated.cardKey}\u0000${estimated.month}`),
      tolerance,
    }));
  return {
    selectedMonth,
    reconciliations,
    materialMismatches: reconciliations
      .filter((item) => item.status === "mismatch")
      .map(({ cardKey, month, varianceUnits, variancePercent }) => ({ cardKey, month, varianceUnits, variancePercent })),
  };
}
