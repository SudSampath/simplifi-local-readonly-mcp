import { loadConfig } from "./config.js";
import { logError } from "./logger.js";
import { runStdioServer } from "./runtime/stdio-server.js";

async function main(): Promise<void> {
  await runStdioServer(loadConfig());
}

main().catch((error: unknown) => {
  logError("Fatal stdio server error", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exitCode = 1;
});
