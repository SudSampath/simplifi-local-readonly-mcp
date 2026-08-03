import BetterSqlite3 from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { DatabaseContext } from "../../src/db/database.js";
import { aTransaction, someTransactions } from "../support/fixtures.js";

/**
 * These exist because the driver had never actually loaded on the dev machine —
 * better-sqlite3 11.x publishes no prebuilt binary for Node 24, so it fell back
 * to compiling from source and there is no MSVC toolchain here. The failure was
 * invisible until something tried to open a database.
 *
 * So the assertions are deliberately boring: they exercise every driver API this
 * repo actually uses, and they open the real DatabaseContext with its real
 * migrations. A native binding either loads or it does not, and this is what
 * tells us which.
 *
 * `:memory:` throughout, so the suite touches no file. DatabaseContext mkdirs
 * `path.dirname(":memory:")` which resolves to "." — an existing directory, so
 * the call is a no-op rather than a stray write.
 */

const IN_MEMORY = ":memory:";

describe("Given the better-sqlite3 native binding", () => {
  test("When I open an in-memory database, then the binding loads and reports a version", () => {
    const db = new BetterSqlite3(IN_MEMORY);

    try {
      const row = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };

      expect(row.version).toMatch(/^\d+\.\d+/);
    } finally {
      db.close();
    }
  });

  test("When I set the pragmas the cache uses, then neither is rejected", () => {
    const db = new BetterSqlite3(IN_MEMORY);

    try {
      // Both are set by DatabaseContext on every open. An in-memory database
      // reports "memory" for journal_mode rather than "wal", which is fine —
      // this asserts the call is accepted, not the value.
      expect(() => db.pragma("journal_mode = WAL")).not.toThrow();
      expect(() => db.pragma("synchronous = NORMAL")).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("When I exec, prepare, run, get and all, then each behaves as the data layer expects", () => {
    const db = new BetterSqlite3(IN_MEMORY);

    try {
      db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, amount REAL)");
      const insert = db.prepare("INSERT INTO t (id, amount) VALUES (@id, @amount)");

      const result = insert.run({ id: "a", amount: -42.5 });
      insert.run({ id: "b", amount: 7.25 });

      expect(result.changes).toBe(1);
      expect(db.prepare("SELECT amount FROM t WHERE id = ?").get("a")).toEqual({ amount: -42.5 });
      expect(db.prepare("SELECT id FROM t ORDER BY id").all()).toEqual([{ id: "a" }, { id: "b" }]);
    } finally {
      db.close();
    }
  });

  describe("And the data layer wraps writes in a transaction", () => {
    test("When a transaction body succeeds, then every statement in it is committed", () => {
      const db = new BetterSqlite3(IN_MEMORY);

      try {
        db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
        const insert = db.prepare("INSERT INTO t (id) VALUES (?)");

        db.transaction((ids: string[]) => {
          for (const id of ids) {
            insert.run(id);
          }
        })(["a", "b", "c"]);

        expect(db.prepare("SELECT COUNT(*) AS count FROM t").get()).toEqual({ count: 3 });
      } finally {
        db.close();
      }
    });

    test("When a transaction body throws, then nothing it wrote is left behind", () => {
      const db = new BetterSqlite3(IN_MEMORY);

      try {
        db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
        const insert = db.prepare("INSERT INTO t (id) VALUES (?)");

        const failing = db.transaction(() => {
          insert.run("a");
          throw new Error("deliberate failure inside the transaction");
        });

        expect(() => failing()).toThrow(/deliberate failure/);
        // A partial write here would mean a half-synced cache presented as whole.
        expect(db.prepare("SELECT COUNT(*) AS count FROM t").get()).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });
});

describe("Given the real DatabaseContext with its migrations", () => {
  test("When I open it in memory, then the schema applies without error", () => {
    const db = new DatabaseContext(IN_MEMORY);

    try {
      expect(db).toBeInstanceOf(DatabaseContext);
    } finally {
      db.close();
    }
  });

  test("When I upsert a transaction and read it back, then the record round-trips", () => {
    const db = new DatabaseContext(IN_MEMORY);

    try {
      const original = aTransaction({ payee: "Fictional Llama Emporium", amount: -42.5 });

      db.upsertTransactions([original]);
      const readBack = db.getTransactionById(original.id);

      expect(readBack).not.toBeNull();
      expect(readBack?.id).toBe(original.id);
      expect(readBack?.payee).toBe("Fictional Llama Emporium");
      // Money comes back as integer cents plus a display string. The decimal the
      // API sent is deliberately not among the fields a caller can reach.
      expect(readBack?.amountCents).toBe(-4250);
      expect(readBack?.amountFormatted).toBe("-42.50");
      expect(readBack).not.toHaveProperty("amount");
    } finally {
      db.close();
    }
  });

  test("When I upsert the same id twice, then the second write updates rather than duplicates", () => {
    const db = new DatabaseContext(IN_MEMORY);

    try {
      const first = aTransaction({ amount: -10 });
      db.upsertTransactions([first]);
      db.upsertTransactions([aTransaction({ id: first.id, amount: -20 })]);

      expect(db.getTransactionById(first.id)?.amountCents).toBe(-2000);
    } finally {
      db.close();
    }
  });

  test("When I upsert a batch, then every record in it is retrievable", () => {
    const db = new DatabaseContext(IN_MEMORY);

    try {
      const batch = someTransactions(5);

      db.upsertTransactions(batch);

      const missing = batch.filter((transaction) => db.getTransactionById(transaction.id) === null);
      expect(missing.map((transaction) => transaction.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("When I ask for an id that was never written, then it returns null rather than throwing", () => {
    const db = new DatabaseContext(IN_MEMORY);

    try {
      expect(db.getTransactionById("txn-synthetic-absent")).toBeNull();
    } finally {
      db.close();
    }
  });
});
