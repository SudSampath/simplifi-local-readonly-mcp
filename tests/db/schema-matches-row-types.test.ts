import { describe, expect, test } from "vitest";

import { DatabaseContext, type SchemaColumn } from "../../src/db/database.js";

/**
 * Pins the migrated schema against what the query layer expects.
 *
 * SUD-19's acceptance criteria asked that "removing a column from a schema
 * definition causes a typecheck failure somewhere". **That is not achievable as
 * written**, and saying so is more useful than pretending otherwise: the schema is
 * a SQL string passed to `exec()`, and no amount of typing lets the compiler read
 * inside it. Compile-time enforcement would mean generating types from the schema —
 * real work, and disproportionate for a household project with one table that
 * matters.
 *
 * This is the achievable form of the same guarantee, moved from compile time to
 * test time: the column set is asserted by name, so dropping or renaming one fails
 * here and names the column. Combined with the row types now being real rather than
 * casts over `any`, a schema change the query layer does not expect cannot pass
 * silently in both directions.
 *
 * `:memory:` throughout, so no file is written.
 */

function withSchema<T>(use: (schema: ReturnType<DatabaseContext["describeSchema"]>) => T): T {
  const context = new DatabaseContext(":memory:");
  try {
    return use(context.describeSchema());
  } finally {
    context.close();
  }
}

function column(columns: SchemaColumn[], name: string): SchemaColumn | undefined {
  return columns.find((candidate) => candidate.name === name);
}

/**
 * The transactions table is the one every correctness ticket depends on, so its
 * columns are pinned by name.
 */
const EXPECTED_TRANSACTION_COLUMNS = [
  "account_id",
  "amount_cents",
  "cached_at",
  "coa_id",
  "coa_type",
  "id",
  "is_deleted",
  "known_category_id",
  "memo",
  "ml_inferred_payee",
  "modified_at",
  "payee",
  "posted_on",
  "raw_json",
  "renamed_payee",
  "state",
  "txn_on",
  "user_modified_at",
];

describe("Given a database migrated by DatabaseContext", () => {
  test("When I inspect the transactions table, then its columns are exactly what the query layer expects", () => {
    withSchema((schema) => {
      const names = (schema.columns.transactions ?? []).map((entry) => entry.name).sort();

      expect(names).toEqual([...EXPECTED_TRANSACTION_COLUMNS].sort());
    });
  });

  test("When I inspect raw_json, then it is NOT NULL, because every read parses it", () => {
    withSchema((schema) => {
      // getTransactionById and every list query return JSON.parse(row.raw_json).
      // A nullable raw_json makes that a runtime crash rather than a type error.
      expect(column(schema.columns.transactions ?? [], "raw_json")?.notNull).toBe(true);
    });
  });

  test("When I inspect the money column, then it is INTEGER cents rather than REAL", () => {
    withSchema((schema) => {
      // The counterpart of the tripwire this replaces. SUD-13 landed, so the
      // assertion inverts: money is an integer column and the old REAL one is
      // gone rather than sitting alongside it.
      expect(column(schema.columns.transactions ?? [], "amount_cents")?.type).toBe("INTEGER");
      expect(column(schema.columns.transactions ?? [], "amount")).toBeUndefined();
    });
  });

  test("When I inspect every table, then no column storing money has type REAL", () => {
    withSchema((schema) => {
      const offenders: string[] = [];

      for (const [table, columns] of Object.entries(schema.columns)) {
        for (const candidate of columns) {
          const isMoney = /amount|balance|payment|price|limit|cost/i.test(candidate.name);
          if (isMoney && candidate.type === "REAL") {
            offenders.push(`${table}.${candidate.name}`);
          }
        }
      }

      // Guards the tables SUD-32 will add as much as the ones here: a money
      // column typed REAL is the defect, wherever it appears.
      expect(offenders, "money columns must be INTEGER cents").toEqual([]);
    });
  });

  test("When I inspect the id column, then it is the primary key the upsert relies on", () => {
    withSchema((schema) => {
      // upsertTransactions uses ON CONFLICT(id); without id being the key, that
      // clause silently stops de-duplicating and the cache accumulates copies.
      expect(column(schema.columns.transactions ?? [], "id")?.primaryKey).toBe(true);
    });
  });

  test("When I inspect the id column, then it is NOT NULL, so ON CONFLICT cannot stop de-duplicating", () => {
    withSchema((schema) => {
      // Flipped as the previous assertion asked: it pinned the hazard that a
      // TEXT PRIMARY KEY permits one NULL id in SQLite, and NULLs comparing
      // distinct would make ON CONFLICT(id) silently accumulate copies. The
      // cents rebuild was the cheap moment to close it, so it is closed.
      expect(column(schema.columns.transactions ?? [], "id")?.notNull).toBe(true);
    });
  });

  test("When I list the tables, then every table the query layer reads exists", () => {
    withSchema((schema) => {
      for (const table of ["transactions", "categories", "tags", "simplifi_tokens", "sync_state"]) {
        expect(schema.tables, `${table} is read by the query layer`).toContain(table);
      }
    });
  });

  test("When I read the schema description, then it is not silently empty", () => {
    withSchema((schema) => {
      expect(schema.tables.length).toBeGreaterThan(3);
      expect(Object.keys(schema.columns).length).toBe(schema.tables.length);
    });
  });
});
