/**
 * Records what the environment looked like **at module import time** — before any
 * `beforeEach` could have run.
 *
 * This exists so the seal in setup.ts is verified at the moment that actually
 * matters. A test asserting `process.env.SIMPLIFI_PASSWORD === undefined` inside a
 * test body proves only that the hook works; it says nothing about whether source
 * code with top-level side effects could have read a real credential, or reached
 * the network, while it was being imported.
 *
 * Anything recorded here is captured once, when the module is first imported.
 */

const SEALED_PREFIXES = ["SIMPLIFI_", "OAUTH_"];

/** Sealed-prefix variables visible at import time. Should always be empty. */
export const sealedEnvKeysAtImport: string[] = Object.keys(process.env).filter((key) =>
  SEALED_PREFIXES.some((prefix) => key.startsWith(prefix)),
);

/** Whether calling fetch at import time was refused. Should always be true. */
export const fetchWasForbiddenAtImport: boolean = await (async () => {
  try {
    await fetch("https://services.quicken.com/transactions");
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes("Network access is forbidden");
  }
})();
