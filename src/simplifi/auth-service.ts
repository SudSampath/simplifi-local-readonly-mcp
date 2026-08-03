import { URL } from "node:url";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import type { SimplifiTokenSet } from "../types.js";
import { isExpired, nowIso } from "../utils.js";
import { DatabaseContext } from "../db/database.js";

const AUTHORIZATION_SKEW_MS = 60_000;

const RUN_AUTH_MESSAGE = "Run `npm run auth` in a terminal to sign in again.";
const NO_TOKENS_MESSAGE = `No stored Simplifi tokens. ${RUN_AUTH_MESSAGE}`;

interface PendingMfa {
  mfaId: string;
  mfaChannel: string;
  email?: string;
  phone?: string;
  threatMetrixSessionId: string;
  expiresAt: number;
}

export type AttemptLoginResult =
  | { status: "ok" }
  | { status: "mfa_required"; pendingId: string; mfaChannel: string; email?: string; phone?: string };

export class SimplifiAuthService {
  private readonly pendingMfaMap = new Map<string, PendingMfa>();
  /**
   * Latches the first refresh failure against the token that caused it. The
   * background sync runs on an interval, so without this a dead refresh token
   * means one upstream auth attempt per tick for as long as the server is up.
   * A successful operator login writes a different token, which re-arms it.
   */
  private refreshFailure: { error: Error; refreshToken: string } | null = null;

  public constructor(
    private readonly config: AppConfig["simplifi"],
    private readonly db: DatabaseContext,
  ) {}

  /**
   * Returns a usable access token, refreshing when necessary.
   *
   * This is the only auth entry point the MCP server can reach, and it will
   * never perform a credential login. A password login is what makes Simplifi
   * send an MFA code, and nothing on a non-interactive stdio process can answer
   * one — so attempting it from here would send texts nobody asked for, on a
   * loop, until the account locked. First login is an operator action.
   */
  public async getAccessToken(): Promise<string> {
    const cached = this.db.getSimplifiTokens();

    if (cached && !isExpired(cached.accessTokenExpiresAt, AUTHORIZATION_SKEW_MS)) {
      this.refreshFailure = null;
      return cached.accessToken;
    }

    if (!cached?.refreshToken) {
      throw new Error(NO_TOKENS_MESSAGE);
    }

    if (this.refreshFailure?.refreshToken === cached.refreshToken) {
      throw this.refreshFailure.error;
    }

    try {
      const refreshed = await this.refreshToken(cached.refreshToken);
      this.db.saveSimplifiTokens(refreshed);
      this.refreshFailure = null;
      return refreshed.accessToken;
    } catch (error) {
      const failure = new Error(this.describeRefreshFailure(cached, error));
      this.refreshFailure = { error: failure, refreshToken: cached.refreshToken };
      logWarn("Simplifi token refresh failed; not attempting credential login", {
        error: failure.message,
      });
      throw failure;
    }
  }

  /**
   * Names which of the two recoverable states we are in, because they need
   * different things from the operator: an expired token is routine, a rejected
   * one usually means the session was revoked from Simplifi's side.
   */
  private describeRefreshFailure(cached: SimplifiTokenSet, error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    const cause =
      cached.refreshTokenExpiresAt !== undefined && isExpired(cached.refreshTokenExpiresAt)
        ? "The stored Simplifi refresh token has expired."
        : "Simplifi rejected the stored refresh token; it has most likely been revoked.";

    return `${cause} ${RUN_AUTH_MESSAGE} (upstream detail: ${detail})`;
  }

