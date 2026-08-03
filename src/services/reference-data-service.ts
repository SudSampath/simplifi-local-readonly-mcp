import type { AppConfig } from "../config.js";
import { DatabaseContext } from "../db/database.js";
import { logError, logInfo } from "../logger.js";
import { nowIso } from "../utils.js";
import { SimplifiClient } from "../simplifi/client.js";
import { RefreshCoordinator } from "../runtime/refresh-coordinator.js";

export class ReferenceDataService {
  public constructor(
    private readonly config: AppConfig["simplifi"],
    private readonly db: DatabaseContext,
    private readonly client: SimplifiClient,
    private readonly refreshCoordinator?: RefreshCoordinator,
  ) {}

  public async ensureCategoriesFresh(maxAgeMs: number): Promise<void> {
    const state = this.db.getReferenceSyncState();
    if (state.categoriesLastSyncAt) {
      const ageMs = Date.now() - new Date(state.categoriesLastSyncAt).getTime();
      if (ageMs <= maxAgeMs) {
        return;
      }
    }

    await this.syncCategories();
  }

  public async ensureTagsFresh(maxAgeMs: number): Promise<void> {
    const state = this.db.getReferenceSyncState();
    if (state.tagsLastSyncAt) {
      const ageMs = Date.now() - new Date(state.tagsLastSyncAt).getTime();
      if (ageMs <= maxAgeMs) {
        return;
      }
    }

    await this.syncTags();
  }

  public async syncCategories(): Promise<void> {
    if (this.db.readOnly && !this.refreshCoordinator?.canRefresh) {
      throw new Error("This instance cannot refresh categories because it has no cache-writer coordinator.");
    }

    if (this.refreshCoordinator) {
      await this.refreshCoordinator.run("categories", () => this.doSyncCategories());
      return;
    }

    await this.doSyncCategories();
  }

  private async doSyncCategories(): Promise<void> {
    try {
      let nextLink: string | undefined;
      let total = 0;
      let asOf: string | undefined;
      let pages = 0;

      do {
        const payload = nextLink
          ? await this.client.listCategoriesFromNextLink(nextLink)
          : await this.client.listCategories({ limit: 5000 });

        pages += 1;
        total += payload.resources.length;
        this.db.upsertCategories(payload.resources);

        asOf = payload.metaData.asOf ?? asOf;
        nextLink = payload.metaData.nextLink;
      } while (nextLink);

      this.db.updateReferenceSyncState({
        categoriesLastAsOf: asOf,
        categoriesLastSyncAt: nowIso(),
        lastError: undefined,
      });

      logInfo("Synced categories", { pages, total, asOf });
    } catch (error) {
      this.db.updateReferenceSyncState({
        lastError: error instanceof Error ? error.message : String(error),
      });
      logError("Category sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async syncTags(): Promise<void> {
    if (this.db.readOnly && !this.refreshCoordinator?.canRefresh) {
      throw new Error("This instance cannot refresh tags because it has no cache-writer coordinator.");
    }

    if (this.refreshCoordinator) {
      await this.refreshCoordinator.run("tags", () => this.doSyncTags());
      return;
    }

    await this.doSyncTags();
  }

  private async doSyncTags(): Promise<void> {
    try {
      let nextLink: string | undefined;
      let total = 0;
      let asOf: string | undefined;
      let pages = 0;

      do {
        const payload = nextLink
          ? await this.client.listTagsFromNextLink(nextLink)
          : await this.client.listTags({ limit: 5000 });

        pages += 1;
        total += payload.resources.length;
        this.db.upsertTags(payload.resources);

        asOf = payload.metaData.asOf ?? asOf;
        nextLink = payload.metaData.nextLink;
      } while (nextLink);

      this.db.updateReferenceSyncState({
        tagsLastAsOf: asOf,
        tagsLastSyncAt: nowIso(),
        lastError: undefined,
      });

      logInfo("Synced tags", { pages, total, asOf });
    } catch (error) {
      this.db.updateReferenceSyncState({
        lastError: error instanceof Error ? error.message : String(error),
      });
      logError("Tag sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
