import { asCents, formatCents } from "../money.js";
import type { CachedTransaction } from "../types.js";
import { amountCentsOf } from "./classify.js";
import { prepareForAnalysis, traceFigure, type AnalysisInput } from "./spending.js";
import type { Cadence, RecurringChargeChange, RecurringChargeReport, Undetermined } from "./types.js";

/**
 * Subscriptions and other recurring charges, and which of them have crept up.
 *
 * The question this answers — "what is quietly costing more than it used to" —
 * is only worth asking if the answer carries its evidence. A claim that a charge
 * rose by four dollars is checkable exactly when both the old amount and the new
 * one arrive with the transactions that show them, which is what this returns.
 *
 * Merchant names come from `renamedPayee` where Simplifi has one and `payee`
 * otherwise. Normalisation is deliberately limited to trimming and case folding;
 * anything cleverer could merge two distinct merchants.
 */

export interface RecurringAnalysisInput extends AnalysisInput {
  /** How many charges before a merchant is treated as recurring. Fewer cannot establish a cadence. */
  minOccurrences?: number;
  /** Changes smaller than this are ignored. One cent by default, i.e. nothing is ignored. */
  minChangeCents?: number;
  /**
   * How many charges at the old amount before a move away from it counts as a
   * price change rather than as ordinary variation.
   *
   * Two by default, and the default matters. With a threshold of one, an ordinary
   * variable purchase can make every difference look like a price change.
   * Requiring the old amount to have held at least twice separates a subscription
   * whose price moved from a merchant that never had one stable price.
   */
  minEstablishedRun?: number;
}

/** Median spacing in days, matched against how people actually bill. */
const CADENCE_RANGES: Array<{ cadence: Cadence; minDays: number; maxDays: number }> = [
  { cadence: "weekly", minDays: 5, maxDays: 9 },
  { cadence: "monthly", minDays: 25, maxDays: 35 },
  { cadence: "quarterly", minDays: 85, maxDays: 95 },
  { cadence: "annual", minDays: 350, maxDays: 380 },
];

const DAY_MS = 86_400_000;

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function cadenceOf(dates: readonly string[]): Cadence | undefined {
  const gaps: number[] = [];
  for (let index = 1; index < dates.length; index += 1) {
    gaps.push(daysBetween(dates[index - 1]!, dates[index]!));
  }

  if (gaps.length === 0) {
    return undefined;
  }

  const spacing = median(gaps);
  return CADENCE_RANGES.find((range) => spacing >= range.minDays && spacing <= range.maxDays)?.cadence;
}

/** The name to group by, and the name to show. */
function merchantOf(transaction: CachedTransaction): { key: string; display: string } | undefined {
  for (const candidate of [transaction.renamedPayee, transaction.payee, transaction.mlInferredPayee]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const display = candidate.trim();
      return { key: display.toLowerCase(), display };
    }
  }

  return undefined;
}

/** The trailing run of charges sharing one amount, and the run of one amount immediately before it. */
function trailingRuns(
  occurrences: readonly CachedTransaction[],
): { before: CachedTransaction[]; after: CachedTransaction[] } | undefined {
  const last = occurrences[occurrences.length - 1];
  if (last === undefined) {
    return undefined;
  }

  const afterAmount = amountCentsOf(last);
  let afterStart = occurrences.length - 1;
  while (afterStart > 0 && amountCentsOf(occurrences[afterStart - 1]!) === afterAmount) {
    afterStart -= 1;
  }

  if (afterStart === 0) {
    // One amount for the whole history: steady, not changed.
    return undefined;
  }

  const beforeAmount = amountCentsOf(occurrences[afterStart - 1]!);
  let beforeStart = afterStart - 1;
  while (beforeStart > 0 && amountCentsOf(occurrences[beforeStart - 1]!) === beforeAmount) {
    beforeStart -= 1;
  }

  return {
    before: occurrences.slice(beforeStart, afterStart),
    after: occurrences.slice(afterStart),
  };
}

/**
 * Recurring charges whose amount has moved, with both amounts traced.
 *
 * Only outflows are considered: a recurring deposit is not a subscription, and
 * mixing the two would put a raise and a price rise in the same list.
 */
