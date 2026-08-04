#!/usr/bin/env node
// The shebang is required for the `bin` entry: npm links dist/index.js onto
// PATH, and without it the shell executes the file rather than handing it to
// node. tsc preserves a leading shebang in the emitted output.
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
