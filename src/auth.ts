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
