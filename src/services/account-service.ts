import { DatabaseContext } from "../db/database.js";
import { logInfo } from "../logger.js";
import { SimplifiClient } from "../simplifi/client.js";
import type { Account, CachedAccount, CachedScheduledTransaction, ScheduledTransaction } from "../types.js";

/**
 * Accounts and scheduled transactions: balances, and what is owed when.
 *
 * Kept apart from transaction sync because it answers a different question and
 * fails independently. A transaction sync is incremental; these endpoints return
 * complete collections, so their cached rows are replaced wholesale rather than
 * merged and allowed to retain stale entries.
 */
export class AccountService {
  /** In-memory freshness marks. The data is cheap to refetch; a schema column is not worth it. */
  private accountsSyncedAt: number | undefined;
  private scheduledSyncedAt: number | undefined;

  public constructor(
    private readonly db: DatabaseContext,
    private readonly client: SimplifiClient,
  ) {}

  public async ensureAccountsFresh(maxAgeMs: number): Promise<void> {
    // A reader serves the writer's last replacement. `replaceAccounts` is a
    // delete-then-insert, so a reader that tried would fail partway through if
    // it could write at all.
    if (this.db.readOnly) {
      return;
    }

    if (this.accountsSyncedAt !== undefined && Date.now() - this.accountsSyncedAt <= maxAgeMs) {
      return;
    }

    await this.syncAccounts();
  }

  public async ensureScheduledFresh(maxAgeMs: number): Promise<void> {
    if (this.db.readOnly) {
      return;
    }

    if (this.scheduledSyncedAt !== undefined && Date.now() - this.scheduledSyncedAt <= maxAgeMs) {
      return;
    }

    await this.syncScheduledTransactions();
  }

  public async syncAccounts(): Promise<number> {
    const resources: Account[] = [];
    let nextLink: string | undefined;
    let pages = 0;

    do {
      const payload = nextLink
        ? await this.client.listAccountsFromNextLink(nextLink)
        : await this.client.listAccounts({ limit: 5000 });

      pages += 1;
      resources.push(...payload.resources);
      nextLink = payload.metaData.nextLink;
    } while (nextLink);

    this.db.replaceAccounts(resources);
    this.accountsSyncedAt = Date.now();
    logInfo("Synced accounts", { pages, total: resources.length });

    return resources.length;
  }

  public async syncScheduledTransactions(): Promise<number> {
    const resources: ScheduledTransaction[] = [];
    let nextLink: string | undefined;
    let pages = 0;

    do {
      const payload = nextLink
        ? await this.client.listScheduledTransactionsFromNextLink(nextLink)
        : await this.client.listScheduledTransactions({ limit: 5000 });

      pages += 1;
      resources.push(...payload.resources);
      nextLink = payload.metaData.nextLink;
    } while (nextLink);

    this.db.replaceScheduledTransactions(resources);
    this.scheduledSyncedAt = Date.now();
    logInfo("Synced scheduled transactions", { pages, total: resources.length });

    return resources.length;
  }

  public listAccounts(options: { includeClosed?: boolean; type?: string } = {}): CachedAccount[] {
    return this.db.listAccounts(options);
  }

  /**
   * Credit accounts carrying a statement, soonest due first.
   *
   * Accounts with no statement are filtered out rather than reported with blank
   * fields, because a row of nulls in a list of bills reads as a bill of zero.
   */
  public listCreditCardStatements(): CachedAccount[] {
    return this.db
      .listAccounts({ type: "CREDIT" })
      .filter((account) => account.statementDueAt !== undefined || account.statementDueAmountCents !== undefined)
      .sort((left, right) => String(left.statementDueAt ?? "").localeCompare(String(right.statementDueAt ?? "")));
  }

  public listScheduledTransactions(
    options: { from?: string; to?: string; type?: string; includeCompleted?: boolean } = {},
  ): CachedScheduledTransaction[] {
    return this.db.listScheduledTransactions(options);
  }
}
