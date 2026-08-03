import { afterEach, describe, expect, test, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { DatabaseContext } from "../../src/db/database.js";
import { SimplifiClient } from "../../src/simplifi/client.js";
import { ReferenceDataService } from "../../src/services/reference-data-service.js";
import { TransactionToolService } from "../../src/services/transaction-tool-service.js";
import { SyncService } from "../../src/sync/sync-service.js";
import { aTransaction } from "../support/fixtures.js";

const SYNTHETIC_CONFIG: AppConfig["simplifi"] = {
  baseUrl: "https://simplifi.invalid",
  email: "synthetic@example.invalid",
  password: "test-password",
  datasetId: "dataset-synthetic",
  clientId: "client-synthetic",
  clientSecret: "test-client-secret",
  redirectUri: "https://simplifi.invalid/login",
  httpTimeoutMs: 1_000,
  syncIntervalMs: 60_000,
  maxStaleMs: 120_000,
  pageLimit: 5_000,
};

const OPEN_DATABASES: DatabaseContext[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of OPEN_DATABASES.splice(0)) {
    db.close();
  }
});

function anEmptyDatabaseWithARecentMarker(): DatabaseContext {
  const db = new DatabaseContext(":memory:");
  OPEN_DATABASES.push(db);
  db.updateSyncState({ lastSyncAt: "2026-08-03T00:00:00.000Z" });
  return db;
}

function aSuccessfulClient() {
  const transaction = aTransaction({ id: "txn-recovered" });
  return {
    getEarliestDateOn: vi.fn().mockResolvedValue({ dateOn: "2026-01-01" }),
    listTransactions: vi.fn().mockResolvedValue({
      metaData: { asOf: "2026-08-03T00:01:00.000Z" },
      resources: [transaction],
    }),
    listTransactionsFromNextLink: vi.fn(),
  };
}

describe("Given a discarded cache with a recent last-sync marker but no completed full sync", () => {
  test("When a transaction tool reads it, then a full sync runs and the answer uses the recovered rows", async () => {
    const db = anEmptyDatabaseWithARecentMarker();
    const clientDouble = aSuccessfulClient();
    const client = clientDouble as unknown as SimplifiClient;
    const sync = new SyncService(SYNTHETIC_CONFIG, db, client);
    const service = new TransactionToolService(
      db,
      sync,
      client,
      new ReferenceDataService(SYNTHETIC_CONFIG, db, client),
      Number.POSITIVE_INFINITY,
    );

    const answer = await service.listTransactions({});

    expect(clientDouble.getEarliestDateOn).toHaveBeenCalledOnce();
    expect(clientDouble.listTransactions).toHaveBeenCalledOnce();
    expect(answer.total).toBe(1);
    expect(answer.items).toEqual([expect.objectContaining({ id: "txn-recovered" })]);
    expect(db.getSyncState()).toMatchObject({
      lastFullSyncAt: expect.any(String),
      lastSyncAt: expect.any(String),
      syncStatus: "ok",
    });
  });

  test("When freshness is evaluated, then the recent marker is not accepted as evidence of initialized data", async () => {
    const db = anEmptyDatabaseWithARecentMarker();
    const clientDouble = aSuccessfulClient();
    const sync = new SyncService(SYNTHETIC_CONFIG, db, clientDouble as unknown as SimplifiClient);

    const result = await sync.ensureFresh(Number.POSITIVE_INFINITY);

    expect(result.mode).toBe("full");
    expect(clientDouble.listTransactions).toHaveBeenCalledOnce();
    expect(db.getTransactionById("txn-recovered")).not.toBeNull();
  });
});

describe("Given a background incremental sync with no completed full sync behind it", () => {
  test("When the fallback full sync succeeds, then it records a full sync rather than an incremental freshness marker", async () => {
    const db = anEmptyDatabaseWithARecentMarker();
    const clientDouble = aSuccessfulClient();
    const sync = new SyncService(SYNTHETIC_CONFIG, db, clientDouble as unknown as SimplifiClient);

    const result = await sync.syncIncremental();
    const state = db.getSyncState();

    expect(result.mode).toBe("full");
    expect(state.lastFullSyncAt).toEqual(state.lastSyncAt);
    expect(db.getTransactionById("txn-recovered")).not.toBeNull();
  });

  test("When the fallback full sync fails, then the failed attempt does not advance the freshness marker", async () => {
    const db = anEmptyDatabaseWithARecentMarker();
    const markerBeforeAttempt = db.getSyncState().lastSyncAt;
    const clientDouble = {
      getEarliestDateOn: vi.fn().mockRejectedValue(new Error("synthetic upstream failure")),
      listTransactions: vi.fn(),
      listTransactionsFromNextLink: vi.fn(),
    };
    const sync = new SyncService(SYNTHETIC_CONFIG, db, clientDouble as unknown as SimplifiClient);

    await expect(sync.syncIncremental()).rejects.toThrow("synthetic upstream failure");

    expect(db.getSyncState()).toMatchObject({
      lastFullSyncAt: undefined,
      lastSyncAt: markerBeforeAttempt,
      syncStatus: "error",
      lastError: "synthetic upstream failure",
    });
  });
});
