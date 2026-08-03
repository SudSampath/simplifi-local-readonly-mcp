import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { logError } from "../logger.js";
import type { CacheRole } from "./cache-lease.js";

export type RefreshKind =
  | "transactions-full"
  | "transactions-incremental"
  | "accounts"
  | "scheduled-transactions"
  | "categories"
  | "tags";

type RefreshHandler = () => Promise<unknown>;

interface RefreshRequest {
  version: 1;
  id: string;
  kind: RefreshKind;
  requesterPid: number;
  createdAt: string;
}

interface RefreshResponse {
  version: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const POLL_MS = 25;
const REQUEST_TIMEOUT_MS = 55_000;

/**
 * Routes every cache-writing refresh through the one process holding the
 * long-lived writer lease.
 *
 * Each MCP host still owns a separate stdio subprocess. A reader therefore
 * cannot call the writer in memory, and opening its SQLite handle read-write
 * would weaken the boundary the lease exists to enforce. Requests use a tiny
 * local queue beside the cache instead: no account names, amounts, queries, or
 * credentials cross it, only one of the finite refresh kinds above.
 *
 * The writer claims files atomically and serializes all handlers through one
 * promise chain. SQLite readers keep serving the WAL while this happens. Two
 * readers can request the same refresh without either becoming a second writer.
 */
export class RefreshCoordinator {
  private readonly queuePath: string;
  private handlers: Partial<Record<RefreshKind, RefreshHandler>> = {};
  private pollHandle: NodeJS.Timeout | undefined;
  private polling = false;
  private localTail: Promise<void> = Promise.resolve();

  public constructor(
    dbPath: string,
    public readonly role: CacheRole,
    public readonly writerPid?: number,
  ) {
    this.queuePath = `${dbPath}.refresh`;
  }

  /** Whether this process can satisfy explicit refreshes locally or by delegation. */
  public get canRefresh(): boolean {
    return this.role === "writer" || this.writerPid !== undefined;
  }

  /** Starts the writer-side queue consumer. Readers never poll or handle work. */
  public start(handlers: Record<RefreshKind, RefreshHandler>): void {
    if (this.role !== "writer" || this.pollHandle) {
      return;
    }

    this.handlers = handlers;
    fs.mkdirSync(this.queuePath, { recursive: true });
    this.pollHandle = setInterval(() => {
      void this.poll().catch((error: unknown) => {
        logError("Cache refresh coordination poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, POLL_MS);
  }

  public stop(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
  }

  /**
   * Runs locally in the writer or waits for the writer's response in a reader.
   * The local callback is deliberately never invoked in a reader process.
   */
  public async run<T>(kind: RefreshKind, localWork: () => Promise<T>): Promise<T> {
    if (this.role === "writer") {
      return this.enqueue(localWork);
    }

    if (this.writerPid === undefined) {
      throw new Error("The cache writer could not be identified, so the refresh cannot be delegated.");
    }

    return this.request<T>(kind);
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.localTail.then(work, work);
    this.localTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async request<T>(kind: RefreshKind): Promise<T> {
    if (!RefreshCoordinator.isRunning(this.writerPid!)) {
      throw new Error("The cache writer exited before it could perform the requested refresh. Restart the MCP server and retry.");
    }

    fs.mkdirSync(this.queuePath, { recursive: true });
    const id = randomUUID();
    const requestPath = this.filePath(id, "request");
    const responsePath = this.filePath(id, "response");
    const request: RefreshRequest = {
      version: 1,
      id,
      kind,
      requesterPid: process.pid,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(requestPath, JSON.stringify(request), { flag: "wx" });
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;

    try {
      while (Date.now() < deadline) {
        if (fs.existsSync(responsePath)) {
          const response = JSON.parse(fs.readFileSync(responsePath, "utf8")) as RefreshResponse;
          if (response.id !== id || response.version !== 1) {
            throw new Error("The cache writer returned an invalid refresh response.");
          }
          if (!response.ok) {
            throw new Error(response.error ?? "The cache writer could not complete the requested refresh.");
          }
          return response.result as T;
        }

        if (!RefreshCoordinator.isRunning(this.writerPid!)) {
          throw new Error("The cache writer exited while performing the requested refresh. Restart the MCP server and retry.");
        }

        await RefreshCoordinator.delay(POLL_MS);
      }

      throw new Error("Timed out waiting for the cache writer to complete the requested refresh.");
    } finally {
      fs.rmSync(requestPath, { force: true });
      // A processing file belongs to the writer. Leaving it in place on timeout
      // lets a replacement writer recover it rather than losing an accepted job.
      fs.rmSync(responsePath, { force: true });
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;

    try {
      const claimed: Array<{ request: RefreshRequest; processingPath: string }> = [];

      for (const name of fs.readdirSync(this.queuePath)) {
        if (!name.endsWith(".request.json") && !name.endsWith(".processing.json")) {
          continue;
        }

        const sourcePath = path.join(this.queuePath, name);
        const processingPath = name.endsWith(".processing.json")
          ? sourcePath
          : path.join(this.queuePath, name.replace(".request.json", ".processing.json"));

        if (sourcePath !== processingPath) {
          try {
            fs.renameSync(sourcePath, processingPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              continue;
            }
            throw error;
          }
        }

        try {
          const request = JSON.parse(fs.readFileSync(processingPath, "utf8")) as RefreshRequest;
          if (request.version !== 1 || !this.isRefreshKind(request.kind) || typeof request.id !== "string") {
            fs.rmSync(processingPath, { force: true });
            continue;
          }
          if (!RefreshCoordinator.isRunning(request.requesterPid)) {
            fs.rmSync(processingPath, { force: true });
            continue;
          }
          claimed.push({ request, processingPath });
        } catch {
          fs.rmSync(processingPath, { force: true });
        }
      }

      // Coalesce requests that arrived in the same poll window. Every waiter
      // receives the same result from one upstream refresh.
      const byKind = new Map<RefreshKind, Array<{ request: RefreshRequest; processingPath: string }>>();
      for (const item of claimed) {
        const group = byKind.get(item.request.kind) ?? [];
        group.push(item);
        byKind.set(item.request.kind, group);
      }

      for (const [kind, group] of byKind) {
        const handler = this.handlers[kind];
        let response: Omit<RefreshResponse, "id">;
        try {
          if (!handler) {
            throw new Error(`No writer handler is registered for ${kind}.`);
          }
          const result = await handler();
          response = { version: 1, ok: true, result: result ?? null };
        } catch (error) {
          response = {
            version: 1,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        for (const item of group) {
          const responsePath = this.filePath(item.request.id, "response");
          const temporaryPath = `${responsePath}.${process.pid}.tmp`;
          fs.writeFileSync(
            temporaryPath,
            JSON.stringify({ ...response, id: item.request.id } satisfies RefreshResponse),
          );
          // The reader sees either no response or one complete JSON document;
          // it can never race the writer between file creation and the last byte.
          fs.renameSync(temporaryPath, responsePath);
          fs.rmSync(item.processingPath, { force: true });
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private filePath(id: string, state: "request" | "processing" | "response"): string {
    return path.join(this.queuePath, `${id}.${state}.json`);
  }

  private isRefreshKind(value: unknown): value is RefreshKind {
    return [
      "transactions-full",
      "transactions-incremental",
      "accounts",
      "scheduled-transactions",
      "categories",
      "tags",
    ].includes(String(value));
  }

  private static isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
