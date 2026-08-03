import { afterEach, describe, expect, test, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { DatabaseContext } from "../../src/db/database.js";
import { SimplifiAuthService } from "../../src/simplifi/auth-service.js";
import { SimplifiClient } from "../../src/simplifi/client.js";
import { SyncService } from "../../src/sync/sync-service.js";

/**
 * SUD-29. The server must never perform a credential login.
 *
 * A password login is what makes Simplifi send an MFA code to a real phone.
 * Nothing on a non-interactive stdio process can answer one, and the background
 * sync runs on a timer — so a credential fallback anywhere the server can reach
 * is a loop that sends texts until the account locks. These assertions are the
 * structural guarantee that it cannot happen, in the same spirit as the
 * read-only tool boundary.
 */

const SYNTHETIC_SIMPLIFI_CONFIG: AppConfig["simplifi"] = {
  baseUrl: "https://simplifi.synthetic.invalid",
  email: "operator@synthetic.invalid",
  password: "test-password",
  datasetId: "synthetic-dataset",
  clientId: "test-client",
  clientSecret: "test-client-secret",
  redirectUri: "https://simplifi.synthetic.invalid/login",
  httpTimeoutMs: 1_000,
  syncIntervalMs: 60_000,
  maxStaleMs: 60_000,
  pageLimit: 100,
};

const EXPIRED = "2000-01-01T00:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

const originalFetch = globalThis.fetch;

/** Records every upstream URL touched, and rejects all refresh attempts. */
function stubFetchRejectingRefresh(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  }) as typeof globalThis.fetch;
  return urls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("Given an MCP server process with no stored Simplifi tokens", () => {
  test("When something needs an access token, then it fails naming the auth command without contacting Simplifi", async () => {
    const db = new DatabaseContext(":memory:");
    const urls = stubFetchRejectingRefresh();

    try {
      const auth = new SimplifiAuthService(SYNTHETIC_SIMPLIFI_CONFIG, db);

      await expect(auth.getAccessToken()).rejects.toThrow(/npm run auth/);
      expect(urls).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("Given an MCP server process whose refresh token Simplifi rejects", () => {
  test("When it tries to authenticate, then it never posts the password to the authorize endpoint", async () => {
    const db = new DatabaseContext(":memory:");
    const urls = stubFetchRejectingRefresh();

    try {
      db.saveSimplifiTokens({
        accessToken: "test-stale-access-token",
        accessTokenExpiresAt: EXPIRED,
        refreshToken: "test-revoked-refresh-token",
      });

      const auth = new SimplifiAuthService(SYNTHETIC_SIMPLIFI_CONFIG, db);
      await expect(auth.getAccessToken()).rejects.toThrow();

      expect(urls.some((url) => url.includes("/oauth/authorize"))).toBe(false);
      expect(urls).toEqual(["https://simplifi.synthetic.invalid/oauth/token"]);
    } finally {
      db.close();
    }
  });

  test("When the refresh token has not passed its expiry, then it reports the token as revoked rather than expired", async () => {
    const db = new DatabaseContext(":memory:");
    stubFetchRejectingRefresh();

    try {
      db.saveSimplifiTokens({
        accessToken: "test-stale-access-token",
        accessTokenExpiresAt: EXPIRED,
        refreshToken: "test-revoked-refresh-token",
        refreshTokenExpiresAt: FAR_FUTURE,
      });

      const auth = new SimplifiAuthService(SYNTHETIC_SIMPLIFI_CONFIG, db);
      await expect(auth.getAccessToken()).rejects.toThrow(/revoked/i);
    } finally {
      db.close();
    }
  });

  test("When the refresh token is past its expiry, then it reports the token as expired rather than revoked", async () => {
    const db = new DatabaseContext(":memory:");
    stubFetchRejectingRefresh();

    try {
      db.saveSimplifiTokens({
        accessToken: "test-stale-access-token",
        accessTokenExpiresAt: EXPIRED,
        refreshToken: "test-long-dead-refresh-token",
        refreshTokenExpiresAt: EXPIRED,
      });

      const auth = new SimplifiAuthService(SYNTHETIC_SIMPLIFI_CONFIG, db);
      await expect(auth.getAccessToken()).rejects.toThrow(/expired/i);
    } finally {
      db.close();
    }
  });

  test("When many token requests follow the first failure, then Simplifi is contacted exactly once", async () => {
    const db = new DatabaseContext(":memory:");
    const urls = stubFetchRejectingRefresh();

    try {
      db.saveSimplifiTokens({
        accessToken: "test-stale-access-token",
        accessTokenExpiresAt: EXPIRED,
        refreshToken: "test-revoked-refresh-token",
      });

      const auth = new SimplifiAuthService(SYNTHETIC_SIMPLIFI_CONFIG, db);
      for (let attempt = 0; attempt < 25; attempt += 1) {
        await expect(auth.getAccessToken()).rejects.toThrow(/npm run auth/);
      }

      expect(urls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("When the operator completes a login and stores a new token, then the next request tries Simplifi again", async () => {
    const db = new DatabaseContext(":memory:");
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          accessToken: "test-fresh-access-token",
          refreshToken: "test-fresh-refresh-token",
          accessTokenExpired: FAR_FUTURE,
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    try {
      db.saveSimplifiTokens({
        accessToken: "test-stale-access-token",
        accessTokenExpiresAt: EXPIRED,
        refreshToken: "test-revoked-refresh-token",
      });

      const auth = new SimplifiAuthService(SYNTHETIC_SIMPLIFI_CONFIG, db);
      await expect(auth.getAccessToken()).rejects.toThrow();
      await expect(auth.getAccessToken()).rejects.toThrow();
      expect(urls).toHaveLength(1);

      // What `npm run auth` does, from the operator's separate process.
      db.saveSimplifiTokens({
        accessToken: "test-operator-access-token",
        accessTokenExpiresAt: EXPIRED,
        refreshToken: "test-operator-refresh-token",
      });

      await expect(auth.getAccessToken()).resolves.toBe("test-fresh-access-token");
      expect(urls).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

describe("Given a running server whose background sync cannot authenticate", () => {
  test("When the sync interval fires many times, then upstream auth attempts do not grow with uptime", async () => {
    vi.useFakeTimers();
    const db = new DatabaseContext(":memory:");
    const urls = stubFetchRejectingRefresh();

    try {
      db.saveSimplifiTokens({
        accessToken: "test-stale-access-token",
        accessTokenExpiresAt: EXPIRED,
        refreshToken: "test-revoked-refresh-token",
      });

      const auth = new SimplifiAuthService(SYNTHETIC_SIMPLIFI_CONFIG, db);
      const sync = new SyncService(
        SYNTHETIC_SIMPLIFI_CONFIG,
        db,
        new SimplifiClient(SYNTHETIC_SIMPLIFI_CONFIG, auth),
      );

      sync.start();
      // Eight hours of unattended uptime at the default 60s interval.
      for (let tick = 0; tick < 480; tick += 1) {
        await vi.advanceTimersByTimeAsync(SYNTHETIC_SIMPLIFI_CONFIG.syncIntervalMs);
      }
      sync.stop();

      expect(urls).toHaveLength(1);
      expect(urls.some((url) => url.includes("/oauth/authorize"))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("When the same failure repeats on every tick, then it is reported once rather than once per tick", async () => {
    vi.useFakeTimers();
    const db = new DatabaseContext(":memory:");
    stubFetchRejectingRefresh();
    // logError goes through console.error, which vitest replaces; spying on
    // process.stderr.write would miss it entirely and pass vacuously.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      db.saveSimplifiTokens({
        accessToken: "test-stale-access-token",
        accessTokenExpiresAt: EXPIRED,
        refreshToken: "test-revoked-refresh-token",
      });

      const auth = new SimplifiAuthService(SYNTHETIC_SIMPLIFI_CONFIG, db);
      const sync = new SyncService(
        SYNTHETIC_SIMPLIFI_CONFIG,
        db,
        new SimplifiClient(SYNTHETIC_SIMPLIFI_CONFIG, auth),
      );

      sync.start();
      for (let tick = 0; tick < 60; tick += 1) {
        await vi.advanceTimersByTimeAsync(SYNTHETIC_SIMPLIFI_CONFIG.syncIntervalMs);
      }
      sync.stop();

      const failureLines = consoleError.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("Background incremental sync failed"));

      expect(failureLines).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      db.close();
    }
  });
});
