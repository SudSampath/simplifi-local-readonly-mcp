import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { TESTS_ROOT } from "../support/test-sources.js";

/**
 * These assertions encode a root cause that cost real time to find, so that
 * nobody re-introduces it from muscle memory.
 *
 * better-sqlite3 13.x ships N-API prebuilt binaries for every platform inside
 * its own tarball (node_modules/better-sqlite3/prebuilds/*.node). npm uses them.
 * **yarn 1 does not**: it unconditionally runs `node-gyp rebuild` for any package
 * containing a binding.gyp, ignoring the shipped prebuild — which on a machine
 * with no MSVC toolchain means the install fails and the server cannot start.
 *
 * That is why this repo is on npm. It is not a style preference, and switching
 * back to yarn 1 would break the install on the primary dev machine.
 */

const REPO_ROOT = path.resolve(TESTS_ROOT, "..");
const SQLITE_PACKAGE = path.join(REPO_ROOT, "node_modules", "better-sqlite3");

function readRepoJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8")) as Record<string, unknown>;
}

describe("Given the repo's declared package manager", () => {
  const manifest = readRepoJson("package.json");

  test("When I read packageManager, then it is npm rather than yarn", () => {
    expect(String(manifest.packageManager)).toMatch(/^npm@/);
  });

  test("When I look for a yarn lockfile, then none is present to be used by mistake", () => {
    expect(existsSync(path.join(REPO_ROOT, "yarn.lock"))).toBe(false);
  });

  test("When I look for the npm lockfile, then it exists so npm ci can gate merges", () => {
    expect(existsSync(path.join(REPO_ROOT, "package-lock.json"))).toBe(true);
  });
});

describe("Given the installed better-sqlite3 package", () => {
  test("When I read its version, then it is at least 13, where the N-API prebuilds ship", () => {
    const installed = JSON.parse(
      readFileSync(path.join(SQLITE_PACKAGE, "package.json"), "utf8"),
    ) as { version: string };

    const major = Number(installed.version.split(".")[0]);

    expect(major, `installed ${installed.version}; 11.x has no Node 24 prebuild`).toBeGreaterThanOrEqual(13);
  });

  test("When I inspect the package, then a prebuilt binary for this platform is present", () => {
    // This is the invariant that matters. A machine with no compiler can only
    // install this dependency if a prebuild for its platform ships in the
    // tarball — which is the whole reason for the 13.x bump.
    const prebuild = path.join(SQLITE_PACKAGE, "prebuilds", `${process.platform}-${process.arch}.node`);

    expect(existsSync(prebuild), `expected a shipped prebuild at ${prebuild}`).toBe(true);
  });

  test("When I inspect the package, then nothing was compiled from source", () => {
    // A build/ directory means the install ran node-gyp. With ignore-scripts in
    // .npmrc that cannot happen on any platform, which is what makes this a real
    // invariant rather than a platform detail.
    //
    // An earlier version of this file asserted the same thing *without* the
    // .npmrc, and it failed on Linux CI while passing on Windows — because a
    // runner with a compiler builds silently and a machine without one fails the
    // install. That asymmetry is the bug: the platform that succeeds is the one
    // that hides it.
    expect(existsSync(path.join(SQLITE_PACKAGE, "build"))).toBe(false);
  });

  test("When I load the binding, then it works with no toolchain involved", () => {
    const db = new BetterSqlite3(":memory:");

    try {
      expect(db.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    } finally {
      db.close();
    }
  });
});

describe("Given the repo's npm configuration", () => {
  const npmrc = readFileSync(path.join(REPO_ROOT, ".npmrc"), "utf8");

  test("When I read .npmrc, then install scripts are disabled", () => {
    // This is the actual fix for SUD-18, and it is load-bearing: package managers
    // run an implicit `node-gyp rebuild` for any package with a binding.gyp,
    // regardless of a prebuilt binary already shipping in the tarball. On a
    // machine without MSVC that fails the entire install.
    expect(npmrc).toMatch(/^ignore-scripts=true$/m);
  });

  test("When I read .npmrc, then the reason is written down rather than left to be rediscovered", () => {
    expect(npmrc).toMatch(/prebuild/i);
    expect(npmrc).toMatch(/binding\.gyp/);
  });
});

describe("Given the supported Node range in engines", () => {
  const manifest = readRepoJson("package.json") as { engines?: { node?: string } };

  test("When I read it, then it states a range we have actually verified", () => {
    // Was ">=20.11", inherited from upstream and never true here: Node 20 is
    // EOL and nothing in this project has been run on it.
    expect(manifest.engines?.node).toBe(">=22");
  });
});
