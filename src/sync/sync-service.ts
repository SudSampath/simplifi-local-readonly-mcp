import type { AppConfig } from "../config.js";
import { DatabaseContext } from "../db/database.js";
import { logError, logInfo } from "../logger.js";
import { nowIso } from "../utils.js";
import { SimplifiClient } from "../simplifi/client.js";

export interface SyncResult {
  /**
   * `read-only` means this instance is a reader and declined to sync. It is a
   * distinct outcome from `noop`: a noop means the cache was already fresh
   * enough, a read-only means freshness was never checked and cannot be.
   */
  mode: "full" | "incremental" | "noop" | "read-only";
  pages: number;
  transactions: number;
  asOf?: string;
  /** Why a `read-only` result declined. Absent on the modes that ran. */
  reason?: string;
}

export class SyncService {
  private intervalHandle: NodeJS.Timeout | null = null;
  private activeSync: Promise<SyncResult> | null = null;
  /**
   * The last background failure already reported. A stuck cause — a dead
   * refresh token being the usual one — otherwise writes an identical line
   * every interval for the life of the process, which buries anything real.
   */
  private lastReportedFailure: string | null = null;

  public constructor(
    private readonly config: AppConfig["simplifi"],
    private readonly db: DatabaseContext,
    private readonly client: SimplifiClient,
  ) {}

  /**
   * The refusal a reader returns from every sync entry point.
   *
   * Carried in the result rather than thrown. A tool call in a reader should
   * still answer from the cache; what it must not do is present that answer as
   * freshly synced.
   */
  public static readonly READ_ONLY_REASON =
    "This instance is serving the cache read-only because another process holds the writer lease, so it cannot refresh from Simplifi. " +
    "Figures are as fresh as the last sync performed by the writer.";

  /**
   * Note on where this is enforced: `syncFull` and `syncIncremental` are the
   * guards that matter, because every path to a write goes through one of them.
   * The checks in `ensureInitialized` and `ensureFresh` are short-circuits that
   * skip a pointless state read — removing either changes no outcome. Do not
   * mistake them for the protection.
   */
  private readOnlyResult(): SyncResult {
    return {
      mode: "read-only",
      pages: 0,
      transactions: 0,
      asOf: this.db.getSyncState().lastAsOf,
      reason: SyncService.READ_ONLY_REASON,
    };
  }

