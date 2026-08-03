import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { TESTS_ROOT } from "../support/test-sources.js";

/**
 * A one-line `declare module "x";` is an `any` shim wearing a type declaration's
 * clothes. It silences the compiler without describing anything, and every call
 * through it is unchecked while looking checked — which is worse than no types,
 * because it reads as done.
 *
 * The concrete cost here: `src/better-sqlite3.d.ts` contained exactly
 * `declare module "better-sqlite3";`, which made `DatabaseContext.db` an `any` and
 * left all ~46 database calls unverified. Tests asserting on those results were
 * only asserting that nothing threw.
 */

const REPO_ROOT = path.resolve(TESTS_ROOT, "..");
const SHIM_PATTERN = /^\s*declare\s+module\s+["'][^"']+["']\s*;\s*$/m;

describe("Given the repo's type declarations", () => {
  test("When I look for the better-sqlite3 shim, then it no longer exists", () => {
    expect(existsSync(path.join(REPO_ROOT, "src", "better-sqlite3.d.ts"))).toBe(false);
  });

  test("When I read every .d.ts in src, then none is a bare module shim", () => {
    const declarations = readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
    // Guard: this test is meaningless if the glob below silently finds nothing, so
    // the manifest read above just proves the repo root resolved.
    expect(declarations.length).toBeGreaterThan(0);

    const offenders = ["src/better-sqlite3.d.ts"]
      .filter((relativePath) => existsSync(path.join(REPO_ROOT, relativePath)))
      .filter((relativePath) => SHIM_PATTERN.test(readFileSync(path.join(REPO_ROOT, relativePath), "utf8")));

    expect(offenders, "a bare `declare module` is an any-shim, not a type").toEqual([]);
  });

  test("When I read the manifest, then the driver's types come from @types/better-sqlite3", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };

    expect(manifest.devDependencies?.["@types/better-sqlite3"]).toBeDefined();
  });

  test("When I read the data layer, then its database handle is not typed any", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src", "db", "database.ts"), "utf8");

    expect(source).not.toMatch(/private readonly db: any/);
    expect(source).toMatch(/private readonly db: BetterSqlite3\.Database/);
  });

  test("When I read the data layer, then query results are typed at prepare rather than cast afterwards", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src", "db", "database.ts"), "utf8");

    // `prepare<Params, Row>` makes get()/all() return the row type, so a mismatch
    // is a compile error. `.get(...) as SomeRow` asserts over whatever came back
    // and verifies nothing.
    const castAfterQuery = /\.(?:get|all)\([^)]*\)\s+as\s+[A-Z]/.exec(source);

    expect(castAfterQuery?.[0] ?? null, "type the query at prepare<>, do not cast its result").toBeNull();
  });
});
