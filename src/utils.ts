import crypto from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function isExpired(isoTimestamp: string, skewMs = 0): boolean {
  return new Date(isoTimestamp).getTime() <= Date.now() + skewMs;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }

  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { offset?: unknown };
    if (typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
    return 0;
  }

  return 0;
}

// deepMerge removed with the write surface. Its only caller merged a caller-
// supplied patch into a cached transaction to build a PUT payload. Keeping a
// general-purpose "apply arbitrary patch to a record" helper around in a
// read-only codebase is how a write path grows back.
