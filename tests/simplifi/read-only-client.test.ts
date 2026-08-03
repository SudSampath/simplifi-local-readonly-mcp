import { describe, expect, test } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { SimplifiClient } from "../../src/simplifi/client.js";
import type { SimplifiAuthService } from "../../src/simplifi/auth-service.js";
import { installFakeFetch } from "../support/setup.js";

/**
 * Asserts the read-only boundary at the network edge rather than at the tool
 * edge. Removing the write tools is necessary but not sufficient: as long as the
 * client can issue a PUT, some future code path can reach it.
 *
 * So every method on the client is actually invoked against a fake fetch, and the
 * (method, path) pairs it produces are compared to an allowlist. A newly added
 * request fails this test until it is deliberately allowed, which is the review
 * checkpoint. That is stronger than grepping for "PUT" — it survives the string
 * being built dynamically.
 */

const SIMPLIFI_CONFIG: AppConfig["simplifi"] = {
  baseUrl: "https://services.quicken.com",
  email: "nobody@example.invalid",
  password: "placeholder",
  datasetId: "dataset-synthetic",
  clientId: "acme_web",
  clientSecret: "placeholder",
  redirectUri: "https://simplifi.quicken.com/login",
  httpTimeoutMs: 1_000,
  syncIntervalMs: 60_000,
  maxStaleMs: 120_000,
  pageLimit: 10,
} as AppConfig["simplifi"];

const FAKE_AUTH = {
  getAccessToken: async () => "synthetic-access-token",
} as unknown as SimplifiAuthService;

/**
 * Every request this client is permitted to make. GET everywhere except one:
 * POST /transactions/earliest-date-on is a read that Quicken happens to expose
 * as a POST — it is how sync discovers where our history starts. Dropping it
 * would cost the ability to bound a full sync, so it is allowed by name rather
 * than by relaxing the rule to "any POST is fine".
 */
const ALLOWED_REQUESTS = [
  { method: "GET", path: "/transactions" },
  { method: "GET", path: "/categories" },
  { method: "GET", path: "/tags" },
  { method: "GET", path: "/accounts" },
  { method: "GET", path: "/scheduled-transactions" },
  { method: "POST", path: "/transactions/earliest-date-on" },
] as const;

const FORBIDDEN_METHODS = ["PUT", "PATCH", "DELETE"];

/**
 * How to exercise each public method, keyed by name.
 *
 * A map rather than a straight-line list, because the assertion below compares
 * its keys against the client's actual prototype. Previously this was a sequence
 * of calls and the surrounding comment claimed every method was invoked — which
 * stopped being true the moment a method was added without a matching line, and
 * nothing failed. A new endpoint could then reach the network without ever being
 * checked against the allowlist, which is the one thing this file exists to
 * prevent.
 */
const INVOCATIONS: Record<string, (client: SimplifiClient) => Promise<unknown>> = {
  listTransactions: (client) => client.listTransactions({ limit: 1 }),
  listTransactionsFromNextLink: (client) => client.listTransactionsFromNextLink("/transactions?after=synthetic-cursor"),
  getEarliestDateOn: (client) => client.getEarliestDateOn(["acct-teal"]),
  listCategories: (client) => client.listCategories({}),
  listCategoriesFromNextLink: (client) => client.listCategoriesFromNextLink("/categories?after=synthetic-cursor"),
  listTags: (client) => client.listTags({}),
  listTagsFromNextLink: (client) => client.listTagsFromNextLink("/tags?after=synthetic-cursor"),
  listAccounts: (client) => client.listAccounts({}),
  listAccountsFromNextLink: (client) => client.listAccountsFromNextLink("/accounts?after=synthetic-cursor"),
  listScheduledTransactions: (client) => client.listScheduledTransactions({}),
  listScheduledTransactionsFromNextLink: (client) =>
    client.listScheduledTransactionsFromNextLink("/scheduled-transactions?after=synthetic-cursor"),
};

function publicMethodNames(): string[] {
  return Object.getOwnPropertyNames(SimplifiClient.prototype)
    .filter((name) => name !== "constructor" && !name.startsWith("authed"))
    .sort();
}

/** Invoke every public method on the client, recording what each would send. */
async function recordAllRequests(): Promise<Array<{ method: string; path: string }>> {
  const calls = installFakeFetch(async () => new Response(JSON.stringify({ metaData: {}, resources: [] }), { status: 200 }));

  const client = new SimplifiClient(SIMPLIFI_CONFIG, FAKE_AUTH);

  for (const invoke of Object.values(INVOCATIONS)) {
    await invoke(client);
  }

  return calls.map((call) => ({
    method: (call.init?.method ?? "GET").toUpperCase(),
    path: new URL(call.url).pathname,
  }));
}

describe("Given every request the Simplifi client can issue", () => {
  test("When I compare the invocation map to the client, then every public method is exercised", async () => {
    // The assertion that makes every other one in this file mean something. A
    // method absent from INVOCATIONS is a method whose requests are never
    // recorded, so it would pass the allowlist check by never being seen.
    expect(Object.keys(INVOCATIONS).sort(), "add new client methods to INVOCATIONS").toEqual(publicMethodNames());
  });

  test("When I invoke every method, then each request appears in the allowlist", async () => {
    const requests = await recordAllRequests();

    const disallowed = requests.filter(
      (request) =>
        !ALLOWED_REQUESTS.some((allowed) => allowed.method === request.method && allowed.path === request.path),
    );

    expect(disallowed, "a new request must be added to ALLOWED_REQUESTS deliberately").toEqual([]);
  });

  test("When I invoke every method, then none issues PUT, PATCH, or DELETE", async () => {
    const requests = await recordAllRequests();

    const mutating = requests.filter((request) => FORBIDDEN_METHODS.includes(request.method));

    expect(mutating, "no mutating request may reach services.quicken.com").toEqual([]);
  });

  test("When I count the non-GET requests, then earliest-date-on is the only one", async () => {
    const requests = await recordAllRequests();

    const nonGet = requests.filter((request) => request.method !== "GET");

    expect(nonGet).toEqual([{ method: "POST", path: "/transactions/earliest-date-on" }]);
  });

  test("When I invoke every method, then requests were actually recorded", async () => {
    // Guards against a change that makes the client stop calling fetch and every
    // assertion above pass by observing nothing.
    expect((await recordAllRequests()).length).toBe(Object.keys(INVOCATIONS).length);
  });
});

describe("Given the client's public surface", () => {
  const methodNames = Object.getOwnPropertyNames(SimplifiClient.prototype).filter(
    (name) => name !== "constructor" && !name.startsWith("authed"),
  );

  test("When I look for the removed update method, then it does not exist", () => {
    expect(methodNames).not.toContain("updateTransaction");
  });

  test("When I inspect the method names, then none describes a mutation", () => {
    const offenders = methodNames.filter((name) => /^(update|create|delete|put|patch|set|post|modify|remove)/i.test(name));

    expect(offenders).toEqual([]);
  });
});
