import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DatabaseContext } from "../../src/db/database.js";
import type { AppConfig } from "../../src/config.js";
import { RefreshCoordinator, type RefreshKind } from "../../src/runtime/refresh-coordinator.js";
import { AccountService } from "../../src/services/account-service.js";
import { SimplifiClient } from "../../src/simplifi/client.js";
import { SyncService } from "../../src/sync/sync-service.js";
import type { Account } from "../../src/types.js";
import { aTransaction } from "../support/fixtures.js";

const directories: string[] = [];

function scratchDbPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "hfm-refresh-"));
  directories.push(directory);
  return path.join(directory, "cache.sqlite");
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

const KINDS: RefreshKind[] = [
  "transactions-full",
  "transactions-incremental",
  "accounts",
  "scheduled-transactions",
  "categories",
  "tags",
];

const SYNTHETIC_CONFIG: AppConfig["simplifi"] = {
  baseUrl: "https://simplifi.invalid",
  email: "synthetic@example.invalid",
  password: "placeholder-not-a-real-password",
  datasetId: "synthetic-dataset",
  clientId: "synthetic-client",
  clientSecret: "placeholder-not-a-real-secret",
  redirectUri: "https://simplifi.invalid/login",
  httpTimeoutMs: 1_000,
  syncIntervalMs: 60_000,
  maxStaleMs: 60_000,
  pageLimit: 5_000,
};

describe("Given several hosts share one cache writer", () => {
  test("When readers request every refresh class, then the writer handles each without invoking reader work", async () => {
    const dbPath = scratchDbPath();
    const writer = new RefreshCoordinator(dbPath, "writer");
    const reader = new RefreshCoordinator(dbPath, "reader", process.pid);
    const handled: RefreshKind[] = [];
    const handlers = Object.fromEntries(
      KINDS.map((kind) => [kind, async () => {
        handled.push(kind);
        return { kind };
      }]),
    ) as Record<RefreshKind, () => Promise<unknown>>;

    writer.start(handlers);
    try {
      for (const kind of KINDS) {
        const result = await reader.run<{ kind: RefreshKind }>(kind, async () => {
          throw new Error("reader-local work must never run");
        });
        expect(result.kind).toBe(kind);
      }

      expect(handled).toEqual(KINDS);
    } finally {
      writer.stop();
    }
  });

  test("When two readers request one refresh together, then one writer call satisfies both", async () => {
    const dbPath = scratchDbPath();
    const writer = new RefreshCoordinator(dbPath, "writer");
    const firstReader = new RefreshCoordinator(dbPath, "reader", process.pid);
    const secondReader = new RefreshCoordinator(dbPath, "reader", process.pid);
    let calls = 0;

    writer.start({
      ...Object.fromEntries(KINDS.map((kind) => [kind, async () => undefined])),
      accounts: async () => {
        calls += 1;
        return "refreshed";
      },
    } as Record<RefreshKind, () => Promise<unknown>>);

    try {
      const results = await Promise.all([
        firstReader.run("accounts", async () => "wrong"),
        secondReader.run("accounts", async () => "wrong"),
      ]);

      expect(results).toEqual(["refreshed", "refreshed"]);
      expect(calls).toBe(1);
    } finally {
      writer.stop();
    }
  });
});

describe("Given a reader delegates an account refresh", () => {
  test("When the writer replaces the collection, then the reader sees it without becoming writable", async () => {
    const dbPath = scratchDbPath();
    const writerDb = new DatabaseContext(dbPath);
    const readerDb = new DatabaseContext(dbPath, { readOnly: true });
    const writerCoordinator = new RefreshCoordinator(dbPath, "writer");
    const readerCoordinator = new RefreshCoordinator(dbPath, "reader", process.pid);
    const syntheticAccount: Account = {
      id: "acct-synthetic",
      name: "Fictional Teal Credit Union",
      type: "BANK",
      balanceAsOf: 123.45,
    };
    const writerClient = {
      listAccounts: async () => ({ resources: [syntheticAccount], metaData: {} }),
    } as unknown as SimplifiClient;
    const readerClient = new Proxy({} as SimplifiClient, {
      get: (_target, property) => {
        throw new Error(`reader must not call Simplifi directly: ${String(property)}`);
      },
    });
    const writerAccounts = new AccountService(writerDb, writerClient, writerCoordinator);
    const readerAccounts = new AccountService(readerDb, readerClient, readerCoordinator);

    writerCoordinator.start({
      ...Object.fromEntries(KINDS.map((kind) => [kind, async () => undefined])),
      accounts: () => writerAccounts.syncAccounts(),
    } as Record<RefreshKind, () => Promise<unknown>>);

    try {
      expect(readerAccounts.listAccounts()).toEqual([]);

      // No force flag: an ordinary read path must populate an empty collection
      // through the writer so a newly connected agent gets an answer first try.
      await readerAccounts.ensureAccountsFresh(60_000);

      expect(readerDb.readOnly).toBe(true);
      expect(readerAccounts.listAccounts().map((account) => account.id)).toEqual(["acct-synthetic"]);
    } finally {
      writerCoordinator.stop();
      readerDb.close();
      writerDb.close();
    }
  });
});

describe("Given a reader opens an empty transaction cache", () => {
  test("When it performs an ordinary freshness check, then the writer builds the cache", async () => {
    const dbPath = scratchDbPath();
    const writerDb = new DatabaseContext(dbPath);
    const readerDb = new DatabaseContext(dbPath, { readOnly: true });
    const writerCoordinator = new RefreshCoordinator(dbPath, "writer");
    const readerCoordinator = new RefreshCoordinator(dbPath, "reader", process.pid);
    const writerClient = {
      getEarliestDateOn: async () => ({ dateOn: "2026-01-01" }),
      listTransactions: async () => ({
        resources: [aTransaction({ id: "txn-writer-owned" })],
        metaData: { asOf: "2026-08-03T00:00:00.000Z" },
      }),
    } as unknown as SimplifiClient;
    const readerClient = new Proxy({} as SimplifiClient, {
      get: (_target, property) => {
        throw new Error(`reader must not call Simplifi directly: ${String(property)}`);
      },
    });
    const writerSync = new SyncService(SYNTHETIC_CONFIG, writerDb, writerClient, writerCoordinator);
    const readerSync = new SyncService(SYNTHETIC_CONFIG, readerDb, readerClient, readerCoordinator);

    writerCoordinator.start({
      ...Object.fromEntries(KINDS.map((kind) => [kind, async () => undefined])),
      "transactions-full": () => writerSync.syncFull(),
      "transactions-incremental": () => writerSync.syncIncremental(),
    } as Record<RefreshKind, () => Promise<unknown>>);

    try {
      const result = await readerSync.ensureFresh(60_000);

      expect(result.mode).toBe("full");
      expect(readerDb.getTransactionById("txn-writer-owned")).not.toBeNull();
      expect(readerDb.readOnly).toBe(true);
    } finally {
      writerCoordinator.stop();
      readerDb.close();
      writerDb.close();
    }
  });
});