export function recurringChargeChanges(input: RecurringAnalysisInput): RecurringChargeReport {
  const prepared = prepareForAnalysis(input);
  const minOccurrences = Math.max(input.minOccurrences ?? 3, 2);
  const minChangeCents = Math.max(input.minChangeCents ?? 1, 1);
  const minEstablishedRun = Math.max(input.minEstablishedRun ?? 2, 1);

  const byMerchant = new Map<string, { display: string; rows: CachedTransaction[] }>();
  const unnamed: CachedTransaction[] = [];

  for (const transaction of prepared.spending) {
    if (amountCentsOf(transaction) >= 0) {
      continue;
    }

    const merchant = merchantOf(transaction);
    if (merchant === undefined) {
      unnamed.push(transaction);
      continue;
    }

    const entry = byMerchant.get(merchant.key) ?? { display: merchant.display, rows: [] };
    entry.rows.push(transaction);
    byMerchant.set(merchant.key, entry);
  }

  const changes: RecurringChargeChange[] = [];
  const irregularMerchants: string[] = [];
  const variableAmountMerchants: string[] = [];
  let steadyCount = 0;

  for (const entry of byMerchant.values()) {
    if (entry.rows.length < minOccurrences) {
      continue;
    }

    const occurrences = [...entry.rows].sort(
      (left, right) =>
        (left.transactionDate as string).localeCompare(right.transactionDate as string) ||
        left.id.localeCompare(right.id),
    );

    const cadence = cadenceOf(occurrences.map((transaction) => transaction.transactionDate as string));
    if (cadence === undefined) {
      irregularMerchants.push(entry.display);
      continue;
    }

    const runs = trailingRuns(occurrences);
    if (runs === undefined) {
      steadyCount += 1;
      continue;
    }

    if (runs.before.length < minEstablishedRun) {
      // The old amount never held long enough to be a price. Reporting a move
      // away from it as a rise would bury the real rises in grocery noise.
      variableAmountMerchants.push(entry.display);
      continue;
    }

    const beforeAmountCents = amountCentsOf(runs.before[0]!);
    const afterAmountCents = amountCentsOf(runs.after[0]!);
    // Cost, not signed amount: both are negative, so a bigger bill is a more
    // negative number, and subtracting them directly would call a rise a fall.
    const changeCents = asCents(Math.abs(afterAmountCents) - Math.abs(beforeAmountCents));

    if (Math.abs(changeCents) < minChangeCents) {
      steadyCount += 1;
      continue;
    }

    changes.push({
      merchant: entry.display,
      cadence,
      direction: changeCents > 0 ? "increased" : "decreased",
      beforeAmountCents,
      beforeAmountFormatted: formatCents(beforeAmountCents),
      before: traceFigure(runs.before),
      afterAmountCents,
      afterAmountFormatted: formatCents(afterAmountCents),
      after: traceFigure(runs.after),
      changeCents,
      changeFormatted: formatCents(changeCents),
      changedOn: runs.after[0]!.transactionDate as string,
      occurrenceCount: occurrences.length,
    });
  }

  // Biggest rise first — what the question is usually asked to find.
  changes.sort((left, right) => right.changeCents - left.changeCents || left.merchant.localeCompare(right.merchant));
  irregularMerchants.sort((left, right) => left.localeCompare(right));
  variableAmountMerchants.sort((left, right) => left.localeCompare(right));

  const undetermined: Undetermined[] = [...prepared.undetermined];
  if (unnamed.length > 0) {
    undetermined.push({
      what: `${unnamed.length} outflow${unnamed.length === 1 ? "" : "s"} could not be attributed to a merchant.`,
      why: "The transaction carries no payee, renamed payee, or inferred payee, so it cannot be grouped with anything. It is therefore invisible to this analysis rather than counted under a wrong name.",
      transactionIds: unnamed.map((transaction) => transaction.id),
    });
  }

  if (!prepared.coverage.complete) {
    undetermined.push({
      what: "A charge may have changed before the range examined.",
      why: "The requested range is not fully covered by the cache, so the earliest amount seen here is not necessarily the amount a charge started at.",
      transactionIds: [],
    });
  }

  return {
    changes,
    steadyCount,
    irregularMerchants,
    variableAmountMerchants,
    exclusions: prepared.exclusions,
    undetermined,
    coverage: prepared.coverage,
    provenance: prepared.provenance,
  };
}

/** Exposed for the tests that assert cadence classification directly. */
export const cadenceForDates = cadenceOf;
