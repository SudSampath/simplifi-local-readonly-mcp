import { asCents, formatCents, ZERO_CENTS, type Cents } from "../money.js";
import { classifyTransfer, type TransferClassification } from "../transfers.js";
import type { CachedTransaction } from "../types.js";
import type { ExclusionLine, SpendingExclusionKind } from "./types.js";

/**
 * What counts as spending, and what does not.
 *
 * Transfers are one non-spending case. Three others matter too:
 *
 * - `BALANCE_ADJUSTMENT` rows reconcile a computed balance with an institution;
 *   they are bookkeeping, not money moving anywhere.
 * - `type: INVESTMENT` rows describe buys, sells, and dividends inside an
 *   investment account. The money changed form rather than leaving the household.
 * - Rows dated after the as-of date are Simplifi's projections of bills to come.
 *   Counting them would turn a measurement into a forecast without saying so.
 *
 * Each is excluded and reported, never excluded quietly. Precedence is fixed and
 * total: every transaction lands in exactly one bucket, so the bucket counts sum
 * to the input count — an invariant the tests assert rather than trust.
 */

/** `coa.type` for a reconciliation entry. */
const BALANCE_ADJUSTMENT_COA_TYPE = "BALANCE_ADJUSTMENT";

/** `type` for activity inside an investment account. */
const INVESTMENT_TYPE = "INVESTMENT";

export type SpendingClassification =
  | { kind: "spending" }
  | { kind: "undated" }
  | { kind: "projected" }
  | { kind: "balance-adjustment" }
  | { kind: "investment" }
  | Extract<TransferClassification, { kind: "transfer" | "unmatched-transfer" }>;

/** Prose shown in the response, so a reader need not come here to interpret an exclusion. */
const EXCLUSION_REASONS: Record<SpendingExclusionKind, string> = {
  undated: "No transaction date and no settlement date, so it cannot be placed in any period.",
  projected:
    "Dated after the as-of date. Simplifi schedules these from recurring bills; they have not happened, and counting them would report a forecast as a measurement.",
  transfer: "One leg of a transfer between two of our own accounts. Moving money is not spending it.",
  "unmatched-transfer":
    "Marked as a transfer but its counterpart could not be confirmed, so neither counting nor pairing it would be honest. Left out and listed here instead.",
  "balance-adjustment":
    "A reconciliation entry Simplifi inserted to make a computed balance agree with the institution's. Bookkeeping, not a purchase.",
  investment:
    "Activity inside an investment account — a buy, sell, or dividend. The money changed form rather than leaving the household.",
};

/**
 * Classifies one transaction for the purpose of a spending total.
 *
 * `known` is what counterparts resolve against and should span more than the
 * period being summarised; see `partitionTransfers`. `asOf` is passed in rather
 * than read from the clock so a test asks the question on a fixed date instead of
 * depending on when it runs.
 */
export function classifySpending(
  transaction: CachedTransaction,
  known: ReadonlyMap<string, CachedTransaction>,
  asOf: string,
): SpendingClassification {
  // Undated first: a row that cannot be placed in a period cannot be reasoned
  // about as one, whatever else is true of it.
  if (transaction.transactionDate === undefined) {
    return { kind: "undated" };
  }

  // Then projected. A future-dated transfer is reported as a projection rather
  // than as a transfer, because "has not happened" is the more useful fact about
  // it and the buckets must not overlap.
  if (transaction.transactionDate > asOf) {
    return { kind: "projected" };
  }

  const transfer = classifyTransfer(transaction, known);
  if (transfer.kind !== "spending") {
    return transfer;
  }

  if (transaction.coa?.type === BALANCE_ADJUSTMENT_COA_TYPE) {
    return { kind: "balance-adjustment" };
  }

  if (transaction.type === INVESTMENT_TYPE) {
    return { kind: "investment" };
  }

  return { kind: "spending" };
}

export interface SpendingPartition {
  /** What counts. */
  spending: CachedTransaction[];
  /** What does not, grouped by why, with counts and nets. */
  exclusions: ExclusionLine[];
  /** Every transaction that was left out, paired with its classification. */
  excluded: Array<{ transaction: CachedTransaction; classification: SpendingClassification }>;
}

/** Cents from a cached row, asserting the integer invariant at the read boundary. */
export function amountCentsOf(transaction: CachedTransaction): Cents {
  return transaction.amountCents === undefined ? ZERO_CENTS : asCents(transaction.amountCents);
}

/**
 * Splits transactions into what a spending figure may include and what it may
 * not, with the exclusions grouped for reporting.
 *
 * The exclusion list carries a line per kind that actually occurred. Kinds that
 * did not occur are absent rather than present-and-zero, so the list reads as
 * "here is what happened to your data" rather than as a fixed form.
 */
export function partitionSpending(
  transactions: readonly CachedTransaction[],
  options: { known: ReadonlyMap<string, CachedTransaction>; asOf: string },
): SpendingPartition {
  const spending: CachedTransaction[] = [];
  const excluded: SpendingPartition["excluded"] = [];
  const grouped = new Map<SpendingExclusionKind, { count: number; netCents: number; transactionIds: string[] }>();

  for (const transaction of transactions) {
    const classification = classifySpending(transaction, options.known, options.asOf);

    if (classification.kind === "spending") {
      spending.push(transaction);
      continue;
    }

    excluded.push({ transaction, classification });

    const entry = grouped.get(classification.kind) ?? { count: 0, netCents: 0, transactionIds: [] };
    entry.count += 1;
    entry.netCents += amountCentsOf(transaction);
    entry.transactionIds.push(transaction.id);
    grouped.set(classification.kind, entry);
  }

  const exclusions: ExclusionLine[] = [...grouped].map(([kind, entry]) => ({
    kind,
    count: entry.count,
    netCents: asCents(entry.netCents),
    netFormatted: formatCents(asCents(entry.netCents)),
    reason: EXCLUSION_REASONS[kind],
    transactionIds: entry.transactionIds,
  }));

  // Stable order, so two runs over the same data produce the same response and a
  // diff between them means the data changed.
  exclusions.sort((left, right) => left.kind.localeCompare(right.kind));

  return { spending, exclusions, excluded };
}
