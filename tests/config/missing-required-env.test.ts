import { afterEach, describe, expect, test } from "vitest";

import { ConfigurationError, loadConfig } from "../../src/config.js";

/**
 * First-run setup is the one path every external user walks and the maintainer
 * never does, because a configured `.env` sits on the maintainer's disk. These
 * assert what someone sees before that file exists.
 *
 * The failure being guarded is round trips: reporting one missing variable at a
 * time turns setup into run, read, fix, repeat, once per variable — and the
 * variable that takes real effort to find is the one reached last.
 */

const REQUIRED_ENV = {
  SIMPLIFI_EMAIL: "operator@synthetic.invalid",
  SIMPLIFI_PASSWORD: "test-password",
  SIMPLIFI_DATASET_ID: "synthetic-dataset",
} as const;

const TOUCHED = Object.keys(REQUIRED_ENV);

afterEach(() => {
  // The suite asserts elsewhere that no SIMPLIFI_ variable is visible; leaving
  // one behind would fail that test depending on file order.
  for (const key of TOUCHED) {
    delete process.env[key];
  }
});

function withEnvExcept(...omit: string[]): void {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    if (omit.includes(key)) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("Given no Simplifi configuration at all", () => {
  test("When I load config, then every missing variable is named in one message", () => {
    withEnvExcept(...TOUCHED);

    expect(() => loadConfig()).toThrow(ConfigurationError);

    let message = "";
    try {
      loadConfig();
    } catch (error) {
      message = (error as Error).message;
    }

    // All three at once: the point is that a user is not sent around the loop
    // three times to discover them one by one.
    for (const key of TOUCHED) {
      expect(message).toContain(key);
    }
  });

  test("When I load config, then the message says where to put the values", () => {
    withEnvExcept(...TOUCHED);

    expect(() => loadConfig()).toThrow(/Copy \.env\.example to \.env/);
  });
});

describe("Given only the dataset id is missing", () => {
  test("When I load config, then it explains where to find that value", () => {
    withEnvExcept("SIMPLIFI_DATASET_ID");

    // This one cannot be guessed or read out of the Simplifi UI, so a bare
    // "missing" is not actionable the way it is for email and password.
    expect(() => loadConfig()).toThrow(/qcs-dataset-id/);
  });

  test("When I load config, then the variables I did set are not reported missing", () => {
    withEnvExcept("SIMPLIFI_DATASET_ID");

    let message = "";
    try {
      loadConfig();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("SIMPLIFI_DATASET_ID");
    expect(message).not.toContain("SIMPLIFI_EMAIL");
    expect(message).not.toContain("SIMPLIFI_PASSWORD");
  });
});

describe("Given a required variable is present but blank", () => {
  test("When I load config, then it is treated as missing", () => {
    withEnvExcept();
    // `.env` spells unset as `KEY=`, which arrives as an empty string.
    process.env.SIMPLIFI_PASSWORD = "   ";

    expect(() => loadConfig()).toThrow(/SIMPLIFI_PASSWORD/);
  });
});

describe("Given a configuration error", () => {
  test("When it is raised, then it is a ConfigurationError rather than a bare Error", () => {
    withEnvExcept(...TOUCHED);

    // The entrypoint branches on this type to print the message without a
    // stack trace; a plain Error would silently fall through to the crash path.
    try {
      loadConfig();
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).name).toBe("ConfigurationError");
    }
  });
});
