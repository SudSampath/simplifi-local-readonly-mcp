import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import type {
  Account,
  CachedAccount,
  CachedScheduledTransaction,
  CachedTransaction,
  Category,
  ScheduledTransaction,
  SimplifiTokenRow,
  SimplifiTokenSet,
  SyncState,
  Tag,
  Transaction,
  TransactionFilters,
  TransactionPage,
} from "../types.js";
import { decodeCursor, encodeCursor, nowIso } from "../utils.js";
import { logInfo } from "../logger.js";
import { asCents, formatCents, toCents } from "../money.js";
import { resolveTransactionDate } from "../transaction-date.js";

export interface TransactionQuery extends TransactionFilters {
  cursor?: string;
  limit: number;
}

export interface SchemaColumn {
  name: string;
  /** Declared SQLite type, upper-cased. */
  type: string;
  notNull: boolean;
  /**
   * Part of the primary key.
   *
   * Worth knowing: in SQLite, `PRIMARY KEY` does **not** imply `NOT NULL` except
   * for an `INTEGER PRIMARY KEY` rowid alias. So `id TEXT PRIMARY KEY` reports
   * `notNull: false` and genuinely permits one NULL id. Check this flag, not
   * `notNull`, when asking whether a column is the key.
   */
  primaryKey: boolean;
}

export interface SchemaDescription {
  tables: string[];
  columns: Record<string, SchemaColumn[]>;
}

interface TransactionRow {
  raw_json: string;
}

interface CountRow {
  count: number;
}

interface MerchantRow {
  merchant: string;
  count: number;
}

interface CoaSuggestionRow {
  coa_type: string | null;
  coa_id: string | null;
  count: number;
  category_name: string | null;
}

interface CategoryRow {
  raw_json: string;
}

interface TagRow {
  raw_json: string;
}

export interface ReferenceSyncState {
  id: number;
  categoriesLastAsOf?: string;
  categoriesLastSyncAt?: string;
  tagsLastAsOf?: string;
  tagsLastSyncAt?: string;
  lastError?: string;
}

export interface CollectionSyncState {
  id: number;
  accountsLastSyncAt?: string;
  scheduledLastSyncAt?: string;
  lastError?: string;
}

export class DatabaseContext {
  private readonly db: BetterSqlite3.Database;
  public readonly readOnly: boolean;