  public start(): void {
    // A reader has nothing to run on an interval, and starting one would keep
    // the process alive past its usefulness while failing every tick.
    if (this.db.readOnly) {
      return;
    }

    if (this.intervalHandle) {
      return;
    }

    this.intervalHandle = setInterval(() => {
      void this.syncIncremental().then(
        () => {
          this.lastReportedFailure = null;
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message === this.lastReportedFailure) {
            return;
          }

          this.lastReportedFailure = message;
          logError("Background incremental sync failed", { error: message });
        },
      );
    }, this.config.syncIntervalMs);
  }

  /**
   * Whether a background sync interval is registered.
   *
   * Observable so a reader can be asserted to have started none. An interval
   * that exists but fails every tick is the failure mode this replaces, and it
   * is invisible from the outside without this.
   */
  public get hasBackgroundInterval(): boolean {
    return this.intervalHandle !== null;
  }

  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  public async ensureInitialized(): Promise<SyncResult> {
    if (this.db.readOnly) {
      return this.readOnlyResult();
    }

    const state = this.db.getSyncState();
    if (state.lastFullSyncAt) {
      return { mode: "noop", pages: 0, transactions: 0, asOf: state.lastAsOf };
    }

    return this.syncFull();
  }

  public async ensureFresh(maxAgeMs: number): Promise<SyncResult> {
    if (this.db.readOnly) {
      return this.readOnlyResult();
    }

    const state = this.db.getSyncState();
    // Freshness only has meaning after a full sync established the cache.
    // In particular, a recent failed-attempt marker from an older build must
    // not make a discarded cache look initialized.
    if (!state.lastFullSyncAt || !state.lastSyncAt) {
      return this.syncFull();
    }

    const ageMs = Date.now() - new Date(state.lastSyncAt).getTime();
    if (ageMs <= maxAgeMs) {
      return { mode: "noop", pages: 0, transactions: 0, asOf: state.lastAsOf };
    }

    return this.syncIncremental();
  }

  public async syncFull(): Promise<SyncResult> {
    if (this.db.readOnly) {
      return this.readOnlyResult();
    }

    return this.withLock(() => this.doFullSync());
  }

  public async syncIncremental(): Promise<SyncResult> {
    if (this.db.readOnly) {
      return this.readOnlyResult();
    }

    return this.withLock(() => this.doIncrementalSync());
  }

  private async doFullSync(): Promise<SyncResult> {
    this.db.updateSyncState({ syncStatus: "running", lastError: undefined });

    try {
      let dateOnAfter = this.db.getSyncState().dateOnAfter;
      if (!dateOnAfter) {
        const earliest = await this.client.getEarliestDateOn([]);
        dateOnAfter = earliest.dateOn;
      }

      let nextLink: string | undefined;
      let pages = 0;
      let txCount = 0;
      let latestAsOf: string | undefined;

      do {
        const payload = nextLink
          ? await this.client.listTransactionsFromNextLink(nextLink)
          : await this.client.listTransactions({
              limit: this.config.pageLimit,
              dateOnAfter,
            });

        pages += 1;
        txCount += payload.resources.length;
        this.db.upsertTransactions(payload.resources);

        latestAsOf = payload.metaData.asOf ?? latestAsOf;
        nextLink = payload.metaData.nextLink;
      } while (nextLink);

      const timestamp = nowIso();
      this.db.updateSyncState({
        dateOnAfter,
        lastAsOf: latestAsOf,
        lastFullSyncAt: timestamp,
        lastSyncAt: timestamp,
        syncStatus: "ok",
        lastError: undefined,
      });

      logInfo("Completed full Simplifi transaction sync", {
        pages,
        transactions: txCount,
        asOf: latestAsOf,
      });

      return {
        mode: "full",
        pages,
        transactions: txCount,
        asOf: latestAsOf,
      };
    } catch (error) {
      this.db.updateSyncState({
        syncStatus: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async doIncrementalSync(): Promise<SyncResult> {
    const state = this.db.getSyncState();
    if (!state.lastAsOf) {
      return this.doFullSync();
    }

    this.db.updateSyncState({ syncStatus: "running", lastError: undefined });

    try {
      let nextLink: string | undefined;
      let pages = 0;
      let txCount = 0;
      let latestAsOf: string | undefined = state.lastAsOf;

      do {
        const payload = nextLink
          ? await this.client.listTransactionsFromNextLink(nextLink)
          : await this.client.listTransactions({
              limit: this.config.pageLimit,
              modifiedAfter: state.lastAsOf,
              dateOnAfter: state.dateOnAfter,
            });

        pages += 1;
        txCount += payload.resources.length;
        this.db.upsertTransactions(payload.resources);

        latestAsOf = payload.metaData.asOf ?? latestAsOf;
        nextLink = payload.metaData.nextLink;
      } while (nextLink);

      this.db.updateSyncState({
        lastAsOf: latestAsOf,
        lastSyncAt: nowIso(),
        syncStatus: "ok",
        lastError: undefined,
      });

      return {
        mode: "incremental",
        pages,
        transactions: txCount,
        asOf: latestAsOf,
      };
    } catch (error) {
      this.db.updateSyncState({
        syncStatus: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async withLock(work: () => Promise<SyncResult>): Promise<SyncResult> {
    if (this.activeSync) {
      return this.activeSync;
    }

    this.activeSync = work().finally(() => {
      this.activeSync = null;
    });

    return this.activeSync;
  }
}
