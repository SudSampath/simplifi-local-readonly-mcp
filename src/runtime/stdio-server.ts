import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { AppConfig } from "../config.js";
import { DatabaseContext } from "../db/database.js";
import { logError, logInfo } from "../logger.js";
import { createMcpServer } from "../mcp/server.js";
import { AccountService } from "../services/account-service.js";
import { AnalysisService } from "../services/analysis-service.js";
import { ReferenceDataService } from "../services/reference-data-service.js";
import { TransactionToolService } from "../services/transaction-tool-service.js";
import { SimplifiAuthService } from "../simplifi/auth-service.js";
import { SimplifiClient } from "../simplifi/client.js";
import { SyncService } from "../sync/sync-service.js";
import { CacheLease } from "./cache-lease.js";

/**
 * Runs exactly one local MCP server over the current process' stdio streams.
 *
 * There is intentionally no listener, downstream OAuth provider, or browser
 * redirect flow here. An embedder owns its own user authentication; this process
 * only serves a single local subprocess session.
 */
export async function runStdioServer(config: AppConfig): Promise<void> {
  // Losing the writer lease is a role, not a failure. A second host's instance
  // serves the cache read-only rather than dying at startup, because a host whose
  // tools are simply absent looks broken from the inside.
  const lease = CacheLease.acquire(config.cache.dbPath);
  const db = new DatabaseContext(config.cache.dbPath, { readOnly: lease.role === "reader" });
  const authService = new SimplifiAuthService(config.simplifi, db);
  const simplifiClient = new SimplifiClient(config.simplifi, authService);
  const syncService = new SyncService(config.simplifi, db, simplifiClient);
  const referenceDataService = new ReferenceDataService(config.simplifi, db, simplifiClient);
  const toolService = new TransactionToolService(
    db,
    syncService,
    simplifiClient,
    referenceDataService,
    config.simplifi.maxStaleMs,
  );
  const accountService = new AccountService(db, simplifiClient);
  const analysisService = new AnalysisService(db, syncService, referenceDataService, config.simplifi.maxStaleMs);
  const server = createMcpServer(toolService, accountService, analysisService, config.simplifi.maxStaleMs);
  const transport = new StdioServerTransport();
  const stopProcess = (reason: string) => {
    void shutdown(reason).finally(() => {
      // A background sync interval keeps Node alive after the embedding host has
      // closed stdin. Exit only after shutdown has released the SQLite handle and
      // cache lease; otherwise a killed child leaves a misleading lock behind.
      process.exit(0);
    });
  };
  const onStdinEnd = () => stopProcess("stdin closed");

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    // Assign the promise before invoking server.close(). The MCP SDK closes its
    // transport synchronously, which invokes onclose re-entrantly; without this
    // ordering each callback starts another shutdown.
    let resolveShutdown!: () => void;
    let rejectShutdown!: (error: unknown) => void;
    shutdownPromise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });

    void (async () => {
      try {
        logInfo("Stopping household-finance-mcp", { reason });
        syncService.stop();
        process.stdin.off("end", onStdinEnd);
        await server.close();
        db.close();
        lease.release();
        resolveShutdown();
      } catch (error) {
        rejectShutdown(error);
      }
    })();

    return shutdownPromise;
  };

  try {
    transport.onclose = () => {
      void shutdown("stdio closed");
    };
    transport.onerror = (error) => {
      logError("Stdio transport error", { error: error.message });
    };

    process.once("SIGINT", () => stopProcess("SIGINT"));
    process.once("SIGTERM", () => stopProcess("SIGTERM"));
    // The SDK transport reports explicit close() calls, but a host normally ends
    // the child stdin pipe. Node reports that as `end`, not as a transport error.
    // Treat it as shutdown so the cache lease and SQLite handles are released.
    process.stdin.once("end", onStdinEnd);
    process.stdin.once("close", onStdinEnd);

    await server.connect(transport);
    // There is no eager first sync. A short-lived stdio subprocess must be able
    // to complete MCP initialization without making a network request; tool calls
    // retain their existing freshness checks and trigger sync when data is needed.
    syncService.start();
    logInfo("household-finance-mcp ready on stdio", {
      role: lease.role,
      ...(lease.role === "reader"
        ? {
            writerPid: lease.writerPid,
            note: "Serving the cache read-only; the process holding the writer lease is the one that syncs.",
          }
        : {}),
    });

    await new Promise<void>((resolve) => {
      const complete = () => {
        void shutdown("stdio closed").finally(resolve);
      };
      transport.onclose = complete;
    });
  } catch (error) {
    await shutdown("startup failure");
    throw error;
  }
}
