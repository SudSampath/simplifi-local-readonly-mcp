import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * The installation root, derived from this module rather than from the working
 * directory. A host spawns this server as `node <abs>/dist/index.js` with a cwd
 * of its own choosing — usually not the repo — so resolving `.env` or the cache
 * against cwd means the server finds neither, and fails at startup on a machine
 * where it works perfectly from a terminal.
 *
 * Correct for both layouts: `src/config.ts` and `dist/config.js` are each one
 * directory below the root.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(PACKAGE_ROOT, ".env") });

export interface AppConfig {
  cache: {
    dbPath: string;
  };
  simplifi: {
    baseUrl: string;
    email: string;
    password: string;
    datasetId: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    threatMetrixSessionId?: string;
    threatMetrixRequestId?: string;
    httpTimeoutMs: number;
    syncIntervalMs: number;
    maxStaleMs: number;
    pageLimit: number;
  };
}

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Reads an optional variable, treating blank as absent.
 *
 * `.env` files spell "unset" as `KEY=`, which reaches us as an empty string
 * rather than undefined — so `??` fallbacks downstream never fire and the empty
 * value is sent upstream as though it were real. Simplifi rejects the authorize
 * call with "must be specified" when that happens, which reads as a missing
 * parameter rather than a blank one.
 */
function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric environment variable ${name}: ${raw}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  // Relative to the installation, not the caller. Two hosts spawning this server
  // from different directories must reach the same cache and therefore the same
  // stored tokens, or each one silently starts empty and re-syncs.
  const cacheDbPath = path.resolve(PACKAGE_ROOT, process.env.CACHE_DB_PATH ?? "./data/cache.sqlite");

  return {
    cache: {
      dbPath: cacheDbPath,
    },
    simplifi: {
      baseUrl: process.env.SIMPLIFI_BASE_URL ?? "https://services.quicken.com",
      email: getEnv("SIMPLIFI_EMAIL"),
      password: getEnv("SIMPLIFI_PASSWORD"),
      datasetId: getEnv("SIMPLIFI_DATASET_ID"),
      clientId: process.env.SIMPLIFI_CLIENT_ID ?? "acme_web",
      clientSecret: process.env.SIMPLIFI_CLIENT_SECRET ?? "BCDCxXwdWYcj@bK6",
      redirectUri: process.env.SIMPLIFI_REDIRECT_URI ?? "https://simplifi.quicken.com/login",
      threatMetrixSessionId: getOptionalEnv("SIMPLIFI_THREAT_METRIX_SESSION_ID"),
      threatMetrixRequestId: getOptionalEnv("SIMPLIFI_THREAT_METRIX_REQUEST_ID"),
      httpTimeoutMs: getNumberEnv("SIMPLIFI_HTTP_TIMEOUT_MS", 30_000),
      syncIntervalMs: getNumberEnv("SIMPLIFI_SYNC_INTERVAL_MS", 60_000),
      maxStaleMs: getNumberEnv("SIMPLIFI_MAX_STALE_MS", 120_000),
      pageLimit: getNumberEnv("SIMPLIFI_PAGE_LIMIT", 5000),
    },
  };
}