  /**
   * Attempts to ensure valid Simplifi tokens exist for the local operator auth
   * command. MFA stays in that terminal flow; it is never an MCP capability.
   *
   * Returns { status: "ok" } if tokens are already valid or login succeeded without MFA.
   * Returns { status: "mfa_required", ... } if Simplifi sent a 202 MFA challenge.
   */
  public async attemptLogin(): Promise<AttemptLoginResult> {
    const cached = this.db.getSimplifiTokens();

    if (cached && !isExpired(cached.accessTokenExpiresAt, AUTHORIZATION_SKEW_MS)) {
      return { status: "ok" };
    }

    if (cached?.refreshToken) {
      try {
        const refreshed = await this.refreshToken(cached.refreshToken);
        this.db.saveSimplifiTokens(refreshed);
        return { status: "ok" };
      } catch (error) {
        logWarn("Simplifi token refresh failed during OAuth flow; attempting credential re-login", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const threatMetrixSessionId = this.config.threatMetrixSessionId ?? randomUUID();
    const threatMetrixRequestId = this.config.threatMetrixRequestId ?? null;

    const authorizeResponse = await this.callAuthorize({
      mfaChannel: null,
      mfaCode: null,
      mfaId: null,
      threatMetrixSessionId,
      threatMetrixRequestId,
    });

    if (authorizeResponse.status === 202) {
      const body = (await authorizeResponse.json()) as Record<string, unknown>;
      const mfaId = String(body.mfaId ?? "");
      const mfaChannel = typeof body.mfaChannel === "string" ? body.mfaChannel : "EMAIL";
      const email = typeof body.email === "string" ? body.email : undefined;
      const phone = typeof body.phone === "string" ? body.phone : undefined;

      const pendingId = randomUUID();
      this.pendingMfaMap.set(pendingId, {
        mfaId,
        mfaChannel,
        email,
        phone,
        threatMetrixSessionId,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      return { status: "mfa_required", pendingId, mfaChannel, email, phone };
    }

    if (authorizeResponse.status >= 400) {
      throw new Error(
        `Simplifi authorize failed: status=${authorizeResponse.status}, body=${await authorizeResponse.text()}`,
      );
    }

    const token = await this.processSuccessfulAuthorize(authorizeResponse);
    this.db.saveSimplifiTokens(token);
    logInfo("Simplifi credential login completed");
    return { status: "ok" };
  }

  /**
   * Completes an MFA challenge initiated by attemptLogin(). On success the
   * Simplifi tokens are saved to the database.
   */
  public async completeMfaLogin(pendingId: string, mfaCode: string): Promise<void> {
    const pending = this.pendingMfaMap.get(pendingId);
    if (!pending) {
      throw new Error("MFA session not found or expired. Please restart the authorization flow.");
    }

    if (Date.now() > pending.expiresAt) {
      this.pendingMfaMap.delete(pendingId);
      throw new Error("MFA session expired. Please restart the authorization flow.");
    }

    const authorizeResponse = await this.callAuthorize({
      mfaChannel: pending.mfaChannel,
      mfaCode,
      mfaId: pending.mfaId,
      threatMetrixSessionId: pending.threatMetrixSessionId,
      threatMetrixRequestId: this.config.threatMetrixRequestId ?? null,
    });

    if (![200, 201].includes(authorizeResponse.status)) {
      const body = await authorizeResponse.text();
      throw new Error(`Simplifi MFA verification failed: status=${authorizeResponse.status}, body=${body}`);
    }

    const token = await this.processSuccessfulAuthorize(authorizeResponse);
    this.db.saveSimplifiTokens(token);
    this.pendingMfaMap.delete(pendingId);
    logInfo("Simplifi MFA login completed");
  }

  public getPendingMfaInfo(pendingId: string): Pick<PendingMfa, "mfaChannel" | "email" | "phone"> | undefined {
    const pending = this.pendingMfaMap.get(pendingId);
    if (!pending || Date.now() > pending.expiresAt) {
      return undefined;
    }
    return { mfaChannel: pending.mfaChannel, email: pending.email, phone: pending.phone };
  }

  // There is deliberately no loginWithCredentials() here. The only method that
  // sends the password to /oauth/authorize is attemptLogin(), which exists for
  // the operator's terminal command; getAccessToken() cannot reach it. Adding a
  // credential fallback back into the server's path is what SUD-29 exists to
  // prevent — see the assertion in tests/simplifi/no-server-side-login.test.ts.

  private async callAuthorize(opts: {
    mfaChannel: string | null;
    mfaCode: string | null;
    mfaId: string | null;
    threatMetrixSessionId: string;
    threatMetrixRequestId: string | null;
  }): Promise<Response> {
    const authorizeUrl = new URL("/oauth/authorize", this.config.baseUrl);

    return this.request(authorizeUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        clientId: this.config.clientId,
        username: this.config.email,
        password: this.config.password,
        redirectUri: this.config.redirectUri,
        responseType: "code",
        mfaChannel: opts.mfaChannel,
        mfaCode: opts.mfaCode,
        mfaId: opts.mfaId,
        threatMetrixRequestId: opts.threatMetrixRequestId,
        threatMetrixSessionId: opts.threatMetrixSessionId,
      }),
      headers: {
        "tm-session-id": opts.threatMetrixSessionId,
      },
    });
  }

  private async processSuccessfulAuthorize(response: Response): Promise<SimplifiTokenSet> {
    const location = response.headers.get("location");
    if (!location) {
      // Include what upstream actually said. Without it every unexpected shape —
      // a rejected credential, a changed contract, a challenge we did not model —
      // reports as the same sentence and tells the operator nothing.
      throw new Error(
        `Simplifi authorize did not return a location header with auth code: ` +
          `status=${response.status}, headers=${JSON.stringify(Object.fromEntries(response.headers))}, ` +
          `body=${await response.text()}`,
      );
    }

    const codeUrl = new URL(location);
    const code = codeUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Simplifi authorize location header missing authorization code");
    }

    return this.exchangeAuthorizationCode(code);
  }

  private async refreshToken(refreshToken: string): Promise<SimplifiTokenSet> {
    const tokenUrl = new URL("/oauth/token", this.config.baseUrl);

    const response = await this.request(tokenUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        grantType: "refreshToken",
        responseType: "token",
        redirectUri: this.config.redirectUri,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken,
      }),
    });

    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Simplifi token refresh failed: status=${response.status}, body=${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.parseTokenPayload(payload);
  }

  private async exchangeAuthorizationCode(code: string): Promise<SimplifiTokenSet> {
    const tokenUrl = new URL("/oauth/token", this.config.baseUrl);

    const response = await this.request(tokenUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        grantType: "authorization_code",
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        code,
        redirectUri: this.config.redirectUri,
      }),
    });

    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Simplifi token exchange failed: status=${response.status}, body=${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.parseTokenPayload(payload);
  }

  private parseTokenPayload(payload: Record<string, unknown>): SimplifiTokenSet {
    const accessToken = this.pickString(payload, "accessToken") ?? this.pickString(payload, "access_token");
    const refreshToken = this.pickString(payload, "refreshToken") ?? this.pickString(payload, "refresh_token");

    if (!accessToken || !refreshToken) {
      throw new Error("Simplifi token response did not include access and refresh tokens");
    }

    const accessTokenExpiresAt =
      this.pickString(payload, "accessTokenExpired") ??
      this.calculateExpiryFromSeconds(payload.expires_in) ??
      new Date(Date.now() + 55 * 60 * 1000).toISOString();

    const refreshTokenExpiresAt = this.pickString(payload, "refreshTokenExpired") ?? undefined;

    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  private pickString(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private calculateExpiryFromSeconds(value: unknown): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return new Date(Date.now() + value * 1000).toISOString();
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);

    try {
      return await fetch(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json;charset=UTF-8",
          accept: "application/json, text/plain, */*",
          "app-client-id": this.config.clientId,
          "app-release": "6.5.0",
          "app-build": "63580",
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  public clearTokens(): void {
    this.db.saveSimplifiTokens({
      accessToken: "",
      accessTokenExpiresAt: nowIso(),
      refreshToken: "",
    });
  }
}
