import { afterEach, beforeEach } from "vitest";

/**
 * The sealed test environment.
 *
 * Two rules this file enforces for every test, because both failure modes are
 * silent and expensive:
 *
 *   1. No network. A test that reaches services.quicken.com is a test that
 *      passes or fails based on Quicken's mood, our token state, and the
 *      network — not on our code. It also means the suite cannot run in CI.
 *   2. No credentials. A test that reads SIMPLIFI_PASSWORD from the developer's
 *      real .env is a test that behaves differently on every machine, and one
 *      accidental console.log away from putting a password in CI output.
 *
 * **The seal is applied at module scope, not only in `beforeEach`.** That ordering
 * is the whole point: vitest evaluates setup files before it imports the test
 * file, and a test file's imports run before any hook. So source with top-level
 * side effects — `src/config.ts` calls `dotenv.config()` at line 4 — would
 * otherwise read real credentials, or call real `fetch`, during import, while
 * every `beforeEach` assertion still passed afterwards.
 *
 * Three layers, because each closes a gap the others cannot:
 *   - module scope here: seals before any test module is imported
 *   - the dotenv alias in vitest.config.ts: stops `.env` being read at all
 *   - `beforeEach`: undoes whatever the previous test installed
 *
 * A test that genuinely needs to exercise HTTP behavior injects its own fake —
 * see `installFakeFetch`. That is deliberate friction: reaching for the network
 * should be a decision, not an accident.
 */

const SEALED_ENV_PREFIXES = ["SIMPLIFI_", "OAUTH_"] as const;

const forbiddenFetch: typeof globalThis.fetch = async (input) => {
  const target = typeof input === "string" ? input : String(input);
  throw new Error(
    `Network access is forbidden in tests. Something tried to fetch ${target}. ` +
      `If this test needs HTTP, install a fake with installFakeFetch() from tests/support/setup.ts.`,
  );
};

function clearSealedEnv(): string[] {
  const cleared: string[] = [];

  for (const key of Object.keys(process.env)) {
    if (SEALED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
      cleared.push(key);
    }
  }

  return cleared;
}

function seal(): void {
  globalThis.fetch = forbiddenFetch;
  clearSealedEnv();
}

// Applied at module scope: before any test file is imported. This is the layer
// that makes import-time access safe, and tests/support/import-time-probe.ts
// exists to prove it stays that way.
seal();

// Derived from fetch itself rather than written as RequestInfo/RequestInit:
// which of those names are in scope depends on the lib and @types/node version,
// and this cannot drift.
type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

/**
 * Replace global fetch for the duration of one test. Returns the calls made, so
 * a test can assert on the request it would have issued — which is how the
 * read-only boundary gets tested without talking to Quicken.
 */
export function installFakeFetch(handler: typeof globalThis.fetch): Array<{ url: string; init?: FetchInit }> {
  const calls: Array<{ url: string; init?: FetchInit }> = [];
  globalThis.fetch = async (input: FetchInput, init?: FetchInit) => {
    calls.push({ url: typeof input === "string" ? input : String(input), init });
    return handler(input, init);
  };
  return calls;
}

beforeEach(() => {
  seal();
});

afterEach(() => {
  globalThis.fetch = forbiddenFetch;
});

export { SEALED_ENV_PREFIXES, clearSealedEnv, forbiddenFetch };
