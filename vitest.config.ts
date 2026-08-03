import path from "node:path";

import { defineConfig } from "vitest/config";

// Tests live in tests/, mirroring src/. They are deliberately NOT co-located:
// tsconfig compiles src/ -> dist/ with rootDir "src", so co-located tests would
// either land in the published build or need an exclude rule that drifts.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Every test file gets the sealed environment: no network, no credentials.
    // setup.ts seals at module scope, which is before test files are imported.
    // See tests/support/setup.ts for why that ordering matters.
    setupFiles: ["tests/support/setup.ts"],
    // src/config.ts calls dotenv.config() at module scope, so importing it from a
    // test would load the operator's real .env before any hook could clear it.
    // Aliasing dotenv away removes the ability rather than racing it. Verified by
    // tests/conventions/sealed-environment.test.ts.
    alias: {
      dotenv: path.resolve(import.meta.dirname, "tests/support/dotenv-stub.ts"),
    },
    // A test that hangs is a test that is trying to reach something real.
    testTimeout: 5_000,
    hookTimeout: 5_000,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      // Reported, not gated. A coverage threshold now would be a number picked
      // from nothing — the rule that carries the weight in this project is that
      // every acceptance criterion maps to an assertion, which no percentage
      // measures. This is here to answer "is that file exercised at all", which
      // becomes a real question as the correctness tickets land.
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
