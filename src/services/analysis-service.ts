import {
  monthlyBurn,
  recurringChargeChanges,
  spendingByCategoryByMonth,
  type BurnReport,
  type RecurringChargeReport,
  type SpendingByCategoryReport,
} from "../analysis/index.js";
import { monthBounds } from "../analysis/periods.js";
import { DatabaseContext } from "../db/database.js";
import { SyncService } from "../sync/sync-service.js";
import type { CachedTransaction } from "../types.js";
import { ReferenceDataService } from "./reference-data-service.js";

/**
 * Loads what an aggregation needs and calls it. Nothing more.
 *
 * The arithmetic lives in `src/analysis/`, which knows nothing about SQLite or
 * MCP. This class is the seam between them: it decides what to read, and the
 * analysis layer decides what the numbers mean. Anything that looks like a sum
 * belongs on the other side of that line.
 */

export interface AnalysisRangeInput {
  /** Inclusive `YYYY-MM-DD`. Defaults to the twelve months ending at the as-of date. */
  from?: string;
  to?: string;
  /** The date to treat as today. Defaults to the local date; passed in so a test can fix it. */
  asOf?: string;
  accountId?: string;
  refresh?: boolean;
}

/** Local calendar date, not UTC: a transaction on the evening of the 31st belongs to that month. */
export function localToday(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** First day of the month `count - 1` months before the one containing `asOf`. */
function defaultFrom(asOf: string, count = 12): string {
  const year = Number(asOf.slice(0, 4));
  const monthIndex = Number(asOf.slice(5, 7)) - 1 - (count - 1);
  const shifted = new Date(Date.UTC(year, monthIndex, 1));
  return monthBounds(`${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`).from;
}

export class AnalysisService {
  public constructor(
    private readonly db: DatabaseContext,
    private readonly syncService: SyncService,
    private readonly referenceDataService: ReferenceDataService,
    private readonly maxStaleMs: number,
  ) {}

  public async spendingByCategory(input: AnalysisRangeInput = {}): Promise<SpendingByCategoryReport> {
    const loaded = await this.load(input);
    return spendingByCategoryByMonth({ ...loaded, categoryNames: this.categoryNames() });
  }

  public async monthlyBurn(input: AnalysisRangeInput = {}): Promise<BurnReport> {
    return monthlyBurn(await this.load(input));
  }

  public async recurringCharges(
    input: AnalysisRangeInput & {
      minOccurrences?: number;
      minChangeCents?: number;
      minEstablishedRun?: number;
    } = {},
  ): Promise<RecurringChargeReport> {
    const loaded = await this.load(input);
    return recurringChargeChanges({
      ...loaded,
      minOccurrences: input.minOccurrences,
      minChangeCents: input.minChangeCents,
      minEstablishedRun: input.minEstablishedRun,
    });
  }

  private categoryNames(): Map<string, string> {
    const names = new Map<string, string>();
    for (const category of this.db.listCategories()) {
      if (typeof category.id === "string" && typeof category.name === "string") {
        names.set(category.id, category.name);
      }
    }
    return names;
  }

  /**
   * Reads the range, plus whatever is needed to interpret it honestly.
   *
   * Two reads beyond the obvious one. Transfer counterparts outside the range
   * are fetched by id so a pair straddling the boundary is still recognised as a
   * pair; and the cache's own coverage is read so the answer can say what it
   * could not see rather than returning a quietly short total.
   */
  private async load(input: AnalysisRangeInput): Promise<{
    transactions: CachedTransaction[];
    known: Map<string, CachedTransaction>;
    from: string;
    to: string;
    asOf: string;
    cachedEarliest?: string;
    cachedLatest?: string;
  }> {
    if (input.refresh) {
      // An analysis figure is exactly where a silently-stale refresh does the
      // most damage: the number looks current and nothing in it says otherwise.
      if (!this.syncService.canExplicitlyRefresh) {
        throw new Error(`${SyncService.READ_ONLY_REASON} Retry without refresh to accept the cached answer.`);
      }

      await this.syncService.syncIncremental();
    } else {
      await this.syncService.ensureFresh(this.maxStaleMs);
    }

    await this.referenceDataService.ensureCategoriesFresh(this.maxStaleMs);

    const asOf = input.asOf ?? localToday();
    const to = input.to ?? asOf;
    const from = input.from ?? defaultFrom(asOf);

    const transactions = this.db.listTransactionsInRange({
      dateFrom: from,
      dateTo: to,
      accountId: input.accountId,
    });

    const known = new Map(transactions.map((transaction) => [transaction.id, transaction]));

    const missingCounterparts = new Set<string>();
    for (const transaction of transactions) {
      const counterpartId = transaction.transfer?.id;
      if (typeof counterpartId === "string" && counterpartId.length > 0 && !known.has(counterpartId)) {
        missingCounterparts.add(counterpartId);
      }
    }

    for (const counterpart of this.db.getTransactionsByIds([...missingCounterparts])) {
      known.set(counterpart.id, counterpart);
    }

    const coverage = this.db.getTransactionCoverage({ asOf });

    return {
      transactions,
      known,
      from,
      to,
      asOf,
      cachedEarliest: coverage.earliest,
      cachedLatest: coverage.latest,
    };
  }
}
