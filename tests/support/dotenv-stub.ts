/**
 * Replaces the real `dotenv` for the whole test run, aliased in vitest.config.ts.
 *
 * Why this is structural rather than defensive: `src/config.ts:4` calls
 * `dotenv.config()` at module scope. Any test that imports it — directly or three
 * imports deep — would load the operator's real `.env` into `process.env` at
 * import time, which is before any `beforeEach` can clear it. Clearing variables
 * in a hook cannot fix that ordering; removing dotenv's ability to read the file
 * can.
 *
 * The effect: tests see whatever the sealed environment provides and nothing else,
 * on every machine, whether or not a real `.env` exists beside the repo.
 */

export interface DotenvStubResult {
  parsed: Record<string, string>;
}

function config(): DotenvStubResult {
  return { parsed: {} };
}

function parse(): Record<string, string> {
  return {};
}

export { config, parse };

export default { config, parse };
