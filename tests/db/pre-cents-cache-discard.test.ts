import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DatabaseContext } from "../../src/db/database.js";

/**
 * A cache written under `amount REAL` holds values that already went through a
 * float. Converting it in place would carry that drift into the integer column
 * and defeat the point, so the honest migration is to discard and resync — it
 * is a cache, and the cost is one sync.
 */

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Builds the pre-SUD-13 shape: REAL money, one row, and a completed sync. */
function writeLegacyCache(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "pre-cents-"));
  directories.push(directory);
  const dbPath = path.join(directory, "cache.sqlite");

  const legacy = new BetterSqlite3(dbPath);
  legacy.exec(`
    CREATE TABLE sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      date_on_after TEXT,
      last_as_of TEXT,
      last_full_sync_at TEXT,
      last_sync_at TEXT,
      sync_status TEXT,
      last_error TEXT
    );
    INSERT INTO sync_state (id, last_as_of, last_full_sync_at, last_sync_at, sync_status)
    VALUES (1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'ok');

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      posted_on TEXT,
      amount REAL,
      raw_json TEXT NOT NULL,
      cached_at TEXT NOT NULL
    );
    INSERT INTO transactions (id, posted_on, amount, raw_json, cached_at)
    VALUES ('legacy-1', '2026-01-01', -42.5, '{"id":"legacy-1","amount":-42.5}', '2026-01-01T00:00:00Z');
  `);
  legacy.close();

  return dbPath;
}

describe("Given a cache written before money became integer cents", () => {
  test("When the server opens it, then the transactions are discarded rather than converted in place", () => {
    const dbPath = writeLegacyCache();
    const context = new DatabaseContext(dbPath);

    try {
      expect(context.getTransactionById("legacy-1")).toBeNull();
    } finally {
      context.close();
    }
  });

  test("When the server opens it, then the schema is rebuilt with an integer money column", () => {
    const dbPath = writeLegacyCache();
    const context = new DatabaseContext(dbPath);

    try {
      const columns = context.describeSchema().columns.transactions ?? [];

      expect(columns.find((c) => c.name === "amount_cents")?.type).toBe("INTEGER");
      expect(columns.find((c) => c.name === "amount")).toBeUndefined();
    } finally {
      context.close();
    }
  });

  test("When the server opens it, then sync state is cleared so a full resync follows", () => {
    const dbPath = writeLegacyCache();
    const context = new DatabaseContext(dbPath);

    try {
      const state = context.getSyncState();

      // ensureInitialized triggers a full sync only when lastFullSyncAt is absent.
      // Leaving it set would present an empty cache as a complete one.
      expect(state.lastFullSyncAt).toBeUndefined();
      expect(state.lastSyncAt).toBeUndefined();
      expect(state.lastAsOf).toBeUndefined();
    } finally {
      context.close();
    }
  });

  test("When the discard happens, then it is logged rather than being silent", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dbPath = writeLegacyCache();
    const context = new DatabaseContext(dbPath);

    try {
      const logged = consoleError.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("Discarding incompatible transaction cache"));

      expect(logged).toHaveLength(1);
    } finally {
      context.close();
    }
  });

  test("When a cache already on the new schema is opened, then nothing is discarded", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "post-cents-"));
    directories.push(directory);
    const dbPath = path.join(directory, "cache.sqlite");

    const first = new DatabaseContext(dbPath);
    first.upsertTransactions([{ id: "kept-1", amount: -42.5, postedOn: "2026-01-01" }]);
    first.close();

    const second = new DatabaseContext(dbPath);

    try {
      // Reopening must not be destructive, or every restart would resync.
      expect(second.getTransactionById("kept-1")?.amountCents).toBe(-4250);
    } finally {
      second.close();
    }
  });
});
