import { ConfigurationError, loadConfig } from "./config.js";
import { logError } from "./logger.js";
import { runStdioServer } from "./runtime/stdio-server.js";

async function main(): Promise<void> {
  await runStdioServer(loadConfig());
}

main().catch((error: unknown) => {
  // A setup mistake is not a crash. Its stack points into config.ts and tells
  // the reader nothing about the `.env` they still have to write, and a host
  // that surfaces only the first stderr line would show a stack frame instead
  // of the instruction. Print the message on its own.
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  logError("Fatal stdio server error", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exitCode = 1;
});
