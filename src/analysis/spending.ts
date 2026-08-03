import { asCents, formatCents, type Cents } from "../money.js";
import type { TransactionDateSource } from "../transaction-date.js";
import type { CachedTransaction } from "../types.js";
import { amountCentsOf, partitionSpending } from "./classify.js";
import { assertDate, describeCoverage, monthOf, monthsBetween, periodStatus } from "./periods.js";
import type {
  BurnReport,
  CategoryFigure,
  Coverage,
  ExclusionLine,
  MonthlyBurn,
  MonthlyCategoryBreakdown,
  Provenance,
  SpendingByCategoryReport,
  TracedFigure,
  Undetermined,
} from "./types.js";

/**
 * The aggregations. Plain functions over cached transactions: no database, no
 * network, no MCP.
 *
 * That is the acceptance criterion the app depends on rather than a stylistic
 * preference. The front end and an agent must reach the same numbers through the
 * same code, and a second implementation behind a tool handler would drift from
 * this one the first time either changed.
 */

export interface AnalysisInput {
  /**
   * The transactions to summarise. Filtering to the range happens here, so
   * passing a wider set — the whole cache — is correct and gives the most
   * accurate transfer pairing.
   */
  transactions: readonly CachedTransaction[];
  /** Inclusive `YYYY-MM-DD` bounds on the transaction date. */
  from: string;
  to: string;
  /** The date to treat as today. Anything later is a projection, not history. */
  asOf: string;
  /**
   * What transfer counterparts resolve against, when wider than `transactions`.
   * Defaults to `transactions` itself.
   */
  known?: ReadonlyMap<string, CachedTransaction>;
  /** Earliest and latest transaction date the cache holds at or before `asOf`. */
  cachedEarliest?: string;
  cachedLatest?: string;
}

export interface CategoryAnalysisInput extends AnalysisInput {
  /** Category id to display name. Ids with no entry are reported as unnamed rather than dropped. */
  categoryNames?: ReadonlyMap<string, string>;
}

/** A figure and the transactions that produce it, which is the only kind of figure this layer returns. */
export function traceFigure(transactions: readonly CachedTransaction[]): TracedFigure {
  let total = 0;
  const transactionIds: string[] = [];

  for (const transaction of transactions) {
    total += amountCentsOf(transaction);
    transactionIds.push(transaction.id);
  }

  const totalCents = asCents(total);
  return {
    totalCents,
    totalFormatted: formatCents(totalCents),
    transactionCount: transactions.length,
    transactionIds,
  };
}

interface Prepared {
  spending: CachedTransaction[];
  exclusions: ExclusionLine[];
  coverage: Coverage;
  provenance: Provenance;
  undetermined: Undetermined[];
  months: string[];
}

/**
 * The work every aggregation shares: bound the range, classify, and describe
 * what the answer rests on.
 *
 * Undated rows survive the range filter deliberately. A row with no date cannot
 * be shown to be outside the requested range any more than inside it, so
 * dropping it silently would be the one thing this layer must not do; it is
 * carried through to be classified and reported instead.
 */
function prepare(input: AnalysisInput): Prepared {
  assertDate(input.from, "from");
  assertDate(input.to, "to");
  assertDate(input.asOf, "asOf");

  const known = input.known ?? new Map(input.transactions.map((transaction) => [transaction.id, transaction]));

  const inRange = input.transactions.filter(
    (transaction) =>
      transaction.transactionDate === undefined ||
      (transaction.transactionDate >= input.from && transaction.transactionDate <= input.to),
  );

  const partition = partitionSpending(inRange, { known, asOf: input.asOf });

  const dateFieldSources: Record<TransactionDateSource, number> = { "cpData.txnOn": 0, postedOn: 0 };
  for (const transaction of partition.spending) {
    if (transaction.transactionDateSource !== undefined) {
      dateFieldSources[transaction.transactionDateSource] += 1;
    }
  }

  const coverage = describeCoverage({
    requestedFrom: input.from,
    requestedTo: input.to,
    cachedEarliest: input.cachedEarliest,
    cachedLatest: input.cachedLatest,
    asOf: input.asOf,
  });

  const undetermined: Undetermined[] = [];
  for (const shortfall of coverage.shortfalls) {
    undetermined.push({
      what: "The requested range is not fully covered by the cache.",
      why: shortfall.detail,
      transactionIds: [],
    });
  }

  return {
    spending: partition.spending,
    exclusions: partition.exclusions,
    coverage,
    provenance: {
      dateField: "transactionDate",
      dateFieldSources,
      requestedFrom: input.from,
      requestedTo: input.to,
      asOf: input.asOf,
    },
    undetermined,
    months: monthsBetween(input.from, input.to),
  };
}

/** Rows carrying split lines, which have no top-level category to attribute. */
function isSplit(transaction: CachedTransaction): boolean {
  return Array.isArray(transaction.split?.items);
}

const UNCATEGORIZED_LABEL = "(uncategorized)";
const SPLIT_LABEL = "(split — category not determined)";

/**
 * Which bucket a transaction's spending belongs to.
 *
 * Splits get their own bucket rather than falling into uncategorized. A split can
 * carry its categories below the top-level `coa`, so calling it uncategorized
 * would conflate "one level down" with "missing". Two different facts deserve
 * two different buckets.
 */
