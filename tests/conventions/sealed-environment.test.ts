import { describe, expect, test } from "vitest";

import { fetchWasForbiddenAtImport, sealedEnvKeysAtImport } from "../support/import-time-probe.js";
import { SEALED_ENV_PREFIXES, installFakeFetch } from "../support/setup.js";

/**
 * Proves the sealed environment is actually sealed. Without these assertions,
 * tests/support/setup.ts is a comment describing an intention.
 */

describe("Given the sealed test environment from setup.ts", () => {
  test("When any code attempts a network call, then it fails with a message naming the target", async () => {
    await expect(fetch("https://services.quicken.com/transactions")).rejects.toThrow(
      /Network access is forbidden in tests.*services\.quicken\.com/s,
    );
  });

  test("When I read the environment, then no Simplifi or OAuth variable is visible", () => {
    const leaked = Object.keys(process.env).filter((key) =>
      SEALED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );

    expect(leaked, "a real .env must not reach the suite").toEqual([]);
  });

  test("When a test installs a fake fetch, then it records the request instead of issuing it", async () => {
    const calls = installFakeFetch(async () => new Response("{}", { status: 200 }));

    const response = await fetch("https://services.quicken.com/categories", { method: "GET" });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://services.quicken.com/categories");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  test("When a module is imported rather than executed in a test, then the seal is already in place", () => {
    // The gap this closes: vitest evaluates setup files before importing the test
    // file, and a test file's imports run before any hook. A seal applied only in
    // beforeEach would leave import-time code — source with top-level side
    // effects — free to read real credentials or call real fetch, while every
    // in-test assertion still passed afterwards.
    expect(sealedEnvKeysAtImport, "no sealed variable may be visible at import time").toEqual([]);
    expect(fetchWasForbiddenAtImport, "fetch must be forbidden at import time too").toBe(true);
  });

  test("When source that loads dotenv at module scope is imported, then no credential appears", async () => {
    // src/config.ts calls dotenv.config() at line 4. Without the dotenv alias in
    // vitest.config.ts, this import would populate process.env from the
    // operator's real .env — on their machine only, which is the worst kind of
    // difference between local and CI.
    await import("../../src/config.js");

    const leaked = Object.keys(process.env).filter((key) =>
      SEALED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );

    expect(leaked, "importing config must not load a real .env").toEqual([]);
  });

  test("When the dotenv stub is used, then config() reports having parsed nothing", async () => {
    const dotenv = await import("dotenv");

    expect(dotenv.default.config().parsed).toEqual({});
  });

  test("When the next test begins, then the forbidden fetch is back in place", async () => {
    // Depends on the beforeEach in setup.ts resetting what the previous test
    // installed. If that ever stops happening, one test leaks HTTP into all
    // the tests that follow it.
    await expect(fetch("https://example.invalid/anything")).rejects.toThrow(/Network access is forbidden/);
  });
});
