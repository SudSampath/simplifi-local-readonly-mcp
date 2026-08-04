import { afterEach, describe, expect, test, vi } from "vitest";

import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `.env` and the SQLite cache resolve against a home directory, not the
 * package directory.
 *
 * The distinction only bites once the package is installed rather than cloned:
 * `npx` and `npm i -g` place it under a directory npm manages and may prune, so
 * a cache written beside the code is silently discarded between runs, and there
 * is nowhere sensible to hand-place a `.env`. A clone must keep behaving
 * exactly as before, which is why the install case is detected rather than
 * assumed.
 *
 * `MCP_HOME` is computed once at module load, so each case resets the module
 * registry and re-imports.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGINAL_HOME = process.env.SIMPLIFI_MCP_HOME;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.SIMPLIFI_MCP_HOME;
  } else {
    process.env.SIMPLIFI_MCP_HOME = ORIGINAL_HOME;
  }
  vi.resetModules();
});

async function freshMcpHome(): Promise<string> {
  vi.resetModules();
  const { MCP_HOME } = await import("../../src/config.js");
  return MCP_HOME;
}

describe("Given SIMPLIFI_MCP_HOME is set", () => {
  test("When config loads, then that directory wins", async () => {
    const target = path.resolve(REPO_ROOT, "tmp-home-override");
    process.env.SIMPLIFI_MCP_HOME = target;

    await expect(freshMcpHome()).resolves.toBe(target);
  });

  test("When it is set to a relative path, then it is resolved to absolute", async () => {
    process.env.SIMPLIFI_MCP_HOME = "./relative-home";

    // A host spawns this server with a cwd of its own choosing, so a relative
    // home left unresolved would point somewhere different per host.
    expect(path.isAbsolute(await freshMcpHome())).toBe(true);
  });
});

describe("Given no override and a checked-out repository", () => {
  test("When config loads, then the home is the package root", async () => {
    delete process.env.SIMPLIFI_MCP_HOME;

    const home = await freshMcpHome();

    // The suite runs from a clone, so this is the install-detection negative
    // case: existing setups must not be relocated by this change.
    expect(home.split(path.sep)).not.toContain("node_modules");
    expect(home).toBe(REPO_ROOT);
  });
});