function bucketOf(
  transaction: CachedTransaction,
  categoryNames: ReadonlyMap<string, string>,
): { key: string; categoryId: string | null; categoryName: string } {
  if (isSplit(transaction)) {
    return { key: SPLIT_LABEL, categoryId: null, categoryName: SPLIT_LABEL };
  }

  const id = transaction.coa?.type === "CATEGORY" ? transaction.coa.id : undefined;
  if (typeof id !== "string" || id.length === 0 || id === "0") {
    return { key: UNCATEGORIZED_LABEL, categoryId: null, categoryName: UNCATEGORIZED_LABEL };
  }

  return { key: id, categoryId: id, categoryName: categoryNames.get(id) ?? `(unnamed category ${id})` };
}

/**
 * Spending by category, by calendar month.
 *
 * Each month's category figures partition that month's total exactly — same
 * transactions, grouped — so summing the categories reproduces the total and
 * summing either one's cited ids reproduces it again.
 */
export function spendingByCategoryByMonth(input: CategoryAnalysisInput): SpendingByCategoryReport {
  const prepared = prepare(input);
  const categoryNames = input.categoryNames ?? new Map<string, string>();

  const byMonth = new Map<string, CachedTransaction[]>();
  for (const transaction of prepared.spending) {
    // Every row in `spending` is dated: the undated ones were classified out.
    const month = monthOf(transaction.transactionDate as string);
    const bucket = byMonth.get(month) ?? [];
    bucket.push(transaction);
    byMonth.set(month, bucket);
  }

  const months: MonthlyCategoryBreakdown[] = prepared.months.map((month) => {
    const transactions = byMonth.get(month) ?? [];

    const grouped = new Map<string, { categoryId: string | null; categoryName: string; rows: CachedTransaction[] }>();
    for (const transaction of transactions) {
      const bucket = bucketOf(transaction, categoryNames);
      const entry = grouped.get(bucket.key) ?? {
        categoryId: bucket.categoryId,
        categoryName: bucket.categoryName,
        rows: [],
      };
      entry.rows.push(transaction);
      grouped.set(bucket.key, entry);
    }

    const categories: CategoryFigure[] = [...grouped.values()]
      .map((entry) => ({
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
        figure: traceFigure(entry.rows),
      }))
      // Largest movement first, which is what a reader scans for. Name breaks
      // ties so the same data always produces the same order.
      .sort(
        (left, right) =>
          Math.abs(right.figure.totalCents) - Math.abs(left.figure.totalCents) ||
          left.categoryName.localeCompare(right.categoryName),
      );

    return {
      period: periodStatus(month, prepared.coverage, input.asOf),
      total: traceFigure(transactions),
      categories,
    };
  });

  const splitRows = prepared.spending.filter(isSplit);
  const undetermined = [...prepared.undetermined];
  if (splitRows.length > 0) {
    undetermined.push({
      what: `The category of ${splitRows.length} split transaction${splitRows.length === 1 ? "" : "s"} could not be determined.`,
      why: "A split carries its categories on its line items, not on the transaction, and this layer does not open them. Their amounts are counted in the month totals but grouped under a split bucket rather than attributed to a category.",
      transactionIds: splitRows.map((transaction) => transaction.id),
    });
  }

  return {
    months,
    exclusions: prepared.exclusions,
    undetermined,
    coverage: prepared.coverage,
    provenance: prepared.provenance,
  };
}

/**
 * Money out, money in, and the difference, by calendar month.
 *
 * The average is taken over complete months only. A month three days old
 * averaged in with twelve finished ones does not read as a small sample; it
 * reads as a sudden drop in spending, which is a wrong answer wearing a
 * measurement's clothes. When no month in the range is complete there is no
 * average at all — the field is absent and the reason is stated.
 */
export function monthlyBurn(input: AnalysisInput): BurnReport {
  const prepared = prepare(input);

  const byMonth = new Map<string, CachedTransaction[]>();
  for (const transaction of prepared.spending) {
    const month = monthOf(transaction.transactionDate as string);
    const bucket = byMonth.get(month) ?? [];
    bucket.push(transaction);
    byMonth.set(month, bucket);
  }

  const months: MonthlyBurn[] = prepared.months.map((month) => {
    const transactions = byMonth.get(month) ?? [];

    return {
      period: periodStatus(month, prepared.coverage, input.asOf),
      outflow: traceFigure(transactions.filter((transaction) => amountCentsOf(transaction) < 0)),
      inflow: traceFigure(transactions.filter((transaction) => amountCentsOf(transaction) > 0)),
      net: traceFigure(transactions),
    };
  });

  const complete = months.filter((month) => month.period.complete);
  const undetermined = [...prepared.undetermined];

  let averageMonthlyOutflowCents: Cents | undefined;
  let averageMonthlyOutflowFormatted: string | undefined;

  if (complete.length === 0) {
    undetermined.push({
      what: "Average monthly outflow could not be computed.",
      why: "No month in the requested range is both finished and fully covered by the cache. Averaging over a partial month would report an extrapolation as a measurement, so no figure is given.",
      transactionIds: [],
    });
  } else {
    const total = complete.reduce((sum, month) => sum + month.outflow.totalCents, 0);
    // Rounding half away from zero, as everywhere else money is rounded, so an
    // average and its negation differ only in sign.
    const magnitude = Math.round(Math.abs(total) / complete.length);
    averageMonthlyOutflowCents = asCents(total < 0 ? -magnitude : magnitude);
    averageMonthlyOutflowFormatted = formatCents(averageMonthlyOutflowCents);
  }

  return {
    months,
    averageMonthlyOutflowCents,
    averageMonthlyOutflowFormatted,
    completeMonthsUsed: complete.map((month) => month.period.month),
    exclusions: prepared.exclusions,
    undetermined,
    coverage: prepared.coverage,
    provenance: prepared.provenance,
  };
}

/** Shared by the recurring-charge analysis, which needs the same preparation. */
export const prepareForAnalysis = prepare;
