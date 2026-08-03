import { DatabaseContext } from "../db/database.js";
import { logInfo } from "../logger.js";
import { asCents, formatCents, sumCents } from "../money.js";
import { SimplifiClient } from "../simplifi/client.js";
import type {
  Account,
  AccountValueSource,
  CachedAccount,
  CachedScheduledTransaction,
  ScheduledTransaction,
} from "../types.js";
import { RefreshCoordinator } from "../runtime/refresh-coordinator.js";
import { nowIso } from "../utils.js";

export interface NetWorthAccountLine {
  accountId: string;
  accountName?: string;
  accountType?: string;
  valueCents: number;
  valueFormatted: string;
  valueSource: AccountValueSource;
}

export interface NetWorthExclusion {
  accountId: string;
  accountName?: string;
  reason: "closed" | "ignored" | "no-current-value";
}

export interface NetWorthReport {
  totalCents: number;
  totalFormatted: string;
  accounts: NetWorthAccountLine[];
  exclusions: NetWorthExclusion[];
}

/**
 * Accounts and scheduled transactions: balances, and what is owed when.
 *
 * Kept apart from transaction sync because it answers a different question and
 * fails independently. A transaction sync is incremental; these endpoints return
 * complete collections, so their cached rows are replaced wholesale rather than
 * merged and allowed to retain stale entries.
 */
export class AccountService {
  public constructor(
    private readonly db: DatabaseContext,
    private readonly client: SimplifiClient,
    private readonly refreshCoordinator?: RefreshCoordinator,
  ) {}

  public async ensureAccountsFresh(maxAgeMs: number): Promise<void> {
    const lastSyncAt = this.db.getCollectionSyncState().accountsLastSyncAt;
    if (lastSyncAt && Date.now() - new Date(lastSyncAt).getTime() <= maxAgeMs) {
      return;
    }

    await this.syncAccounts();
  }

  public async ensureScheduledFresh(maxAgeMs: number): Promise<void> {
    const lastSyncAt = this.db.getCollectionSyncState().scheduledLastSyncAt;
    if (lastSyncAt && Date.now() - new Date(lastSyncAt).getTime() <= maxAgeMs) {
      return;
    }

    await this.syncScheduledTransactions();
  }

  public async syncAccounts(): Promise<number> {
    if (this.db.readOnly && !this.refreshCoordinator?.canRefresh) {
      throw new Error("This instance cannot refresh accounts because it has no cache-writer coordinator.");
    }

    if (this.refreshCoordinator) {
      return this.refreshCoordinator.run("accounts", () => this.doSyncAccounts());
    }

    return this.doSyncAccounts();
  }

  private async doSyncAccounts(): Promise<number> {
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
    this.db.updateCollectionSyncState({ accountsLastSyncAt: nowIso(), lastError: undefined });
    logInfo("Synced accounts", { pages, total: resources.length });

    return resources.length;
  }

  public async syncScheduledTransactions(): Promise<number> {
    if (this.db.readOnly && !this.refreshCoordinator?.canRefresh) {
      throw new Error("This instance cannot refresh scheduled transactions because it has no cache-writer coordinator.");
    }

    if (this.refreshCoordinator) {
      return this.refreshCoordinator.run("scheduled-transactions", () => this.doSyncScheduledTransactions());
    }

    return this.doSyncScheduledTransactions();
  }

  private async doSyncScheduledTransactions(): Promise<number> {
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
    this.db.updateCollectionSyncState({ scheduledLastSyncAt: nowIso(), lastError: undefined });
    logInfo("Synced scheduled transactions", { pages, total: resources.length });

    return resources.length;
  }

  public listAccounts(options: { includeClosed?: boolean; type?: string } = {}): CachedAccount[] {
    return this.db.listAccounts(options);
  }

  /**
   * Sums the canonical signed value of each open, non-ignored account.
   * Every included and excluded account is returned so the total can be audited.
   */
  public netWorth(): NetWorthReport {
    const accounts: NetWorthAccountLine[] = [];
    const exclusions: NetWorthExclusion[] = [];

    for (const account of this.db.listAccounts({ includeClosed: true })) {
      const excluded = (reason: NetWorthExclusion["reason"]): void => {
        exclusions.push({ accountId: account.id, accountName: account.name, reason });
      };

      if (account.isClosed) {
        excluded("closed");
      } else if (account.isIgnored) {
        excluded("ignored");
      } else if (account.valueCents === undefined || account.valueSource === undefined) {
        excluded("no-current-value");
      } else {
        accounts.push({
          accountId: account.id,
          accountName: account.name,
          accountType: account.type,
          valueCents: account.valueCents,
          valueFormatted: formatCents(asCents(account.valueCents)),
          valueSource: account.valueSource,
        });
      }
    }

    const total = sumCents(accounts.map((account) => asCents(account.valueCents)));
    return { totalCents: total, totalFormatted: formatCents(total), accounts, exclusions };
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
