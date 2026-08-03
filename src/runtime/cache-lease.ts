import fs from "node:fs";
import path from "node:path";

/**
 * Which role this process plays against the cache.
 *
 * `writer` owns the lease and is the only process that may sync. `reader` found
 * a live writer and serves queries from the cache without writing to it.
 */
export type CacheRole = "writer" | "reader";

/**
 * Owns the single-writer lease for a local SQLite cache.
 *
 * The lease serializes **syncing**, not reading. SQLite in WAL mode supports many
 * concurrent readers alongside one writer, so a second process losing the race
 * has no reason to refuse to start — it has every reason not to sync. Gating the
 * open instead of the write is what made two registered hosts a race that one of
 * them silently lost: the loser's tools were simply absent, which from inside
 * that host is indistinguishable from a broken install.
 *
 * The lease is deliberately adjacent to the cache so it shares its local
 * lifecycle and is never a repository artifact.
 */
export class CacheLease {
  private released = false;

  private constructor(
    private readonly lockPath: string,
    public readonly role: CacheRole,
    /** The live writer's pid, when this process is a reader. */
    public readonly writerPid?: number,
  ) {}

  /**
   * Takes the writer lease, or reports that another live process holds it.
   *
   * Never throws for contention. A caller that genuinely requires write access —
   * the auth command, which must store tokens — checks `role` and refuses on its
   * own terms, where it can say what it was trying to do.
   */
  public static acquire(dbPath: string): CacheLease {
    const lockPath = `${dbPath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    if (CacheLease.tryCreate(lockPath)) {
      return new CacheLease(lockPath, "writer");
    }

    // A lock file outlives the process that wrote it. Hosts kill their MCP
    // subprocess, machines sleep, and processes crash — none of which run the
    // release path. Without recovery the first ungraceful exit makes the server
    // permanently unstartable until someone deletes a file they do not know
    // about, so an unowned lock must be reclaimable rather than fatal.
    const holder = CacheLease.readHolder(lockPath);

    if (holder !== undefined && CacheLease.isRunning(holder.pid)) {
      return new CacheLease(lockPath, "reader", holder.pid);
    }

    fs.rmSync(lockPath, { force: true });

    if (!CacheLease.tryCreate(lockPath)) {
      // Another process won the same race and is genuinely live. Read its pid
      // rather than reporting none: the race is with a real writer, so the
      // outcome is the reader role, the same as losing it a moment earlier.
      return new CacheLease(lockPath, "reader", CacheLease.readHolder(lockPath)?.pid);
    }

    return new CacheLease(lockPath, "writer");
  }

  /** Creates the lock exclusively. False means it already existed. */
  private static tryCreate(lockPath: string): boolean {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  }

  /** Undefined when the lock is missing, unreadable, or not the shape we write. */
  private static readHolder(lockPath: string): { pid: number } | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
      // `process.pid` is always a positive safe integer. In particular, PID 0
      // is a process-group signal target on Unix rather than an owner process;
      // treating it as live would leave a corrupt lock unrecoverable forever.
      return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
        ? { pid: parsed.pid }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private static isRunning(pid: number): boolean {
    // Deliberately no special case for our own pid: the auth command and the
    // stdio server both take this lease, and within one process a held lease is
    // held. Treating our own pid as stale would let a second acquire steal it.
    try {
      // Signal 0 performs the permission and existence check without delivering.
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means it exists and belongs to another user, which still counts.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  public release(): void {
    if (this.released) {
      return;
    }

    this.released = true;

    // A reader never created the lock and must never remove it. Deleting it here
    // would free the live writer's lease on the reader's shutdown, and the next
    // process to start would take the writer role while the real writer is still
    // syncing — two writers, which is the one thing the lease exists to prevent.
    if (this.role === "reader") {
      return;
    }

    try {
      fs.unlinkSync(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
