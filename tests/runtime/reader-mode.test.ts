import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import { DatabaseContext } from "../../src/db/database.js";
import { CacheLease } from "../../src/runtime/cache-lease.js";
import { SyncService } from "../../src/sync/sync-service.js";
import type { AppConfig } from "../../src/config.js";
import { SimplifiClient } from "../../src/simplifi/client.js";

/**
 * Two agent hosts registering the same server is a supported configuration, not
 * a race one of them silently loses.
 *
 * The lease serializes *syncing*, not reading — SQLite in WAL mode supports many
 * readers alongside one writer. So the second instance opens the cache read-only
 * and answers from it. What it must never do is write, or present a stale answer
 * as a fresh one.
 */

const directories: string[] = [];

function scratchDbPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "hfm-reader-"));
  directories.push(directory);
  return path.join(directory, "cache.sqlite");
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

/** A client that fails the test if any request reaches it. A reader makes none. */
function clientThatMustNotBeCalled(): SimplifiClient {
  return new Proxy({} as SimplifiClient, {
    get: (_target, property) => {
      throw new Error(`A read-only instance must not call Simplifi, but it called ${String(property)}`);
    },
  });
}

const SYNTHETIC_SIMPLIFI: AppConfig["simplifi"] = {
  baseUrl: "https://example.invalid",
  email: "example@example.invalid",
  password: "placeholder-not-a-real-password",
  datasetId: "example-dataset",
  clientId: "example-client",
  clientSecret: "placeholder-secret",
  redirectUri: "https://example.invalid/login",
  httpTimeoutMs: 1_000,
  syncIntervalMs: 1_000,
  maxStaleMs: 1_000,
  pageLimit: 10,
};

describe("Given another live process already holds the writer lease", () => {
  test("When a second instance starts, then it takes the reader role and names the writer", () => {
    const dbPath = scratchDbPath();
    const writer = CacheLease.acquire(dbPath);

    try {
      const reader = CacheLease.acquire(dbPath);

      expect(reader.role).toBe("reader");
      expect(reader.writerPid).toBe(process.pid);
    } finally {
      writer.release();
    }
  });

  test("When the reader opens the cache, then it opens read-only and refuses to write", () => {
    const dbPath = scratchDbPath();
    // The writer must exist first — a reader cannot create the cache.
    const writerDb = new DatabaseContext(dbPath);

    try {
      const readerDb = new DatabaseContext(dbPath, { readOnly: true });

      try {
        expect(readerDb.readOnly).toBe(true);
        // Reading works; that is the entire point of the role.
        expect(() => readerDb.getSyncState()).not.toThrow();
        // Writing does not, and SQLite is what enforces it rather than a flag we
        // remember to check.
        expect(() => readerDb.updateSyncState({ syncStatus: "running" })).toThrow(/readonly/i);
      } finally {
        readerDb.close();
      }
    } finally {
      writerDb.close();
    }
  });
});

describe("Given an instance in reader mode", () => {
  test("When a sync is requested, then it declines with the reason instead of writing", async () => {
    const dbPath = scratchDbPath();
    const writerDb = new DatabaseContext(dbPath);

    try {
      const readerDb = new DatabaseContext(dbPath, { readOnly: true });
      const sync = new SyncService(SYNTHETIC_SIMPLIFI, readerDb, clientThatMustNotBeCalled());

      try {
        for (const result of [
          await sync.ensureInitialized(),
          await sync.ensureFresh(0),
          await sync.syncFull(),
          await sync.syncIncremental(),
        ]) {
          expect(result.mode).toBe("read-only");
          expect(result.transactions).toBe(0);
          expect(result.reason).toMatch(/cannot refresh/i);
        }
      } finally {
        readerDb.close();
      }
    } finally {
      writerDb.close();
    }
  });

  test("When the background interval would start, then a reader starts none", () => {
    const dbPath = scratchDbPath();
    const writerDb = new DatabaseContext(dbPath);

    try {
      const readerDb = new DatabaseContext(dbPath, { readOnly: true });
      const sync = new SyncService(SYNTHETIC_SIMPLIFI, readerDb, clientThatMustNotBeCalled());

      try {
        sync.start();
        // A started interval keeps the process alive and fails every tick. If
        // start() had registered one, stop() would be the only thing clearing
        // it, and an unref'd handle would hold the event loop open past here.
        expect(sync.hasBackgroundInterval).toBe(false);
        sync.stop();
      } finally {
        readerDb.close();
      }
    } finally {
      writerDb.close();
    }
  });
});

describe("Given a reader whose cache cannot answer", () => {
  test("When the cache does not exist, then it says a reader cannot build one", () => {
    const dbPath = scratchDbPath();

    expect(() => new DatabaseContext(dbPath, { readOnly: true })).toThrow(/reader cannot create or sync the cache/i);
  });

  test("When the cache predates the required schema, then it names the writer as the only repair", () => {
    const dbPath = scratchDbPath();
    const writerDb = new DatabaseContext(dbPath);
    writerDb.close();

    // Recreate the pre-SUD-31 shape: a transactions table with no txn_on. A
    // writer discards and resyncs this; a reader has neither option, and
    // discarding without the ability to resync would turn a stale answer into an
    // empty one.
    const raw = new BetterSqlite3(dbPath);
    raw.exec(`DROP TABLE transactions; CREATE TABLE transactions (id TEXT PRIMARY KEY, amount_cents INTEGER);`);
    raw.close();

    expect(() => new DatabaseContext(dbPath, { readOnly: true })).toThrow(/predates the current schema/i);
    expect(() => new DatabaseContext(dbPath, { readOnly: true })).toThrow(/writer lease/i);
  });
});