  /**
   * Opens the cache, either as its writer or as a concurrent reader.
   *
   * A reader opens with SQLite's `readonly` flag and runs no migration. That is
   * not caution, it is correctness: `discardIncompatibleCache` drops the
   * transactions table so the writer can rebuild it from a sync, and a reader
   * cannot sync. A reader that migrated would delete every row and have no way
   * to put them back — turning a stale answer into an empty one.
   */
  public constructor(dbPath: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly ?? false;

    if (this.readOnly) {
      if (!fs.existsSync(dbPath)) {
        throw new Error(
          `The local cache does not exist at ${dbPath}, and this instance is a reader because another process holds the writer lease. ` +
            `A reader cannot create or sync the cache. Start the writer first, or run the auth command.`,
        );
      }

      // A read-only connection cannot create the -shm file WAL needs. When the
      // writer is live it already exists; when the cache was closed cleanly the
      // main file is self-sufficient. The failure between those cases is
      // SQLITE_CANTOPEN on a file that plainly exists, which reads as corruption
      // unless it says otherwise.
      try {
        this.db = new BetterSqlite3(dbPath, { readonly: true });
      } catch (error) {
        throw new Error(
          `Could not open the local cache read-only at ${dbPath}: ${error instanceof Error ? error.message : String(error)}. ` +
            `This instance is a reader because another process holds the writer lease; only the writer can repair the cache.`,
          { cause: error },
        );
      }

      // Close before rethrowing. The handle is already open by this point, and a
      // caller that just received a throw has no object to call close() on — on
      // Windows the leaked handle then keeps the cache file locked.
      try {
        this.assertReadableSchema(dbPath);
      } catch (error) {
        this.db.close();
        throw error;
      }

      return;
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  /**
   * Refuses a cache a reader cannot answer from.
   *
   * The writer's response to an incompatible cache is to discard and resync. A
   * reader has neither option, so the honest outcome is to say the cache is not
   * usable yet and name what has to build it — rather than start and return
   * zeroes that look like an answer.
   */
  private assertReadableSchema(dbPath: string): void {
    const hasTransactions = this.db
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'`)
      .get();

    if (!hasTransactions) {
      throw new Error(
        `The local cache at ${dbPath} has no transactions table yet, and this instance is a reader. ` +
          `The process holding the writer lease builds it on its first sync.`,
      );
    }

    const present = new Set(
      this.db.prepare<[], { name: string }>(`PRAGMA table_info("transactions")`).all().map((column) => column.name),
    );
    const missing = DatabaseContext.REQUIRED_TRANSACTION_COLUMNS.filter((column) => !present.has(column));

    if (missing.length > 0) {
      throw new Error(
        `The local cache at ${dbPath} predates the current schema (missing: ${missing.join(", ")}), and this instance is a reader. ` +
          `Rebuilding it discards and resyncs every transaction, which only the process holding the writer lease can do.`,
      );
    }
  }

  public close(): void {
    this.db.close();
  }

  /**
   * Read-only description of the migrated schema.
   *
   * Exists so the schema can be asserted against what the query layer expects.
   * The schema is a SQL string passed to `exec()`, so the compiler cannot see
   * inside it — a dropped or renamed column would otherwise surface as a runtime
   * error on a real query, months later. This moves that to test time.
   *
   * Also useful diagnostically: "what does the cache actually look like" is the
   * first question when a query returns nothing.
   */
  public describeSchema(): SchemaDescription {
    const tables = this.db
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((row) => row.name);

    const columns: Record<string, SchemaColumn[]> = {};

    for (const table of tables) {
      // PRAGMA does not accept a bound parameter for the table name. Values here
      // come from sqlite_master rather than from any caller, so there is no
      // untrusted input to interpolate.
      columns[table] = this.db
        .prepare<[], { name: string; type: string; notnull: number; pk: number }>(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => ({
          name: row.name,
          type: row.type.toUpperCase(),
          notNull: row.notnull === 1,
          primaryKey: row.pk > 0,
        }));
    }

    return { tables, columns };
  }

  /**
   * Columns whose absence means the cached rows cannot answer a query correctly.
   *
   * Adding one here makes an older cache rebuild itself on next start. That is
   * the right default for derived data: the alternative is backfilling a column
   * from values that were themselves derived under the old rule, which preserves
   * whatever the old rule got wrong.
   */
  private static readonly REQUIRED_TRANSACTION_COLUMNS = ["amount_cents", "txn_on"];

  /**
   * Discards a transaction cache that predates the current schema.
   *
   * Converting in place is not honest for either migration that has needed this.
   * A REAL money column already holds values that went through a float, so
   * converting would preserve exactly the drift the integer column removes; and
   * a missing transaction date cannot be invented from the settlement date that
   * stood in for it. This is a cache — rebuilding costs one sync, which is
   * cheaper than a total nobody can trust.
   */
  private discardIncompatibleCache(): void {
    const exists = this.db
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'`)
      .get();

    if (!exists) {
      return;
    }

    const present = new Set(
      this.db.prepare<[], { name: string }>(`PRAGMA table_info("transactions")`).all().map((column) => column.name),
    );
    const missing = DatabaseContext.REQUIRED_TRANSACTION_COLUMNS.filter((column) => !present.has(column));

    if (missing.length === 0) {
      return;
    }

    logInfo("Discarding incompatible transaction cache; a full resync will follow", {
      missingColumns: missing.join(", "),
    });

    this.db.exec(`
      DROP TABLE IF EXISTS transactions;
      UPDATE sync_state
      SET date_on_after = NULL,
          last_as_of = NULL,
          last_full_sync_at = NULL,
          last_sync_at = NULL,
          sync_status = NULL,
          last_error = NULL
      WHERE id = 1;
    `);
  }

  private migrate(): void {
    this.discardIncompatibleCache();

    this.db.exec(`
      -- These tables backed the removed HTTP OAuth provider. Drop them on an
      -- existing local cache as well as omitting them from fresh databases.
      DROP TABLE IF EXISTS oauth_authorization_codes;
      DROP TABLE IF EXISTS oauth_refresh_tokens;

      CREATE TABLE IF NOT EXISTS simplifi_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        access_token_expires_at TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        refresh_token_expires_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        date_on_after TEXT,
        last_as_of TEXT,
        last_full_sync_at TEXT,
        last_sync_at TEXT,
        sync_status TEXT,
        last_error TEXT
      );

      INSERT OR IGNORE INTO sync_state (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS transactions (
        -- NOT NULL is not redundant here. In SQLite, PRIMARY KEY implies it only
        -- for an INTEGER PRIMARY KEY rowid alias, so a TEXT key permits one NULL
        -- id — and because NULLs compare distinct, ON CONFLICT(id) would stop
        -- de-duplicating those rows. Folded in with the cents rebuild, which is
        -- the only cheap moment to add it.
        id TEXT PRIMARY KEY NOT NULL,
        -- The settlement date. Kept because it is what upstream sorts by and can
        -- be the only date when cpData is absent, but it is NOT necessarily the
        -- date a transaction happened and can land in a different month.
        posted_on TEXT,
        -- The date the transaction actually occurred: cpData.txnOn where present,
        -- otherwise posted_on. This is what date filters and ordering use.
        txn_on TEXT,
        modified_at TEXT,
        user_modified_at TEXT,
        account_id TEXT,
        payee TEXT,
        renamed_payee TEXT,
        memo TEXT,
        ml_inferred_payee TEXT,
        -- Integer cents. Never REAL: see src/money.ts for why, and the
        -- schema assertion in tests that forbids a REAL money column.
        amount_cents INTEGER,
        state TEXT,
        known_category_id TEXT,
        coa_type TEXT,
        coa_id TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_posted_on ON transactions (posted_on DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_txn_on ON transactions (txn_on DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_modified_at ON transactions (modified_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions (account_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_payee ON transactions (payee);
      CREATE INDEX IF NOT EXISTS idx_transactions_amount_cents ON transactions (amount_cents);

      -- Balances and statement detail. Every money column is integer cents, as
      -- in transactions: a REAL here would reintroduce the drift SUD-13 removed,
      -- and a credit statement balance is exactly the number nobody wants
      -- rounded. Enforced by the schema test that forbids REAL money columns.
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT,
        type TEXT,
        sub_type TEXT,
        usage_type TEXT,
        currency TEXT,
        is_closed INTEGER NOT NULL DEFAULT 0,
        is_ignored INTEGER NOT NULL DEFAULT 0,
        balance_cents INTEGER,
        balance_as_of_on TEXT,
        current_balance_cents INTEGER,
        online_balance_cents INTEGER,
        credit_limit_cents INTEGER,
        statement_due_at TEXT,
        statement_due_amount_cents INTEGER,
        statement_min_payment_cents INTEGER,
        statement_past_due_amount_cents INTEGER,
        statement_close_at TEXT,
        statement_close_balance_cents INTEGER,
        modified_at TEXT,
        raw_json TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts (type);

      CREATE TABLE IF NOT EXISTS scheduled_transactions (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT,
        due_on TEXT,
        last_due_on TEXT,
        is_completed INTEGER NOT NULL DEFAULT 0,
        recurrence_frequency TEXT,
        recurrence_interval INTEGER,
        account_id TEXT,
        payee TEXT,
        amount_cents INTEGER,
        coa_type TEXT,
        coa_id TEXT,
        is_bill INTEGER NOT NULL DEFAULT 0,
        modified_at TEXT,
        raw_json TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_due_on ON scheduled_transactions (due_on);
      CREATE INDEX IF NOT EXISTS idx_scheduled_type ON scheduled_transactions (type);

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name TEXT,
        category_type TEXT,
        usage_type TEXT,
        modified_at TEXT,
        raw_json TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_categories_name ON categories (name);
      CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories (parent_id);

      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT,
        modified_at TEXT,
        raw_json TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tags_name ON tags (name);

      CREATE TABLE IF NOT EXISTS reference_sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        categories_last_as_of TEXT,
        categories_last_sync_at TEXT,
        tags_last_as_of TEXT,
        tags_last_sync_at TEXT,
        last_error TEXT
      );
      INSERT OR IGNORE INTO reference_sync_state (id) VALUES (1);

      -- Complete collections need persistent freshness too. An in-memory mark
      -- belongs to one stdio subprocess and is invisible to every other host;
      -- storing it here lets a reader know whether to ask the writer to refresh.
      CREATE TABLE IF NOT EXISTS collection_sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        accounts_last_sync_at TEXT,
        scheduled_last_sync_at TEXT,
        last_error TEXT
      );
      INSERT OR IGNORE INTO collection_sync_state (id) VALUES (1);
    `);
  }

  public getSimplifiTokens(): SimplifiTokenRow | null {
    const row = this.db
      .prepare(
        `
          SELECT
            access_token,
            access_token_expires_at,
            refresh_token,
            refresh_token_expires_at,
            updated_at
          FROM simplifi_tokens
          WHERE id = 1
        `,
      )
      .get() as
      | {
          access_token: string;
          access_token_expires_at: string;
          refresh_token: string;
          refresh_token_expires_at: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      accessToken: row.access_token,
      accessTokenExpiresAt: row.access_token_expires_at,
      refreshToken: row.refresh_token,
      refreshTokenExpiresAt: row.refresh_token_expires_at ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  public saveSimplifiTokens(tokens: SimplifiTokenSet): void {
    this.db
      .prepare(
        `
          INSERT INTO simplifi_tokens (
            id,
            access_token,
            access_token_expires_at,
            refresh_token,
            refresh_token_expires_at,
            updated_at
          ) VALUES (1, @accessToken, @accessTokenExpiresAt, @refreshToken, @refreshTokenExpiresAt, @updatedAt)
          ON CONFLICT(id) DO UPDATE SET
            access_token = excluded.access_token,
            access_token_expires_at = excluded.access_token_expires_at,
            refresh_token = excluded.refresh_token,
            refresh_token_expires_at = excluded.refresh_token_expires_at,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? null,
        updatedAt: nowIso(),
      });
  }

  public getSyncState(): SyncState {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            date_on_after,
            last_as_of,
            last_full_sync_at,
            last_sync_at,
            sync_status,
            last_error
          FROM sync_state
          WHERE id = 1
        `,
      )
      .get() as
      | {
          id: number;
          date_on_after: string | null;
          last_as_of: string | null;
          last_full_sync_at: string | null;
          last_sync_at: string | null;
          sync_status: string | null;
          last_error: string | null;
        }
      | undefined;

    if (!row) {
      return { id: 1 };
    }

    return {
      id: row.id,
      dateOnAfter: row.date_on_after ?? undefined,
      lastAsOf: row.last_as_of ?? undefined,
      lastFullSyncAt: row.last_full_sync_at ?? undefined,
      lastSyncAt: row.last_sync_at ?? undefined,
      syncStatus: row.sync_status ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  }

  public updateSyncState(patch: Partial<SyncState>): void {
    const current = this.getSyncState();
    const next: SyncState = {
      ...current,
      ...patch,
      id: 1,
    };

    this.db
      .prepare(
        `
          UPDATE sync_state
          SET
            date_on_after = @dateOnAfter,
            last_as_of = @lastAsOf,
            last_full_sync_at = @lastFullSyncAt,
            last_sync_at = @lastSyncAt,
            sync_status = @syncStatus,
            last_error = @lastError
          WHERE id = 1
        `,
      )
      .run({
        dateOnAfter: next.dateOnAfter ?? null,
        lastAsOf: next.lastAsOf ?? null,
        lastFullSyncAt: next.lastFullSyncAt ?? null,
        lastSyncAt: next.lastSyncAt ?? null,
        syncStatus: next.syncStatus ?? null,
        lastError: next.lastError ?? null,
      });
  }

  public upsertTransactions(transactions: Transaction[]): void {
    if (transactions.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT INTO transactions (
        id,
        posted_on,
        txn_on,
        modified_at,
        user_modified_at,
        account_id,
        payee,
        renamed_payee,
        memo,
        ml_inferred_payee,
        amount_cents,
        state,
        known_category_id,
        coa_type,
        coa_id,
        is_deleted,
        raw_json,
        cached_at
      ) VALUES (
        @id,
        @postedOn,
        @txnOn,
        @modifiedAt,
        @userModifiedAt,
        @accountId,
        @payee,
        @renamedPayee,
        @memo,
        @mlInferredPayee,
        @amountCents,
        @state,
        @knownCategoryId,
        @coaType,
        @coaId,
        @isDeleted,
        @rawJson,
        @cachedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        posted_on = excluded.posted_on,
        txn_on = excluded.txn_on,
        modified_at = excluded.modified_at,
        user_modified_at = excluded.user_modified_at,
        account_id = excluded.account_id,
        payee = excluded.payee,
        renamed_payee = excluded.renamed_payee,
        memo = excluded.memo,
        ml_inferred_payee = excluded.ml_inferred_payee,
        amount_cents = excluded.amount_cents,
        state = excluded.state,
        known_category_id = excluded.known_category_id,
        coa_type = excluded.coa_type,
        coa_id = excluded.coa_id,
        is_deleted = excluded.is_deleted,
        raw_json = excluded.raw_json,
        cached_at = excluded.cached_at
    `);

    const run = this.db.transaction((items: Transaction[]) => {
      const cachedAt = nowIso();
      for (const item of items) {
        statement.run({
          id: item.id,
          postedOn: typeof item.postedOn === "string" ? item.postedOn : null,
          // Resolved once, on write, so every query filters the same field and
          // no caller has to remember which date means what.
          txnOn: resolveTransactionDate(item)?.date ?? null,
          modifiedAt: typeof item.modifiedAt === "string" ? item.modifiedAt : null,
          userModifiedAt: typeof item.userModifiedAt === "string" ? item.userModifiedAt : null,
          accountId: typeof item.accountId === "string" ? item.accountId : null,
          payee: typeof item.payee === "string" ? item.payee : null,
          renamedPayee: typeof item.renamedPayee === "string" ? item.renamedPayee : null,
          memo: typeof item.memo === "string" ? item.memo : null,
          mlInferredPayee: typeof item.mlInferredPayee === "string" ? item.mlInferredPayee : null,
          // The one place a decimal amount becomes cents. Everything downstream
          // reads the integer column, so there is no second conversion to drift
          // away from this one.
          amountCents: typeof item.amount === "number" ? toCents(item.amount) : null,
          state: typeof item.state === "string" ? item.state : null,
          knownCategoryId: typeof item.knownCategoryId === "string" ? item.knownCategoryId : null,
          coaType: typeof item.coa?.type === "string" ? item.coa.type : null,
          coaId: typeof item.coa?.id === "string" ? item.coa.id : null,
          isDeleted: item.isDeleted ? 1 : 0,
          rawJson: JSON.stringify(item),
          cachedAt,
        });
      }
    });

    run(transactions);
  }

  /**
   * Rehydrates a cached row, replacing the upstream decimal amount with cents.
   *
   * The raw payload is kept verbatim in `raw_json` so nothing observed is lost,
   * but what leaves this class carries integer cents and a formatted string. A
   * float that never reaches a caller cannot be summed by one.
   */
  private toCachedTransaction(rawJson: string): CachedTransaction {
    const parsed = JSON.parse(rawJson) as Transaction;
    const { amount, ...rest } = parsed;

    const resolved = resolveTransactionDate(parsed);
    const cached: CachedTransaction = resolved
      ? { ...rest, transactionDate: resolved.date, transactionDateSource: resolved.source }
      : rest;

    if (typeof amount !== "number") {
      return cached;
    }

    const cents = toCents(amount);
    return { ...cached, amountCents: cents, amountFormatted: formatCents(cents) };
  }

  public getTransactionById(id: string): CachedTransaction | null {
    const row = this.db.prepare<[string], TransactionRow>(`SELECT raw_json FROM transactions WHERE id = ?`).get(id);
    if (!row) {
      return null;
    }

    return this.toCachedTransaction(row.raw_json);
  }

  public listTransactions(query: TransactionQuery): TransactionPage {
    return this.queryTransactions({
      query,
      searchTerm: undefined,
    });
  }

  public listUncategorizedTransactions(query: TransactionQuery): TransactionPage {
    return this.queryTransactions({
      query,
      searchTerm: undefined,
      extraWhere: ["(coa_type IS NULL OR UPPER(coa_type) = 'UNCATEGORIZED' OR coa_id = '0')"],
    });
  }

  public searchTransactions(query: TransactionQuery & { searchTerm: string }): TransactionPage {
    return this.queryTransactions({
      query,
      searchTerm: query.searchTerm,
    });
  }

  private queryTransactions(args: { query: TransactionQuery; searchTerm?: string; extraWhere?: string[] }): TransactionPage {
    const offset = decodeCursor(args.query.cursor);
    const limit = Math.min(Math.max(args.query.limit, 1), 200);

    const where: string[] = [];
    const values: unknown[] = [];

    if (args.query.accountId) {
      where.push("account_id = ?");
      values.push(args.query.accountId);
    }

    if (args.query.dateFrom) {
      where.push("txn_on >= ?");
      values.push(args.query.dateFrom);
    }

    if (args.query.dateTo) {
      where.push("txn_on <= ?");
      values.push(args.query.dateTo);
    }

    // Callers express bounds in dollars, which is the natural unit for a person
    // asking a question. They are converted once, here, so the comparison itself
    // is integer-to-integer rather than a float compared against a float.
    if (typeof args.query.minAmount === "number") {
      where.push("amount_cents >= ?");
      values.push(toCents(args.query.minAmount));
    }

    if (typeof args.query.maxAmount === "number") {
      where.push("amount_cents <= ?");
      values.push(toCents(args.query.maxAmount));
    }

    if (!args.query.includeDeleted) {
      where.push("is_deleted = 0");
    }

    if (args.extraWhere && args.extraWhere.length > 0) {
      where.push(...args.extraWhere);
    }

    if (args.searchTerm && args.searchTerm.trim().length > 0) {
      where.push(
        `(LOWER(payee) LIKE ? OR LOWER(renamed_payee) LIKE ? OR LOWER(memo) LIKE ? OR LOWER(ml_inferred_payee) LIKE ?)`,
      );
      const like = `%${args.searchTerm.toLowerCase()}%`;
      values.push(like, like, like, like);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    // `get()` is typed as possibly-undefined because most queries can miss. A
    // COUNT(*) with no GROUP BY always returns exactly one row, so the fallback is
    // unreachable rather than a real case — but it is written as a fallback instead
    // of a non-null assertion so that a future GROUP BY here fails loudly at zero
    // rather than throwing on undefined.
    const total =
      this.db
        .prepare<unknown[], CountRow>(`SELECT COUNT(*) AS count FROM transactions ${whereClause}`)
        .get(...values)?.count ?? 0;

    const sql = `
      SELECT raw_json
      FROM transactions
      ${whereClause}
      ORDER BY txn_on DESC, id DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare<unknown[], TransactionRow>(sql).all(...values, limit + 1, offset);
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => this.toCachedTransaction(row.raw_json));

    return {
      items,
      total,
      nextCursor: hasNext ? encodeCursor(offset + limit) : undefined,
    };
  }

  /**
   * Every transaction in a date range, unpaginated.
   *
   * Separate from `listTransactions` on purpose. That one pages, because a
   * caller reading a list wants a screenful; an aggregation wants all of it or
   * none, and a total computed over page one of four is not a smaller total, it
   * is a wrong one. Holding one analysis range in memory is safer than silently
   * aggregating only its first page.
   */
  public listTransactionsInRange(options: {
    dateFrom?: string;
    dateTo?: string;
    accountId?: string;
    includeDeleted?: boolean;
  }): CachedTransaction[] {
    const where: string[] = [];
    const values: unknown[] = [];

    if (options.dateFrom) {
      where.push("txn_on >= ?");
      values.push(options.dateFrom);
    }

    if (options.dateTo) {
      where.push("txn_on <= ?");
      values.push(options.dateTo);
    }

    if (options.accountId) {
      where.push("account_id = ?");
      values.push(options.accountId);
    }

    if (!options.includeDeleted) {
      where.push("is_deleted = 0");
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare<unknown[], TransactionRow>(`SELECT raw_json FROM transactions ${clause} ORDER BY txn_on ASC, id ASC`)
      .all(...values);

    return rows.map((row) => this.toCachedTransaction(row.raw_json));
  }

  /**
   * Specific transactions by id.
   *
   * Exists so an aggregation over one month can resolve a transfer whose
   * counterpart falls in another. Without it, every transfer straddling a month
   * boundary would be reported as having an uncached counterpart — an unmatched
   * leg invented by the query window rather than found in the data.
   *
   * Ids are bound as parameters in chunks rather than interpolated: SQLite caps
   * the number of variables per statement, and a caller could pass thousands.
   */
  public getTransactionsByIds(ids: readonly string[]): CachedTransaction[] {
    const CHUNK = 500;
    const found: CachedTransaction[] = [];

    for (let start = 0; start < ids.length; start += CHUNK) {
      const chunk = ids.slice(start, start + CHUNK);
      if (chunk.length === 0) {
        continue;
      }

      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare<unknown[], TransactionRow>(`SELECT raw_json FROM transactions WHERE id IN (${placeholders})`)
        .all(...chunk);

      for (const row of rows) {
        found.push(this.toCachedTransaction(row.raw_json));
      }
    }

    return found;
  }

  /**
   * The span of history the cache actually holds, at or before `asOf`.
   *
   * Bounded by the as-of date because Simplifi can cache projected scheduled
   * bills beyond today. Reporting the latest projection as the end of coverage
   * would claim the cache knows about a future it has only guessed at.
   */
  public getTransactionCoverage(options: { asOf: string; includeDeleted?: boolean }): {
    earliest?: string;
    latest?: string;
    count: number;
  } {
    const where = ["txn_on IS NOT NULL", "txn_on <= ?"];
    if (!options.includeDeleted) {
      where.push("is_deleted = 0");
    }

    const row = this.db
      .prepare<[string], { earliest: string | null; latest: string | null; count: number }>(
        `SELECT MIN(txn_on) AS earliest, MAX(txn_on) AS latest, COUNT(*) AS count
         FROM transactions
         WHERE ${where.join(" AND ")}`,
      )
      .get(options.asOf);

    return {
      earliest: row?.earliest ?? undefined,
      latest: row?.latest ?? undefined,
      count: row?.count ?? 0,
    };
  }

  public getReferenceSyncState(): ReferenceSyncState {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            categories_last_as_of,
            categories_last_sync_at,
            tags_last_as_of,
            tags_last_sync_at,
            last_error
          FROM reference_sync_state
          WHERE id = 1
        `,
      )
      .get() as
      | {
          id: number;
          categories_last_as_of: string | null;
          categories_last_sync_at: string | null;
          tags_last_as_of: string | null;
          tags_last_sync_at: string | null;
          last_error: string | null;
        }
      | undefined;

    if (!row) {
      return { id: 1 };
    }

    return {
      id: row.id,
      categoriesLastAsOf: row.categories_last_as_of ?? undefined,
      categoriesLastSyncAt: row.categories_last_sync_at ?? undefined,
      tagsLastAsOf: row.tags_last_as_of ?? undefined,
      tagsLastSyncAt: row.tags_last_sync_at ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  }

  public updateReferenceSyncState(patch: Partial<ReferenceSyncState>): void {
    const current = this.getReferenceSyncState();
    const next: ReferenceSyncState = { ...current, ...patch, id: 1 };

    this.db
      .prepare(
        `
          UPDATE reference_sync_state
          SET
            categories_last_as_of = @categoriesLastAsOf,
            categories_last_sync_at = @categoriesLastSyncAt,
            tags_last_as_of = @tagsLastAsOf,
            tags_last_sync_at = @tagsLastSyncAt,
            last_error = @lastError
          WHERE id = 1
        `,
      )
      .run({
        categoriesLastAsOf: next.categoriesLastAsOf ?? null,
        categoriesLastSyncAt: next.categoriesLastSyncAt ?? null,
        tagsLastAsOf: next.tagsLastAsOf ?? null,
        tagsLastSyncAt: next.tagsLastSyncAt ?? null,
        lastError: next.lastError ?? null,
      });
  }

  public getCollectionSyncState(): CollectionSyncState {
    const row = this.db
      .prepare(
        `
          SELECT id, accounts_last_sync_at, scheduled_last_sync_at, last_error
          FROM collection_sync_state
          WHERE id = 1
        `,
      )
      .get() as
      | {
          id: number;
          accounts_last_sync_at: string | null;
          scheduled_last_sync_at: string | null;
          last_error: string | null;
        }
      | undefined;

    if (!row) {
      return { id: 1 };
    }

    return {
      id: row.id,
      accountsLastSyncAt: row.accounts_last_sync_at ?? undefined,
      scheduledLastSyncAt: row.scheduled_last_sync_at ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  }

  public updateCollectionSyncState(patch: Partial<CollectionSyncState>): void {
    const next: CollectionSyncState = { ...this.getCollectionSyncState(), ...patch, id: 1 };
    this.db
      .prepare(
        `
          UPDATE collection_sync_state
          SET
            accounts_last_sync_at = @accountsLastSyncAt,
            scheduled_last_sync_at = @scheduledLastSyncAt,
            last_error = @lastError
          WHERE id = 1
        `,
      )
      .run({
        accountsLastSyncAt: next.accountsLastSyncAt ?? null,
        scheduledLastSyncAt: next.scheduledLastSyncAt ?? null,
        lastError: next.lastError ?? null,
      });
  }

  public upsertCategories(categories: Category[]): void {
    if (categories.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT INTO categories (
        id,
        parent_id,
        name,
        category_type,
        usage_type,
        modified_at,
        raw_json,
        cached_at
      ) VALUES (
        @id,
        @parentId,
        @name,
        @categoryType,
        @usageType,
        @modifiedAt,
        @rawJson,
        @cachedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        parent_id = excluded.parent_id,
        name = excluded.name,
        category_type = excluded.category_type,
        usage_type = excluded.usage_type,
        modified_at = excluded.modified_at,
        raw_json = excluded.raw_json,
        cached_at = excluded.cached_at
    `);

    const run = this.db.transaction((items: Category[]) => {
      const cachedAt = nowIso();
      for (const item of items) {
        const id = typeof item.id === "string" ? item.id : "";
        if (!id) {
          continue;
        }

        statement.run({
          id,
          parentId: typeof item.parentId === "string" ? item.parentId : null,
          name: typeof item.name === "string" ? item.name : null,
          categoryType: typeof item.categoryType === "string" ? item.categoryType : null,
          usageType: typeof item.usageType === "string" ? item.usageType : null,
          modifiedAt: typeof item.modifiedAt === "string" ? item.modifiedAt : null,
          rawJson: JSON.stringify(item),
          cachedAt,
        });
      }
    });

    run(categories);
  }

  public listCategories(query?: { search?: string; limit?: number }): Category[] {
    const limit = Math.min(Math.max(query?.limit ?? 5000, 1), 5000);
    const search = query?.search?.trim();

    const rows = (search
      ? (this.db
          .prepare<[string, number], CategoryRow>(
            `
              SELECT raw_json
              FROM categories
              WHERE LOWER(name) LIKE ?
              ORDER BY name ASC
              LIMIT ?
            `,
          )
          .all(`%${search.toLowerCase()}%`, limit))
      : (this.db
          .prepare<[number], CategoryRow>(
            `
              SELECT raw_json
              FROM categories
              ORDER BY name ASC
              LIMIT ?
            `,
          )
          .all(limit)));

    return rows.map((row) => JSON.parse(row.raw_json) as Category);
  }

  public getCategoryById(id: string): Category | null {
    const row = this.db.prepare<[string], CategoryRow>(`SELECT raw_json FROM categories WHERE id = ?`).get(id);
    return row ? (JSON.parse(row.raw_json) as Category) : null;
  }

  public upsertTags(tags: Tag[]): void {
    if (tags.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT INTO tags (
        id,
        name,
        type,
        modified_at,
        raw_json,
        cached_at
      ) VALUES (
        @id,
        @name,
        @type,
        @modifiedAt,
        @rawJson,
        @cachedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        modified_at = excluded.modified_at,
        raw_json = excluded.raw_json,
        cached_at = excluded.cached_at
    `);

    const run = this.db.transaction((items: Tag[]) => {
      const cachedAt = nowIso();
      for (const item of items) {
        const id = typeof item.id === "string" ? item.id : "";
        if (!id) {
          continue;
        }

        statement.run({
          id,
          name: typeof item.name === "string" ? item.name : null,
          type: typeof item.type === "string" ? item.type : null,
          modifiedAt: typeof item.modifiedAt === "string" ? item.modifiedAt : null,
          rawJson: JSON.stringify(item),
          cachedAt,
        });
      }
    });

    run(tags);
  }

  public listTags(query?: { search?: string; limit?: number }): Tag[] {
    const limit = Math.min(Math.max(query?.limit ?? 5000, 1), 5000);
    const search = query?.search?.trim();

    const rows = (search
      ? (this.db
          .prepare<[string, number], TagRow>(
            `
              SELECT raw_json
              FROM tags
              WHERE LOWER(name) LIKE ?
              ORDER BY name ASC
              LIMIT ?
            `,
          )
          .all(`%${search.toLowerCase()}%`, limit))
      : (this.db
          .prepare<[number], TagRow>(
            `
              SELECT raw_json
              FROM tags
              ORDER BY name ASC
              LIMIT ?
            `,
          )
          .all(limit)));

    return rows.map((row) => JSON.parse(row.raw_json) as Tag);
  }

  public searchMerchants(query: { q: string; limit?: number; includeDeleted?: boolean }): Array<{ merchant: string; count: number }> {
    const q = query.q.trim().toLowerCase();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);

    const values: unknown[] = [];
    const where: string[] = [
      "merchant IS NOT NULL",
      "merchant <> ''",
      "LOWER(merchant) LIKE ?",
    ];
    values.push(`%${q}%`);

    if (!query.includeDeleted) {
      where.push("is_deleted = 0");
    }

    const sql = `
      WITH base AS (
        SELECT
          COALESCE(NULLIF(renamed_payee,''), NULLIF(payee,''), NULLIF(ml_inferred_payee,'')) AS merchant,
          is_deleted
        FROM transactions
      )
      SELECT merchant, COUNT(*) AS count
      FROM base
      WHERE ${where.join(" AND ")}
      GROUP BY merchant
      ORDER BY count DESC, merchant ASC
      LIMIT ?
    `;

    const rows = this.db.prepare<unknown[], MerchantRow>(sql).all(...values, limit);
    return rows.map((row) => ({ merchant: row.merchant, count: row.count }));
  }

  public suggestCategoriesForMerchant(input: {
    merchant: string;
    limit?: number;
    matchMode?: "exact" | "contains";
    includeDeleted?: boolean;
  }): Array<{ coaType: string; coaId: string; count: number; categoryName?: string }> {
    const merchant = input.merchant.trim().toLowerCase();
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
    const matchMode = input.matchMode ?? "exact";

    const predicate =
      matchMode === "contains"
        ? "LOWER(merchant) LIKE ?"
        : "LOWER(merchant) = ?";

    const value = matchMode === "contains" ? `%${merchant}%` : merchant;

    const where: string[] = [
      "merchant IS NOT NULL",
      "merchant <> ''",
      predicate,
    ];

    if (!input.includeDeleted) {
      where.push("is_deleted = 0");
    }

    const sql = `
      WITH base AS (
        SELECT
          COALESCE(NULLIF(renamed_payee,''), NULLIF(payee,''), NULLIF(ml_inferred_payee,'')) AS merchant,
          coa_type,
          coa_id,
          is_deleted
        FROM transactions
      ),
      grouped AS (
        SELECT coa_type, coa_id, COUNT(*) AS count
        FROM base
        WHERE ${where.join(" AND ")}
        GROUP BY coa_type, coa_id
      )
      SELECT
        grouped.coa_type,
        grouped.coa_id,
        grouped.count,
        categories.name AS category_name
      FROM grouped
      LEFT JOIN categories ON categories.id = grouped.coa_id
      ORDER BY grouped.count DESC
      LIMIT ?
    `;

    const rows = this.db.prepare<[string, number], CoaSuggestionRow>(sql).all(value, limit);
    return rows
      .filter((row) => typeof row.coa_type === "string" && typeof row.coa_id === "string")
      .map((row) => ({
        coaType: row.coa_type as string,
        coaId: row.coa_id as string,
        count: row.count,
        categoryName: row.category_name ?? undefined,
      }));
  }

  /** Cents, or null when the field is absent. Absent is normal on most accounts. */
  private optionalCents(value: unknown): number | null {
    return typeof value === "number" ? toCents(value) : null;
  }

  public upsertAccounts(accounts: Account[]): void {
    if (accounts.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT INTO accounts (
        id, name, type, sub_type, usage_type, currency, is_closed, is_ignored,
        balance_cents, balance_as_of_on, current_balance_cents, online_balance_cents,
        credit_limit_cents, statement_due_at, statement_due_amount_cents,
        statement_min_payment_cents, statement_past_due_amount_cents,
        statement_close_at, statement_close_balance_cents, modified_at, raw_json, cached_at
      ) VALUES (
        @id, @name, @type, @subType, @usageType, @currency, @isClosed, @isIgnored,
        @balanceCents, @balanceAsOfOn, @currentBalanceCents, @onlineBalanceCents,
        @creditLimitCents, @statementDueAt, @statementDueAmountCents,
        @statementMinPaymentCents, @statementPastDueAmountCents,
        @statementCloseAt, @statementCloseBalanceCents, @modifiedAt, @rawJson, @cachedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        sub_type = excluded.sub_type,
        usage_type = excluded.usage_type,
        currency = excluded.currency,
        is_closed = excluded.is_closed,
        is_ignored = excluded.is_ignored,
        balance_cents = excluded.balance_cents,
        balance_as_of_on = excluded.balance_as_of_on,
        current_balance_cents = excluded.current_balance_cents,
        online_balance_cents = excluded.online_balance_cents,
        credit_limit_cents = excluded.credit_limit_cents,
        statement_due_at = excluded.statement_due_at,
        statement_due_amount_cents = excluded.statement_due_amount_cents,
        statement_min_payment_cents = excluded.statement_min_payment_cents,
        statement_past_due_amount_cents = excluded.statement_past_due_amount_cents,
        statement_close_at = excluded.statement_close_at,
        statement_close_balance_cents = excluded.statement_close_balance_cents,
        modified_at = excluded.modified_at,
        raw_json = excluded.raw_json,
        cached_at = excluded.cached_at
    `);

    const run = this.db.transaction((items: Account[]) => {
      const cachedAt = nowIso();
      for (const item of items) {
        statement.run({
          id: item.id,
          name: typeof item.name === "string" ? item.name : null,
          type: typeof item.type === "string" ? item.type : null,
          subType: typeof item.subType === "string" ? item.subType : null,
          usageType: typeof item.usageType === "string" ? item.usageType : null,
          currency: typeof item.currency === "string" ? item.currency : null,
          isClosed: item.isClosed ? 1 : 0,
          isIgnored: item.isIgnored ? 1 : 0,
          balanceCents: this.optionalCents(item.balanceAsOf),
          balanceAsOfOn: typeof item.balanceAsOfOn === "string" ? item.balanceAsOfOn : null,
          currentBalanceCents: this.optionalCents(item.currentBalanceAsOf),
          onlineBalanceCents: this.optionalCents(item.onlineBalance),
          creditLimitCents: this.optionalCents(item.creditLimit),
          statementDueAt: typeof item.statementDueAt === "string" ? item.statementDueAt : null,
          statementDueAmountCents: this.optionalCents(item.statementDueAmount),
          statementMinPaymentCents: this.optionalCents(item.statementMinPayment),
          statementPastDueAmountCents: this.optionalCents(item.statementPastDueAmount),
          statementCloseAt: typeof item.statementCloseAt === "string" ? item.statementCloseAt : null,
          statementCloseBalanceCents: this.optionalCents(item.statementCloseBalance),
          modifiedAt: typeof item.modifiedAt === "string" ? item.modifiedAt : null,
          rawJson: JSON.stringify(item),
          cachedAt,
        });
      }
    });

    run(accounts);
  }

  /**
   * Replaces the cached account set wholesale.
   *
   * An upsert alone leaves a closed or removed account behind forever, and a
   * stale balance in a net-worth total is worse than a missing one. The endpoint
   * returns every account in one response, so the full set is always known.
   */
  public replaceAccounts(accounts: Account[]): void {
    const run = this.db.transaction((items: Account[]) => {
      const keep = new Set(items.map((item) => item.id));
      for (const row of this.db.prepare<[], { id: string }>(`SELECT id FROM accounts`).all()) {
        if (!keep.has(row.id)) {
          this.db.prepare(`DELETE FROM accounts WHERE id = ?`).run(row.id);
        }
      }
    });

    run(accounts);
    this.upsertAccounts(accounts);
  }

  private toCachedAccount(rawJson: string): CachedAccount {
    const account = JSON.parse(rawJson) as Account;
    const {
      balanceAsOf,
      currentBalanceAsOf,
      onlineBalance,
      creditLimit,
      statementDueAmount,
      statementMinPayment,
      statementPastDueAmount,
      statementCloseBalance,
      statementLastPaymentAmount,
      normalizedBalance,
      goalBalance,
      ...rest
    } = account;

    const cents = (value: unknown): number | undefined => (typeof value === "number" ? toCents(value) : undefined);
    const balanceCents = cents(balanceAsOf);
    const statementDueAmountCents = cents(statementDueAmount);
    const valueCandidate = (
      [
        ["normalizedBalance", normalizedBalance],
        ["onlineBalance", onlineBalance],
        ["currentBalanceAsOf", currentBalanceAsOf],
        ["balanceAsOf", balanceAsOf],
      ] as const
    ).find((candidate) => typeof candidate[1] === "number");
    const valueCents = valueCandidate ? cents(valueCandidate[1]) : undefined;

    return {
      ...rest,
      valueCents,
      valueFormatted: valueCents === undefined ? undefined : formatCents(asCents(valueCents)),
      valueSource: valueCandidate?.[0],
      balanceCents,
      balanceFormatted: balanceCents === undefined ? undefined : formatCents(asCents(balanceCents)),
      currentBalanceCents: cents(currentBalanceAsOf),
      onlineBalanceCents: cents(onlineBalance),
      creditLimitCents: cents(creditLimit),
      statementDueAmountCents,
      statementDueAmountFormatted:
        statementDueAmountCents === undefined ? undefined : formatCents(asCents(statementDueAmountCents)),
      statementMinPaymentCents: cents(statementMinPayment),
      statementPastDueAmountCents: cents(statementPastDueAmount),
      statementCloseBalanceCents: cents(statementCloseBalance),
      statementLastPaymentAmountCents: cents(statementLastPaymentAmount),
      normalizedBalanceCents: cents(normalizedBalance),
      goalBalanceCents: cents(goalBalance),
    };
  }

  public listAccounts(options: { includeClosed?: boolean; type?: string } = {}): CachedAccount[] {
    const where: string[] = [];
    const values: unknown[] = [];

    if (!options.includeClosed) {
      where.push("is_closed = 0");
    }

    if (options.type) {
      where.push("UPPER(type) = ?");
      values.push(options.type.toUpperCase());
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare<unknown[], { raw_json: string }>(`SELECT raw_json FROM accounts ${clause} ORDER BY name COLLATE NOCASE`)
      .all(...values);

    return rows.map((row) => this.toCachedAccount(row.raw_json));
  }

  public upsertScheduledTransactions(scheduled: ScheduledTransaction[]): void {
    if (scheduled.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT INTO scheduled_transactions (
        id, type, due_on, last_due_on, is_completed, recurrence_frequency, recurrence_interval,
        account_id, payee, amount_cents, coa_type, coa_id, is_bill, modified_at, raw_json, cached_at
      ) VALUES (
        @id, @type, @dueOn, @lastDueOn, @isCompleted, @recurrenceFrequency, @recurrenceInterval,
        @accountId, @payee, @amountCents, @coaType, @coaId, @isBill, @modifiedAt, @rawJson, @cachedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        due_on = excluded.due_on,
        last_due_on = excluded.last_due_on,
        is_completed = excluded.is_completed,
        recurrence_frequency = excluded.recurrence_frequency,
        recurrence_interval = excluded.recurrence_interval,
        account_id = excluded.account_id,
        payee = excluded.payee,
        amount_cents = excluded.amount_cents,
        coa_type = excluded.coa_type,
        coa_id = excluded.coa_id,
        is_bill = excluded.is_bill,
        modified_at = excluded.modified_at,
        raw_json = excluded.raw_json,
        cached_at = excluded.cached_at
    `);

    const run = this.db.transaction((items: ScheduledTransaction[]) => {
      const cachedAt = nowIso();
      for (const item of items) {
        const detail = item.transaction;
        statement.run({
          id: item.id,
          type: typeof item.type === "string" ? item.type : null,
          dueOn: typeof item.dueOn === "string" ? item.dueOn.slice(0, 10) : null,
          lastDueOn: typeof item.lastDueOn === "string" ? item.lastDueOn.slice(0, 10) : null,
          isCompleted: item.isCompleted ? 1 : 0,
          recurrenceFrequency: typeof item.recurrence?.frequency === "string" ? item.recurrence.frequency : null,
          recurrenceInterval: typeof item.recurrence?.interval === "number" ? item.recurrence.interval : null,
          accountId: typeof detail?.accountId === "string" ? detail.accountId : null,
          payee: typeof detail?.payee === "string" ? detail.payee : null,
          amountCents: this.optionalCents(detail?.amount),
          coaType: typeof detail?.coa?.type === "string" ? detail.coa.type : null,
          coaId: typeof detail?.coa?.id === "string" ? detail.coa.id : null,
          isBill: detail?.isBill ? 1 : 0,
          modifiedAt: typeof item.modifiedAt === "string" ? item.modifiedAt : null,
          rawJson: JSON.stringify(item),
          cachedAt,
        });
      }
    });

    run(scheduled);
  }

  /** Same reasoning as replaceAccounts: a deleted bill must not linger. */
  public replaceScheduledTransactions(scheduled: ScheduledTransaction[]): void {
    const run = this.db.transaction((items: ScheduledTransaction[]) => {
      const keep = new Set(items.map((item) => item.id));
      for (const row of this.db.prepare<[], { id: string }>(`SELECT id FROM scheduled_transactions`).all()) {
        if (!keep.has(row.id)) {
          this.db.prepare(`DELETE FROM scheduled_transactions WHERE id = ?`).run(row.id);
        }
      }
    });

    run(scheduled);
    this.upsertScheduledTransactions(scheduled);
  }

  private toCachedScheduledTransaction(rawJson: string): CachedScheduledTransaction {
    const scheduled = JSON.parse(rawJson) as ScheduledTransaction;
    const detail = scheduled.transaction;

    if (!detail) {
      return scheduled as CachedScheduledTransaction;
    }

    const { amount, ...detailRest } = detail;
    if (typeof amount !== "number") {
      return { ...scheduled, transaction: detailRest };
    }

    const cents = toCents(amount);
    return { ...scheduled, transaction: { ...detailRest, amountCents: cents, amountFormatted: formatCents(cents) } };
  }

  /**
   * Scheduled entries due on or after `from`, soonest first.
   *
   * `from` is supplied by the caller rather than read from the clock here, so a
   * test can ask the question on a fixed date instead of depending on when it
   * runs.
   */
  public listScheduledTransactions(
    options: { from?: string; to?: string; type?: string; includeCompleted?: boolean } = {},
  ): CachedScheduledTransaction[] {
    const where: string[] = [];
    const values: unknown[] = [];

    if (options.from) {
      where.push("due_on >= ?");
      values.push(options.from);
    }

    if (options.to) {
      where.push("due_on <= ?");
      values.push(options.to);
    }

    if (options.type) {
      where.push("UPPER(type) = ?");
      values.push(options.type.toUpperCase());
    }

    if (!options.includeCompleted) {
      where.push("is_completed = 0");
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare<unknown[], { raw_json: string }>(
        `SELECT raw_json FROM scheduled_transactions ${clause} ORDER BY due_on ASC, id ASC`,
      )
      .all(...values);

    return rows.map((row) => this.toCachedScheduledTransaction(row.raw_json));
  }
}
