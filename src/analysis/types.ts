import type { Cents } from "../money.js";
import type { TransactionDateSource } from "../transaction-date.js";

/**
 * The shapes the analysis layer returns.
 *
 * One rule runs through all of them: **a figure travels with the transactions
 * that produced it.** Not a count, not a sample — the ids, so that re-summing
 * them in cents reproduces the figure exactly. That is what makes an answer
 * auditable by someone who did not write the query, which is the case this whole
 * project is built for.
 */

/**
 * A money figure and everything needed to check it.
 *
 * `transactionIds` is the complete list, deliberately. Truncating it would leave
 * a figure that looks traceable and is not, and the one operation that proves a
 * total honest — re-summing the cited ids — would stop working. Responses are
 * therefore large in proportion to the range asked about; bound them with the
 * date range rather than by dropping provenance.
 */
export interface TracedFigure {
  totalCents: Cents;
  /** Decimal string for display. Never parse this back into a number. */
  totalFormatted: string;
  transactionCount: number;
  transactionIds: string[];
}

/**
 * Why a set of transactions was left out of a spending figure.
 *
 * Every exclusion is reported with its count and its net, because an exclusion
 * nobody can see is indistinguishable from a bug — the failure SUD-14 was
 * written to prevent, and the reason each of these kinds exists at all.
 */
export type SpendingExclusionKind =
  /** No usable date, so it cannot be placed in any period. */
  | "undated"
  /** Dated after the as-of date: a projection Simplifi has scheduled, not something that happened. */
  | "projected"
  /** One leg of a reciprocally linked transfer between our own accounts. */
  | "transfer"
  /** Transfer-shaped, counterpart unresolved. Neither counted nor silently dropped. */
  | "unmatched-transfer"
  /** A reconciliation entry Simplifi inserted to make a balance agree. Not a purchase. */
  | "balance-adjustment"
  /** Activity inside an investment account — a buy is not a purchase in the household sense. */
  | "investment";

export interface ExclusionLine {
  kind: SpendingExclusionKind;
  count: number;
  netCents: Cents;
  netFormatted: string;
  /** Prose, in the response itself, so the reader does not have to find this file. */
  reason: string;
  transactionIds: string[];
}

/**
 * Something the data could not answer.
 *
 * Reported rather than estimated. The distinction matters most when the reader
 * would otherwise assume a zero means "none" when it means "unknown".
 */
export interface Undetermined {
  what: string;
  why: string;
  transactionIds: string[];
}

/** Which dates and which field produced the figures. */
export interface Provenance {
  /**
   * Always the resolved transaction date — `cpData.txnOn` where present, else
   * `postedOn`. Named in the response because the two can fall in different months.
   */
  dateField: "transactionDate";
  /** How many of the transactions summarised used each underlying field. */
  dateFieldSources: Record<TransactionDateSource, number>;
  requestedFrom: string;
  requestedTo: string;
  /** The date "now" was taken to be. Anything after it is a projection. */
  asOf: string;
}

export type ShortfallKind =
  | "cache-starts-after-requested-from"
  | "cache-ends-before-requested-to"
  | "requested-range-extends-beyond-as-of"
  | "cache-is-empty";

export interface Shortfall {
  kind: ShortfallKind;
  detail: string;
}

/** What the cache actually covers, against what was asked for. */
export interface Coverage {
  requested: { from: string; to: string };
  /** Earliest and latest dated transaction at or before the as-of date. Absent when the cache holds none. */
  covered: { from?: string; to?: string };
  /** True only when the requested range lies wholly inside the covered range and wholly at or before the as-of date. */
  complete: boolean;
  shortfalls: Shortfall[];
}

export type IncompleteReason =
  | "month-starts-before-cache-coverage"
  | "month-ends-after-cache-coverage"
  | "month-not-finished";

/** A calendar month, and whether the figures for it describe all of it. */
export interface PeriodStatus {
  /** `YYYY-MM`. */
  month: string;
  from: string;
  to: string;
  complete: boolean;
  incompleteReasons: IncompleteReason[];
}

export interface CategoryFigure {
  /**
   * The `coa.id` the transactions carried, or null when there is none to carry.
   * Null is not an error: uncategorized and split transactions can both lack one.
   */
  categoryId: string | null;
  categoryName: string;
  figure: TracedFigure;
}

export interface MonthlyCategoryBreakdown {
  period: PeriodStatus;
  /** The month's spending total. The category figures below partition exactly this. */
  total: TracedFigure;
  categories: CategoryFigure[];
}

export interface SpendingByCategoryReport {
  months: MonthlyCategoryBreakdown[];
  exclusions: ExclusionLine[];
  undetermined: Undetermined[];
  coverage: Coverage;
  provenance: Provenance;
}

export interface MonthlyBurn {
  period: PeriodStatus;
  /** Money out. The sum of the negative amounts, so it is itself negative. */
  outflow: TracedFigure;
  /** Money in. */
  inflow: TracedFigure;
  /** Inflow plus outflow. Negative means the month spent more than it took in. */
  net: TracedFigure;
}

export interface BurnReport {
  months: MonthlyBurn[];
  /**
   * Mean outflow across **complete** months only, or undefined when there are
   * none. Never an extrapolation from a partial month: a month three days in
   * would drag the mean toward zero while looking like a measurement.
   */
  averageMonthlyOutflowCents?: Cents;
  averageMonthlyOutflowFormatted?: string;
  /** Which months the average was taken over. Empty when there is no average. */
  completeMonthsUsed: string[];
  exclusions: ExclusionLine[];
  undetermined: Undetermined[];
  coverage: Coverage;
  provenance: Provenance;
}

export type Cadence = "weekly" | "monthly" | "quarterly" | "annual";

/**
 * A recurring charge whose amount changed, with the transactions evidencing
 * each amount.
 *
 * Both sides are traced. "It went up by four dollars" is a claim; the two runs
 * of transactions that show it are the evidence.
 */
export interface RecurringChargeChange {
  merchant: string;
  cadence: Cadence;
  direction: "increased" | "decreased";
  /** What one charge cost before the change. Negative, as an outflow is. */
  beforeAmountCents: Cents;
  beforeAmountFormatted: string;
  /** The run of charges at that amount. Its total is `beforeAmountCents` times its count. */
  before: TracedFigure;
  /** What one charge costs now. */
  afterAmountCents: Cents;
  afterAmountFormatted: string;
  after: TracedFigure;
  /** Change in cost per charge. Positive means it costs more now, whichever sign the amounts carry. */
  changeCents: Cents;
  changeFormatted: string;
  /** Date of the first charge at the new amount. */
  changedOn: string;
  occurrenceCount: number;
}

export interface RecurringChargeReport {
  changes: RecurringChargeChange[];
  /** Recurring charges examined whose amount has not moved. Counted, not listed. */
  steadyCount: number;
  /**
   * Merchants with enough charges to look recurring but no regular spacing, so
   * no cadence could be assigned. Reported rather than dropped: "not a
   * subscription" is a finding, and a caller may disagree with it.
   */
  irregularMerchants: string[];
  /**
   * Merchants charged on a regular cadence whose amount differs nearly every
   * time — a weekly grocery run, a fuel stop. They have no established price to
   * have moved away from, so no change is reported for them.
   *
   * Listed because the alternative is worse in both directions: reporting them
   * as changes buries the real ones, and dropping them silently hides that the
   * question was asked about them at all.
   */
  variableAmountMerchants: string[];
  exclusions: ExclusionLine[];
  undetermined: Undetermined[];
  coverage: Coverage;
  provenance: Provenance;
}
