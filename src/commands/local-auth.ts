import type { AppConfig } from "../config.js";
import { DatabaseContext } from "../db/database.js";
import { CacheLease } from "../runtime/cache-lease.js";
import { SimplifiAuthService } from "../simplifi/auth-service.js";
import { runInteractiveAuth, type AuthTerminal } from "./interactive-auth.js";

/**
 * Runs the local operator auth flow while exclusively owning the shared cache.
 *
 * Saving tokens modifies the same SQLite cache used by the MCP server, so this
 * command follows the same lease rule as the stdio runtime — but unlike the
 * server it has no useful read-only mode. The whole point of the command is to
 * write a token, so losing the lease must stop it here rather than let it run an
 * interactive login and discard the result at the last step.
 */
export async function runLocalAuth(config: AppConfig, terminal: AuthTerminal): Promise<void> {
  const lease = CacheLease.acquire(config.cache.dbPath);

  if (lease.role === "reader") {
    lease.release();
    throw new Error(
      `Cannot sign in while another simplifi-local-readonly-mcp process holds the cache${lease.writerPid === undefined ? "" : ` (process ${lease.writerPid})`}. ` +
        `Signing in stores a token in the cache, which only one process may write. Close the other one and try again — ` +
        `in an editor that runs this as an MCP server, that means quitting the editor, not just the session.`,
    );
  }

  let db: DatabaseContext | undefined;

  try {
    db = new DatabaseContext(config.cache.dbPath);
    await runInteractiveAuth(new SimplifiAuthService(config.simplifi, db), terminal);
  } finally {
    db?.close();
    lease.release();
  }
}
