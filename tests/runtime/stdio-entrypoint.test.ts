import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import BetterSqlite3 from "better-sqlite3";
import { beforeAll, describe, expect, test } from "vitest";

import { DatabaseContext } from "../../src/db/database.js";
import { CacheLease } from "../../src/runtime/cache-lease.js";
import { TESTS_ROOT } from "../support/test-sources.js";

const REPO_ROOT = path.resolve(TESTS_ROOT, "..");
const ENTRYPOINT = path.join(REPO_ROOT, "dist", "index.js");

beforeAll(() => {
  execFileSync(process.execPath, [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc")], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
});

function syntheticEnvironment(cachePath: string): Record<string, string> {
  return {
    CACHE_DB_PATH: cachePath,
    SIMPLIFI_EMAIL: "operator@synthetic.invalid",
    SIMPLIFI_PASSWORD: "synthetic-password-for-stdio-test",
    SIMPLIFI_DATASET_ID: "synthetic-dataset-id",
    SIMPLIFI_SYNC_INTERVAL_MS: "3600000",
    PATH: process.env.PATH ?? "",
  };
}

function transportFor(cachePath: string): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [ENTRYPOINT],
    // Never let this spawned test read an operator's local .env. The built
    // executable gets only the synthetic environment above.
    cwd: path.dirname(cachePath),
    env: syntheticEnvironment(cachePath),
    stderr: "pipe",
  });
}

async function listToolNames(cachePath: string): Promise<string[]> {
  const transport = transportFor(cachePath);
  const client = new Client({ name: "stdio-entrypoint-test", version: "0.0.0" });

  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

function textFromRepo(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("Given the built household-finance-mcp subprocess", () => {
  test("When a host connects over stdio, then it completes an MCP handshake and lists the read-only tools", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hfm-stdio-"));
    const cachePath = path.join(directory, "cache.sqlite");

    try {
      const tools = await listToolNames(cachePath);

      expect(tools).toContain("list_transactions");
      expect(tools).not.toContain("update_transaction");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("When two embedders spawn it sequentially against one cache, then they see the identical tool set", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hfm-stdio-"));
    const cachePath = path.join(directory, "cache.sqlite");

    try {
      const first = await listToolNames(cachePath);
      const second = await listToolNames(cachePath);

      expect(second).toEqual(first);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("When the host closes stdio, then the cache lease is released with no lock file left behind", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hfm-stdio-"));
    const cachePath = path.join(directory, "cache.sqlite");
    const lockPath = `${cachePath}.lock`;

    try {
      await listToolNames(cachePath);

      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("When a second host starts against an active cache, then it serves the same tools read-only", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hfm-stdio-"));
    const cachePath = path.join(directory, "cache.sqlite");
    const firstTransport = transportFor(cachePath);
    const firstClient = new Client({ name: "first-host", version: "0.0.0" });
    const secondTransport = transportFor(cachePath);
    const secondClient = new Client({ name: "second-host", version: "0.0.0" });
    let stderr = "";

    secondTransport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      await firstClient.connect(firstTransport);
      // The writer creates the cache on start; only then can a reader open it.
      await firstClient.listTools();

      // The whole point: the second host connects rather than dying. A host whose
      // tools are simply absent is indistinguishable from a broken install.
      await secondClient.connect(secondTransport);
      const tools = await secondClient.listTools();

      expect(tools.tools.length).toBeGreaterThan(0);
      expect(stderr).toMatch(/"role":\s*"reader"/);
      expect(stderr).toMatch(new RegExp(`"writerPid":\\s*\\d+`));
    } finally {
      await secondClient.close();
      await firstClient.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Given a local cache lease", () => {
  test("When a second server claims an already leased cache, then it becomes a reader rather than a second writer", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hfm-stdio-"));
    const cachePath = path.join(directory, "cache.sqlite");
    const first = CacheLease.acquire(cachePath);

    try {
      const second = CacheLease.acquire(cachePath);

      expect(first.role).toBe("writer");
      expect(second.role).toBe("reader");
    } finally {
      first.release();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Given the stdio entrypoint source", () => {
  test("When I inspect its transport and configuration, then it contains no HTTP listener, CORS, JWT, or redirect allowlist", () => {
    const source = [
      textFromRepo("src/index.ts"),
      textFromRepo("src/config.ts"),
      textFromRepo("src/runtime/stdio-server.ts"),
      textFromRepo("package.json"),
      textFromRepo(".env.example"),
    ].join("\n");

    expect(source).not.toMatch(/startHttpServer|\.listen\(|express|cors|jsonwebtoken/i);
    expect(source).not.toMatch(/OAUTH_(ISSUER|AUDIENCE|JWT_SECRET|ALLOWED_REDIRECT_URIS)/);
  });

  test("When I inspect the migrated database, then server-owned OAuth tables no longer exist", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hfm-stdio-"));
    const cachePath = path.join(directory, "cache.sqlite");

    try {
      const oldDatabase = new BetterSqlite3(cachePath);
      oldDatabase.exec("CREATE TABLE oauth_authorization_codes (id TEXT); CREATE TABLE oauth_refresh_tokens (id TEXT);");
      oldDatabase.close();

      const database = new DatabaseContext(cachePath);
      const tables = database.describeSchema().tables;
      database.close();

      const source = textFromRepo("src/db/database.ts");
      expect(tables).not.toContain("oauth_authorization_codes");
      expect(tables).not.toContain("oauth_refresh_tokens");
      expect(source).not.toMatch(/CREATE TABLE IF NOT EXISTS oauth_/);
      expect(source).toMatch(/DROP TABLE IF EXISTS oauth_authorization_codes/);
      expect(source).toMatch(/DROP TABLE IF EXISTS oauth_refresh_tokens/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
