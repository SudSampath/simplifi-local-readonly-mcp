import type { CachedTransaction } from "./types.js";

/**
 * Identifying transfers between our own accounts, so that moving money does not
 * read as spending it.
 *
 * Matching legs heuristically by amount and date is unnecessary because
 * Simplifi models transfers explicitly.
 *
 * - `coa.type === "ACCOUNT"` marks a transfer — the "category" is an account.
 * - `transfer.id` holds the **counterpart transaction's id**, not a shared pair
 *   key.
 * - A matched pair should be reciprocal and sum to exactly zero cents.
 *
 * So pairing is a lookup. The unmatched cases still matter: a counterpart can be
 * absent, a transfer id can be missing, or the link can be non-reciprocal. Those
 * rows are neither silently included nor silently excluded.
 */

/** The `coa.type` value Simplifi uses when the other side is one of our accounts. */
const TRANSFER_COA_TYPE = "ACCOUNT";

export type TransferClassification =
  /** Not a transfer. Ordinary spending or income. */
  | { kind: "spending" }
  /** A transfer whose counterpart is present in the same result set. */
  | { kind: "transfer"; counterpartId: string }
  /**
   * Marked as a transfer, but its counterpart could not be resolved. Excluded
   * from spending and reported, because an exclusion nobody can see is
   * indistinguishable from a bug.
   */
  | {
      kind: "unmatched-transfer";
      reason: "counterpart-not-cached" | "no-counterpart-id" | "counterpart-does-not-reciprocate";
      counterpartId?: string;
    };

export interface TransferSummary {
  /** Transactions that count as spending or income. */
  spending: CachedTransaction[];
  /** Both legs of every matched transfer. */
  transfers: CachedTransaction[];
  /** Transfer-shaped rows whose counterpart could not be resolved. */
  unmatched: Array<{ transaction: CachedTransaction; classification: TransferClassification }>;
  /** How many matched transfer legs were excluded. */
  excludedCount: number;
  /** Net cents across excluded legs. Zero when every pair is complete. */
  excludedNetCents: number;
}

export function isTransferShaped(transaction: CachedTransaction): boolean {
  return transaction.coa?.type === TRANSFER_COA_TYPE;
}

function counterpartIdOf(transaction: CachedTransaction): string | undefined {
  const id = transaction.transfer?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Classifies one transaction against the set it was drawn from.
 *
 * `known` maps id to transaction for everything available to resolve
 * counterparts against. Passing a page rather than the whole cache would report
 * legs as unmatched merely because the other one fell on the next page, so
 * callers must pass a set spanning what they are summarising.
 *
 * A pair is accepted only when the link is **reciprocal** — A names B and B
 * names A. A one-way link is not evidence of a balanced pair; excluding it as
 * though it cancelled could silently remove spending that was never accounted for.
 */
export function classifyTransfer(
  transaction: CachedTransaction,
  known: ReadonlyMap<string, CachedTransaction>,
): TransferClassification {
  if (!isTransferShaped(transaction)) {
    return { kind: "spending" };
  }

  const counterpartId = counterpartIdOf(transaction);

  if (counterpartId === undefined) {
    return { kind: "unmatched-transfer", reason: "no-counterpart-id" };
  }

  const counterpart = known.get(counterpartId);

  if (counterpart === undefined) {
    return { kind: "unmatched-transfer", reason: "counterpart-not-cached", counterpartId };
  }

  if (counterpartIdOf(counterpart) !== transaction.id) {
    return { kind: "unmatched-transfer", reason: "counterpart-does-not-reciprocate", counterpartId };
  }

  return { kind: "transfer", counterpartId };
}

/**
 * Splits a set of transactions into spending, matched transfers, and unmatched
 * transfer candidates.
 *
 * Every caller that reports a total is expected to report `excludedCount` with
 * it. The requirement is deliberate: an exclusion that cannot be seen is
 * indistinguishable from a bug, and that matters most when the person reading
 * the number is not the person who wrote the query.
 */
export function partitionTransfers(
  transactions: readonly CachedTransaction[],
  options: {
    /**
     * What counterparts may be resolved against, when that is wider than the set
     * being partitioned.
     *
     * An aggregation over one month holds only that month's rows, and a transfer
     * whose legs straddle the boundary would otherwise be reported as
     * `counterpart-not-cached` — an unmatched leg invented by the window rather
     * than by the data. Passing the wider set makes the reason mean what it says.
     * The net of excluded legs can then be non-zero, because only one leg of a
     * straddling pair falls inside; that is reported, not hidden.
     */
    known?: ReadonlyMap<string, CachedTransaction>;
  } = {},
): TransferSummary {
  const known = options.known ?? new Map(transactions.map((transaction) => [transaction.id, transaction]));

  const spending: CachedTransaction[] = [];
  const transfers: CachedTransaction[] = [];
  const unmatched: TransferSummary["unmatched"] = [];
  let excludedNetCents = 0;

  for (const transaction of transactions) {
    const classification = classifyTransfer(transaction, known);

    if (classification.kind === "spending") {
      spending.push(transaction);
      continue;
    }

    if (classification.kind === "transfer") {
      transfers.push(transaction);
      excludedNetCents += transaction.amountCents ?? 0;
      continue;
    }

    unmatched.push({ transaction, classification });
  }

  return {
    spending,
    transfers,
    unmatched,
    excludedCount: transfers.length,
    excludedNetCents,
  };
}
