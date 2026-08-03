import { DatabaseContext, type TransactionQuery } from "../db/database.js";
import type { Transaction, TransactionFilters } from "../types.js";
import { SimplifiClient } from "../simplifi/client.js";
import { SyncService } from "../sync/sync-service.js";
import { ReferenceDataService } from "./reference-data-service.js";

export interface ListTransactionsInput extends TransactionFilters {
  limit?: number;
  cursor?: string;
  refresh?: boolean;
}

export interface SearchTransactionsInput extends TransactionFilters {
  query: string;
  limit?: number;
  cursor?: string;
  refresh?: boolean;
}

export interface GetTransactionInput {
  transactionId: string;
  refreshOnMiss?: boolean;
}

// UpdateTransactionInput removed with the write surface. No input type in this
// module carries a patch, which is what makes "no writes" checkable by reading
// the signatures rather than by tracing the implementations.

export class TransactionToolService {
  public constructor(
    private readonly db: DatabaseContext,
    private readonly syncService: SyncService,
    private readonly simplifiClient: SimplifiClient,
    private readonly referenceDataService: ReferenceDataService,
    private readonly maxStaleMs: number,
  ) {}

  public async listTransactions(input: ListTransactionsInput): Promise<Record<string, unknown>> {
    await this.maybeRefresh(input.refresh ?? false);

    const page = this.db.listTransactions(this.toQuery(input));
    return {
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items,
    };
  }

  public async searchTransactions(input: SearchTransactionsInput): Promise<Record<string, unknown>> {
    await this.maybeRefresh(input.refresh ?? false);

    const page = this.db.searchTransactions({
      ...this.toQuery(input),
      searchTerm: input.query,
    });

    return {
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items,
    };
  }

  public async getTransaction(input: GetTransactionInput): Promise<Record<string, unknown>> {
    await this.syncService.ensureFresh(this.maxStaleMs);

    let transaction = this.db.getTransactionById(input.transactionId);
    if (!transaction && (input.refreshOnMiss ?? true)) {
      await this.syncService.syncIncremental();
      transaction = this.db.getTransactionById(input.transactionId);
    }

    if (!transaction) {
      throw new Error(`Transaction ${input.transactionId} not found in cache`);
    }

    return { transaction };
  }

  // updateTransaction and categorizeTransaction removed with the write surface.
  // No method on this service accepts a patch or mutation payload, so there is no
  // path from a tool call to a change in Simplifi.

  public async listUncategorizedTransactions(input: ListTransactionsInput): Promise<Record<string, unknown>> {
    await this.maybeRefresh(input.refresh ?? false);

    const page = this.db.listUncategorizedTransactions(this.toQuery(input));
    return {
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items,
    };
  }

  public async searchMerchants(input: { query: string; limit?: number; includeDeleted?: boolean }): Promise<Record<string, unknown>> {
    await this.syncService.ensureFresh(this.maxStaleMs);
    const merchants = this.db.searchMerchants({ q: input.query, limit: input.limit, includeDeleted: input.includeDeleted });
    return { merchants };
  }

  public async listCategories(input?: { refresh?: boolean; limit?: number }): Promise<Record<string, unknown>> {
    if (input?.refresh) {
      this.assertCanRefresh();
      await this.referenceDataService.syncCategories();
    } else {
      await this.referenceDataService.ensureCategoriesFresh(this.maxStaleMs);
    }

    const categories = this.db.listCategories({ limit: input?.limit });
    return { categories };
  }

  public async searchCategories(input: { query: string; limit?: number; refresh?: boolean }): Promise<Record<string, unknown>> {
    if (input.refresh) {
      this.assertCanRefresh();
      await this.referenceDataService.syncCategories();
    } else {
      await this.referenceDataService.ensureCategoriesFresh(this.maxStaleMs);
    }

    const categories = this.db.listCategories({ search: input.query, limit: input.limit });
    return { categories };
  }

  public async listTags(input?: { refresh?: boolean; limit?: number }): Promise<Record<string, unknown>> {
    if (input?.refresh) {
      this.assertCanRefresh();
      await this.referenceDataService.syncTags();
    } else {
      await this.referenceDataService.ensureTagsFresh(this.maxStaleMs);
    }

    const tags = this.db.listTags({ limit: input?.limit });
    return { tags };
  }

  public async searchTags(input: { query: string; limit?: number; refresh?: boolean }): Promise<Record<string, unknown>> {
    if (input.refresh) {
      this.assertCanRefresh();
      await this.referenceDataService.syncTags();
    } else {
      await this.referenceDataService.ensureTagsFresh(this.maxStaleMs);
    }

    const tags = this.db.listTags({ search: input.query, limit: input.limit });
    return { tags };
  }

  public async suggestCategoriesForMerchant(input: {
    merchant: string;
    limit?: number;
    matchMode?: "exact" | "contains";
    refreshCategories?: boolean;
  }): Promise<Record<string, unknown>> {
    if (input.refreshCategories) {
      this.assertCanRefresh();
      await this.referenceDataService.syncCategories();
    } else {
      await this.referenceDataService.ensureCategoriesFresh(this.maxStaleMs);
    }

    const suggestions = this.db.suggestCategoriesForMerchant({
      merchant: input.merchant,
      limit: input.limit,
      matchMode: input.matchMode,
    });

    return { suggestions };
  }

  /**
   * Refuses an explicit refresh this instance cannot perform.
   *
   * `refresh: true` is a caller saying a stale answer will not do. Serving one
   * anyway answers a different question than the one asked, so a reader refuses
   * rather than quietly downgrading the request to a cached read.
   */
  public assertCanRefresh(): void {
    if (!this.syncService.canExplicitlyRefresh) {
      throw new Error(`${SyncService.READ_ONLY_REASON} Retry without refresh to accept the cached answer.`);
    }
  }

  private async maybeRefresh(forceRefresh: boolean): Promise<void> {
    if (forceRefresh) {
      this.assertCanRefresh();
      await this.syncService.syncIncremental();
      return;
    }

    await this.syncService.ensureFresh(this.maxStaleMs);
  }

  private toQuery(input: {
    limit?: number;
    cursor?: string;
    accountId?: string;
    dateFrom?: string;
    dateTo?: string;
    minAmount?: number;
    maxAmount?: number;
    includeDeleted?: boolean;
  }): TransactionQuery {
    return {
      limit: Math.min(Math.max(input.limit ?? 50, 1), 200),
      cursor: input.cursor,
      accountId: input.accountId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      minAmount: input.minAmount,
      maxAmount: input.maxAmount,
      includeDeleted: input.includeDeleted,
    };
  }

  // assertUpsertRequiredFields removed: it existed only to validate a payload
  // before PUTting it to Simplifi, and there is no longer anything to PUT.
}
