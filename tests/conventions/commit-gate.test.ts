import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { TESTS_ROOT } from "../support/test-sources.js";

/**
 * The commit gate has two halves and both must exist, because either one alone
 * is bypassable: the hook can be skipped with --no-verify, and CI only runs once
 * a branch is pushed.
 *
 * These assertions check the gate is wired, not that it fires. Making the hook
 * actually reject a commit inside a test would mean running the suite from
 * inside the suite. That half is verified by hand once and recorded on SUD-6.
 */

const REPO_ROOT = path.resolve(TESTS_ROOT, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("Given the committed pre-commit hook", () => {
  const hook = readRepoFile(".githooks/pre-commit");

  test("When a commit is attempted, then the hook scans staged changes for real financial data", () => {
    expect(hook).toMatch(/^\s*npx tsx scripts\/secret-scan\.ts\s*$/m);
  });

  test("When the hook runs, then the secret scan comes before the slower checks", () => {
    // Ordering is deliberate: a type error is fixable in the next commit, a real
    // transaction in git history is not removable from clones that already have it.
    const scanAt = hook.indexOf("secret-scan");
    const typecheckAt = hook.indexOf("npm run typecheck");

    expect(scanAt).toBeGreaterThan(-1);
    expect(scanAt).toBeLessThan(typecheckAt);
  });

  test("When a commit is attempted, then the hook runs the typecheck", () => {
    expect(hook).toMatch(/^\s*npm run typecheck\s*$/m);
  });

  test("When a commit is attempted, then the hook runs the test suite once rather than in watch mode", () => {
    expect(hook).toMatch(/^\s*npm test -- --run\s*$/m);
  });

  test("When either command fails, then the hook aborts instead of continuing", () => {
    expect(hook).toMatch(/^set -e$/m);
  });
});

describe("Given the package manifest", () => {
  const manifest = JSON.parse(readRepoFile("package.json")) as {
    scripts?: Record<string, string>;
  };

  test("When I look for the enable-hooks command, then setup-hooks points git at .githooks", () => {
    expect(manifest.scripts?.["setup-hooks"]).toBe("git config core.hooksPath .githooks");
  });

  test("When I look for the test command, then it runs vitest", () => {
    expect(manifest.scripts?.test).toMatch(/vitest/);
  });

  test("When I look for the typecheck command, then it exists and is not named 'check'", () => {
    // Kept as "typecheck" for clarity, and originally renamed for a concrete
    // reason: yarn 1 ships a builtin `check` that shadows a same-named script,
    // so upstream's "check": "tsc --noEmit" was verifying node_modules and
    // exiting 0 — it had silently never run. The repo is on npm now, so the
    // shadow no longer applies, but the unambiguous name is worth keeping.
    expect(manifest.scripts?.typecheck, "the typecheck script must exist").toMatch(/tsc/);
    expect(manifest.scripts?.check, "avoid the ambiguous name entirely").toBeUndefined();
  });

  test("When the typecheck runs, then it covers the tests as well as src", () => {
    expect(manifest.scripts?.typecheck).toMatch(/tsconfig\.test\.json/);
  });
});

describe("Given the CI workflow", () => {
  const workflow = readRepoFile(".github/workflows/ci.yml");

  test("When CI runs, then it executes the same typecheck the hook does", () => {
    expect(workflow).toMatch(/npm run typecheck/);
  });

  test("When CI runs, then it executes the suite so a bypassed hook is still caught", () => {
    expect(workflow).toMatch(/npm test -- --run/);
  });

  test("When CI installs dependencies, then it uses npm ci so the lockfile gates the merge", () => {
    expect(workflow).toMatch(/npm ci/);
  });

  test("When CI runs, then it covers both ends of the supported Node range", () => {
    // The native binding is the reason this matrix exists: a prebuild that is
    // missing for one Node version fails there and nowhere else.
    expect(workflow).toMatch(/node-version: \["22", "24"\]/);
  });

  test("When CI runs, then it covers Windows and not only Linux", () => {
    // Load-bearing: the primary dev machine is Windows with no MSVC toolchain. A
    // Linux-only matrix went green while a clean install on that machine failed,
    // because a runner with a compiler builds silently. The platform that hides
    // the problem cannot be the only one tested.
    expect(workflow).toMatch(/windows-latest/);
  });

  test("When CI installs, then it verifies the native binding loads before running tests", () => {
    expect(workflow).toMatch(/require\('better-sqlite3'\)/);
  });

  test("When a pull request is opened, then the workflow is triggered by it", () => {
    expect(workflow).toMatch(/pull_request/);
  });
});
