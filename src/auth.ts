#!/usr/bin/env node
// Required by the `bin` entry, same as src/index.ts: npm links this onto PATH,
// and without the shebang the shell executes the file rather than handing it to
// node. Authentication has to be reachable from an installed package — it is
// mandatory before the server can do anything, and `npm run auth` only exists
// inside a clone.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { runLocalAuth } from "./commands/local-auth.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const terminal = createInterface({ input: stdin, output: stdout });

  try {
    await runLocalAuth(config, {
      isInteractive: Boolean(stdin.isTTY),
      write: (message) => stdout.write(message),
      prompt: (message) => terminal.question(message),
    });
  } finally {
    terminal.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
