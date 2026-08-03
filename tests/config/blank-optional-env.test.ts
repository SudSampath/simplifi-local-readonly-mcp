import { afterEach, describe, expect, test } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { loadConfig } from "../../src/config.js";
import { DatabaseContext } from "../../src/db/database.js";
import { SimplifiAuthService } from "../../src/simplifi/auth-service.js";
import { installFakeFetch } from "../support/setup.js";

/**
 * A `.env` spells "unset" as `KEY=`, which arrives as an empty string rather
 * than undefined. Every `??` fallback downstream then fails to fire and the
 * blank is sent upstream as though it were a real value — Simplifi answers the
 * authorize call with "Parameter threatMetrixSessionId must be specified",
 * which reads like a missing parameter rather than a blank one. The shipped
 * .env.example sets exactly this variable to blank, so it is the default path.
 */

const REQUIRED_ENV = {
  SIMPLIFI_EMAIL: "operator@synthetic.invalid",
  SIMPLIFI_PASSWORD: "test-password",
  SIMPLIFI_DATASET_ID: "synthetic-dataset",
} as const;

const TOUCHED = [
  ...Object.keys(REQUIRED_ENV),
  "SIMPLIFI_THREAT_METRIX_SESSION_ID",
  "SIMPLIFI_THREAT_METRIX_REQUEST_ID",
];

afterEach(() => {
  // The suite asserts elsewhere that no SIMPLIFI_ variable is visible; leaving
  // one behind would fail that test depending on file order.
  for (const key of TOUCHED) {
    delete process.env[key];
  }
});

function withBlankOptionals(): void {
  Object.assign(process.env, REQUIRED_ENV);
  process.env.SIMPLIFI_THREAT_METRIX_SESSION_ID = "";
  process.env.SIMPLIFI_THREAT_METRIX_REQUEST_ID = "   ";
}

describe("Given a .env that spells an unset optional variable as an empty assignment", () => {
  test("When the configuration is loaded, then the blank reads as absent rather than as an empty value", () => {
    withBlankOptionals();

    const config = loadConfig();

    expect(config.simplifi.threatMetrixSessionId).toBeUndefined();
    expect(config.simplifi.threatMetrixRequestId).toBeUndefined();
  });

  test("When a required variable is blank, then loading still fails loudly rather than passing an empty string on", () => {
    Object.assign(process.env, REQUIRED_ENV);
    process.env.SIMPLIFI_DATASET_ID = "   ";

    expect(() => loadConfig()).toThrow(/SIMPLIFI_DATASET_ID/);
  });
});

describe("Given a Simplifi configuration carrying no ThreatMetrix session id", () => {
  test("When the operator login calls authorize, then a generated session id is sent rather than a blank one", async () => {
    const db = new DatabaseContext(":memory:");
    const calls = installFakeFetch(
      async () => new Response(JSON.stringify({ mfaId: "synthetic-mfa-id", mfaChannel: "SMS" }), { status: 202 }),
    );

    const config: AppConfig["simplifi"] = {
      baseUrl: "https://simplifi.synthetic.invalid",
      email: "operator@synthetic.invalid",
      password: "test-password",
      datasetId: "synthetic-dataset",
      clientId: "test-client",
      clientSecret: "test-client-secret",
      redirectUri: "https://simplifi.synthetic.invalid/login",
      threatMetrixSessionId: undefined,
      httpTimeoutMs: 1_000,
      syncIntervalMs: 60_000,
      maxStaleMs: 60_000,
      pageLimit: 100,
    };

    try {
      const result = await new SimplifiAuthService(config, db).attemptLogin();
      expect(result.status).toBe("mfa_required");

      const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
      expect(body.threatMetrixSessionId).toEqual(expect.any(String));
      expect(String(body.threatMetrixSessionId).trim()).not.toBe("");

      // The header form carries it too; a blank there fails the same way.
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("tm-session-id")?.trim()).not.toBe("");
    } finally {
      db.close();
    }
  });
});
