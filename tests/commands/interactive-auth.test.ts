import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runInteractiveAuth, type AuthTerminal, type InteractiveAuthService } from "../../src/commands/interactive-auth.js";
import { runLocalAuth } from "../../src/commands/local-auth.js";
import type { AppConfig } from "../../src/config.js";
import { DatabaseContext } from "../../src/db/database.js";
import { CacheLease } from "../../src/runtime/cache-lease.js";
import { SimplifiAuthService } from "../../src/simplifi/auth-service.js";

function fakeTerminal(code = "654321"): AuthTerminal & { output: string[]; prompts: string[] } {
  return {
    isInteractive: true,
    output: [],
    prompts: [],
    write(message) {
      this.output.push(message);
    },
    async prompt(message) {
      this.prompts.push(message);
      return code;
    },
  };
}

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

describe("Given an operator running the local auth command", () => {
  test("When the shared cache is leased by the MCP server, then it fails before attempting login", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "local-auth-lease-"));
    const dbPath = path.join(directory, "cache.sqlite");
    const lease = CacheLease.acquire(dbPath);

    try {
      // The server may serve a cache read-only when it loses the lease, but this
      // command exists to write a token. Running the login and discarding the
      // result at the last step would waste an MFA challenge.
      await expect(runLocalAuth({ cache: { dbPath }, simplifi: SYNTHETIC_SIMPLIFI_CONFIG }, fakeTerminal())).rejects.toThrow(
        /cannot sign in while another simplifi-local-readonly-mcp process holds the cache/i,
      );
      await expect(runLocalAuth({ cache: { dbPath }, simplifi: SYNTHETIC_SIMPLIFI_CONFIG }, fakeTerminal())).rejects.toThrow(
        new RegExp(String(process.pid)),
      );
    } finally {
      lease.release();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("When stdin offers no TTY, then it refuses before Simplifi is asked for a challenge", async () => {
    const terminal = { ...fakeTerminal(), isInteractive: false };
    let challengesRequested = 0;
    const service: InteractiveAuthService = {
      attemptLogin: async () => {
        challengesRequested += 1;
        return { status: "ok" };
      },
      completeMfaLogin: async () => {
        throw new Error("must not submit MFA");
      },
    };

    await expect(runInteractiveAuth(service, terminal)).rejects.toThrow(/needs a real terminal/i);
    // The assertion that matters: no authorize call, so no text message.
    expect(challengesRequested).toBe(0);
  });

  test("When Simplifi completes login without MFA, then it reports success without requesting a code", async () => {
    const terminal = fakeTerminal();
    const service: InteractiveAuthService = {
      attemptLogin: async () => ({ status: "ok" }),
      completeMfaLogin: async () => {
        throw new Error("must not submit MFA");
      },
    };

    await runInteractiveAuth(service, terminal);

    expect(terminal.prompts).toEqual([]);
    expect(terminal.output.join("")).toMatch(/tokens are ready/i);
  });

  test("When Simplifi returns an MFA challenge, then it names the channel and submits the entered code once", async () => {
    const terminal = fakeTerminal(" 654321 ");
    const submitted: Array<{ pendingId: string; code: string }> = [];
    const service: InteractiveAuthService = {
      attemptLogin: async () => ({
        status: "mfa_required",
        pendingId: "synthetic-pending-id",
        mfaChannel: "EMAIL",
        email: "operator@synthetic.invalid",
      }),
      completeMfaLogin: async (pendingId, code) => {
        submitted.push({ pendingId, code });
      },
    };

    await runInteractiveAuth(service, terminal);

    expect(terminal.output.join("")).toMatch(/EMAIL/);
    expect(terminal.prompts).toEqual(["Enter the MFA code: "]);
    expect(submitted).toEqual([{ pendingId: "synthetic-pending-id", code: "654321" }]);
    expect(terminal.output.join("")).not.toContain("654321");
  });

  test("When the operator submits no MFA code, then it fails without calling Simplifi again", async () => {
    const terminal = fakeTerminal("  ");
    let submitted = false;
    const service: InteractiveAuthService = {
      attemptLogin: async () => ({ status: "mfa_required", pendingId: "synthetic-pending-id", mfaChannel: "SMS" }),
      completeMfaLogin: async () => {
        submitted = true;
      },
    };

    await expect(runInteractiveAuth(service, terminal)).rejects.toThrow(/run npm run auth again/i);
    expect(submitted).toBe(false);
    expect(terminal.output.join("")).toMatch(/No MFA code entered/);
  });

  test("When the operator mistypes the code once, then it retries against the same challenge without a new one", async () => {
    const codes = ["111111", "654321"];
    const terminal = fakeTerminal();
    terminal.prompt = async (message) => {
      terminal.prompts.push(message);
      return codes[terminal.prompts.length - 1] ?? "";
    };

    let challengesIssued = 0;
    const submitted: string[] = [];
    const service: InteractiveAuthService = {
      attemptLogin: async () => {
        challengesIssued += 1;
        return { status: "mfa_required", pendingId: "synthetic-pending-id", mfaChannel: "SMS", phone: "***0000" };
      },
      completeMfaLogin: async (_pendingId, code) => {
        submitted.push(code);
        if (code !== "654321") {
          throw new Error("Simplifi MFA verification failed: status=401, body=invalid code");
        }
      },
    };

    await runInteractiveAuth(service, terminal);

    expect(submitted).toEqual(["111111", "654321"]);
    expect(challengesIssued).toBe(1);
    expect(terminal.output.join("")).toMatch(/rejected/i);
    expect(terminal.output.join("")).toMatch(/tokens are ready/i);
  });

  test("When every attempt is rejected, then it stops at the attempt limit and says the code is spent", async () => {
    const terminal = fakeTerminal("000000");
    const submitted: string[] = [];
    const service: InteractiveAuthService = {
      attemptLogin: async () => ({ status: "mfa_required", pendingId: "synthetic-pending-id", mfaChannel: "SMS" }),
      completeMfaLogin: async (_pendingId, code) => {
        submitted.push(code);
        throw new Error("Simplifi MFA verification failed: status=401, body=invalid code");
      },
    };

    await expect(runInteractiveAuth(service, terminal)).rejects.toThrow(/spent/i);
    expect(submitted).toHaveLength(3);
    expect(terminal.prompts).toHaveLength(3);
  });

  test("When the challenge has already expired, then it stops immediately instead of spending attempts", async () => {
    const terminal = fakeTerminal("654321");
    const submitted: string[] = [];
    const service: InteractiveAuthService = {
      attemptLogin: async () => ({ status: "mfa_required", pendingId: "synthetic-pending-id", mfaChannel: "SMS" }),
      completeMfaLogin: async (_pendingId, code) => {
        submitted.push(code);
        throw new Error("MFA session expired. Please restart the authorization flow.");
      },
    };

    await expect(runInteractiveAuth(service, terminal)).rejects.toThrow(/MFA session expired/);
    expect(submitted).toHaveLength(1);
  });

  test("When a code is rejected, then the rejected code is never echoed back to the terminal", async () => {
    const terminal = fakeTerminal("000000");
    const service: InteractiveAuthService = {
      attemptLogin: async () => ({ status: "mfa_required", pendingId: "synthetic-pending-id", mfaChannel: "SMS" }),
      completeMfaLogin: async () => {
        throw new Error("Simplifi MFA verification failed: status=401, body=invalid code");
      },
    };

    await expect(runInteractiveAuth(service, terminal)).rejects.toThrow();
    expect(terminal.output.join("")).not.toContain("000000");
  });

  test("When a simulated MFA challenge succeeds, then the auth command persists tokens and never writes the code", async () => {
    const db = new DatabaseContext(":memory:");
    const terminal = fakeTerminal("654321");
    const originalFetch = globalThis.fetch;
    const requestBodies: string[] = [];
    let request = 0;

    globalThis.fetch = async (_url, init) => {
      request += 1;
      requestBodies.push(String(init?.body ?? ""));

      if (request === 1) {
        return new Response(JSON.stringify({ mfaId: "synthetic-mfa-id", mfaChannel: "EMAIL" }), { status: 202 });
      }
      if (request === 2) {
        return new Response(null, { status: 200, headers: { location: "https://simplifi.synthetic.invalid/login?code=synthetic-code" } });
      }
      return new Response(JSON.stringify({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        accessTokenExpired: "2099-01-01T00:00:00.000Z",
      }), { status: 200 });
    };

    try {
      await runInteractiveAuth(new SimplifiAuthService(SYNTHETIC_SIMPLIFI_CONFIG, db), terminal);

      expect(db.getSimplifiTokens()).toMatchObject({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
      });
      expect(requestBodies[1]).toContain('"mfaCode":"654321"');
      expect(terminal.output.join("")).not.toContain("654321");
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });
});
