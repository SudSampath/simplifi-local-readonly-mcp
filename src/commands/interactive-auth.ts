import type { AttemptLoginResult } from "../simplifi/auth-service.js";

export interface InteractiveAuthService {
  attemptLogin(): Promise<AttemptLoginResult>;
  completeMfaLogin(pendingId: string, mfaCode: string): Promise<void>;
}

export interface AuthTerminal {
  /**
   * Whether this terminal can actually take input. False under a pipe, a CI
   * runner, or an agent harness that offers no TTY.
   */
  isInteractive: boolean;
  write(message: string): void;
  prompt(message: string): Promise<string>;
}

/**
 * How many times the operator may enter a code against a single challenge.
 * Every fresh challenge is another text message to a real phone, so a mistyped
 * digit must be recoverable here rather than by running the command again.
 */
const MAX_CODE_ATTEMPTS = 3;

/**
 * Performs the one interactive operation in this project: an operator login.
 * It is intentionally independent of MCP, so an agent cannot trigger it or
 * supply an MFA code through a tool call.
 */
export async function runInteractiveAuth(service: InteractiveAuthService, terminal: AuthTerminal): Promise<void> {
  // Checked before attemptLogin, not at the prompt. Simplifi sends the text the
  // moment authorize returns its challenge, so discovering there is no TTY only
  // once we need the code has already cost a real message to a real phone and
  // spent a challenge that cannot be resumed from another process.
  if (!terminal.isInteractive) {
    throw new Error(
      "npm run auth needs a real terminal: stdin is not a TTY, so an MFA code could not be entered. " +
        "Run it directly in a terminal window rather than through a pipe, a CI job, or an agent harness.",
    );
  }

  const result = await service.attemptLogin();

  if (result.status === "ok") {
    terminal.write("Simplifi login is complete; local tokens are ready.\n");
    return;
  }

  const destination = result.email ?? result.phone ?? "your configured destination";
  terminal.write(`Simplifi sent an MFA code via ${result.mfaChannel} to ${destination}.\n`);

  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = (await terminal.prompt("Enter the MFA code: ")).trim();

    if (!code) {
      terminal.write("No MFA code entered.\n");
      continue;
    }

    try {
      await service.completeMfaLogin(result.pendingId, code);
      terminal.write("Simplifi MFA login is complete; local tokens are ready.\n");
      return;
    } catch (error) {
      // A dead challenge cannot be retried, only replaced, so stop rather than
      // burn the remaining attempts against something Simplifi has discarded.
      if (isChallengeGone(error)) {
        throw error;
      }

      const remaining = MAX_CODE_ATTEMPTS - attempt;
      terminal.write(
        remaining > 0
          ? `That code was rejected. ${remaining} attempt${remaining === 1 ? "" : "s"} left on this code.\n`
          : "That code was rejected.\n",
      );
    }
  }

  throw new Error(
    `No valid MFA code entered after ${MAX_CODE_ATTEMPTS} attempts. This code is spent — ` +
      "run npm run auth again to request a new one.",
  );
}

/**
 * Distinguishes "Simplifi said no" from "the challenge no longer exists".
 * Both surface as thrown errors from completeMfaLogin; only the first is worth
 * retrying. Coupled to the messages raised in SimplifiAuthService.
 */
function isChallengeGone(error: unknown): boolean {
  return error instanceof Error && /MFA session/i.test(error.message);
}
