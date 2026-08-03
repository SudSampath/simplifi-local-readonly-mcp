import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { CacheLease } from "../../src/runtime/cache-lease.js";

/**
 * A lock file outlives the process that wrote it. Hosts kill their MCP
 * subprocess rather than closing it, machines sleep, processes crash — none of
 * those run the release path. If an unowned lock were fatal, the first
 * ungraceful exit would make the server permanently unstartable until someone
 * deleted a file they have no reason to know exists.
 */

const directories: string[] = [];

function scratchDbPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cache-lease-"));
  directories.push(directory);
  return path.join(directory, "cache.sqlite");
}

/** A pid that cannot be running: allocated, then reaped by the OS. */
const DEAD_PID = 0x7ffffffe;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Given a lock file left behind by a process that no longer exists", () => {
  test("When the server starts, then it reclaims the lease rather than refusing to run", () => {
    const dbPath = scratchDbPath();
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: DEAD_PID, createdAt: "2020-01-01T00:00:00.000Z" }));

    const lease = CacheLease.acquire(dbPath);

    try {
      const holder = JSON.parse(readFileSync(`${dbPath}.lock`, "utf8")) as { pid: number };
      expect(holder.pid).toBe(process.pid);
    } finally {
      lease.release();
    }
  });

  test("When the lock file is corrupt rather than stale, then it is still reclaimed", () => {
    const dbPath = scratchDbPath();
    writeFileSync(`${dbPath}.lock`, "{ not json");

    const lease = CacheLease.acquire(dbPath);

    try {
      const holder = JSON.parse(readFileSync(`${dbPath}.lock`, "utf8")) as { pid: number };
      expect(holder.pid).toBe(process.pid);
    } finally {
      lease.release();
    }
  });

  test("When the lock file is empty, then it is still reclaimed", () => {
    const dbPath = scratchDbPath();
    writeFileSync(`${dbPath}.lock`, "");

    const lease = CacheLease.acquire(dbPath);
    lease.release();

    expect(() => CacheLease.acquire(dbPath).release()).not.toThrow();
  });

  test("When the lock contains a non-positive pid, then it is treated as corrupt and reclaimed", () => {
    const dbPath = scratchDbPath();
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: 0, createdAt: "2020-01-01T00:00:00.000Z" }));

    const lease = CacheLease.acquire(dbPath);

    try {
      const holder = JSON.parse(readFileSync(`${dbPath}.lock`, "utf8")) as { pid: number };
      expect(holder.pid).toBe(process.pid);
    } finally {
      lease.release();
    }
  });
});

describe("Given a lock file held by a process that is genuinely running", () => {
  test("When a second server starts, then it takes the reader role and names the writer", () => {
    const dbPath = scratchDbPath();
    // This test process is by definition alive, which is what makes it a valid
    // stand-in for another live host.
    const first = CacheLease.acquire(dbPath);

    try {
      const second = CacheLease.acquire(dbPath);

      expect(first.role).toBe("writer");
      expect(second.role).toBe("reader");
      expect(second.writerPid).toBe(process.pid);
    } finally {
      first.release();
    }
  });

  test("When a reader releases, then the live writer keeps its lease", () => {
    const dbPath = scratchDbPath();
    const writer = CacheLease.acquire(dbPath);
    const reader = CacheLease.acquire(dbPath);

    try {
      reader.release();

      // The reader never created the lock, so releasing it must not remove one.
      // Removing it would let the next process start as a second writer while
      // this one is still syncing.
      expect(existsSync(`${dbPath}.lock`)).toBe(true);
      expect(CacheLease.acquire(dbPath).role).toBe("reader");
    } finally {
      writer.release();
    }
  });

  test("When the holder releases, then the next start acquires cleanly as writer", () => {
    const dbPath = scratchDbPath();

    const first = CacheLease.acquire(dbPath);
    expect(CacheLease.acquire(dbPath).role).toBe("reader");
    first.release();

    const second = CacheLease.acquire(dbPath);
    expect(second.role).toBe("writer");
    expect(() => second.release()).not.toThrow();
  });

  test("When release runs twice, then the second is a no-op rather than an error", () => {
    const dbPath = scratchDbPath();
    const lease = CacheLease.acquire(dbPath);

    lease.release();

    expect(() => lease.release()).not.toThrow();
  });
});
