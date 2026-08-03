import type { Transaction } from "./types.js";

/**
 * Which field a transaction's date came from.
 *
 * Reported alongside the date rather than inferred, because the two fields mean
 * genuinely different things and a total that mixes them without saying so is
 * the kind of number that looks right and is not.
 */
export type TransactionDateSource = "cpData.txnOn" | "postedOn";

export interface ResolvedTransactionDate {
  /** `YYYY-MM-DD`. */
  date: string;
  source: TransactionDateSource;
}

/**
 * Resolves the date a transaction actually occurred.
 *
 * `postedOn` is the settlement date, which can differ from `cpData.txnOn` and
 * can cross a month boundary. Filtering or grouping on `postedOn` can therefore
 * attribute a transaction to the wrong month.
 *
 * `dateOn`, which the inherited types carried, does not exist in any response.
 *
 * Some rows have no `cpData` at all, including manual entries and scheduled
 * transactions. For those `postedOn` is the only date there is, so it is the
 * fallback. That fallback is deliberate rather than incidental, which is why the
 * source is returned rather than being left for a caller to guess.
 */
export function resolveTransactionDate(transaction: Transaction): ResolvedTransactionDate | undefined {
  const txnOn = readDate(transaction.cpData?.txnOn);
  if (txnOn !== undefined) {
    return { date: txnOn, source: "cpData.txnOn" };
  }

  const postedOn = readDate(transaction.postedOn);
  if (postedOn !== undefined) {
    return { date: postedOn, source: "postedOn" };
  }

  return undefined;
}

/**
 * Normalises to `YYYY-MM-DD`.
 *
 * Both fields are observed as date-only strings, but upstream has changed shape
 * before. Truncating a timestamp is safe; accepting one verbatim would make
 * string comparison against a `YYYY-MM-DD` bound behave differently for rows
 * that happen to carry a time.
 */
function readDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match?.[1];
}
