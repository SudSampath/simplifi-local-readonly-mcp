import { URL } from "node:url";

import type { AppConfig } from "../config.js";
import type {
  AccountListResponse,
  CategoryListResponse,
  EarliestDateOnResponse,
  ScheduledTransactionListResponse,
  TagListResponse,
  TransactionListResponse,
} from "../types.js";
import { SimplifiAuthService } from "./auth-service.js";

interface ListTransactionsInput {
  limit?: number;
  dateOnAfter?: string;
  modifiedAfter?: string;
  after?: string;
  currentPage?: number;
}

interface ListReferenceInput {
  limit?: number;
  modifiedAfter?: string;
}

export class SimplifiClient {
  public constructor(
    private readonly config: AppConfig["simplifi"],
    private readonly authService: SimplifiAuthService,
  ) {}

  public async listTransactions(input: ListTransactionsInput): Promise<TransactionListResponse> {
    const url = new URL("/transactions", this.config.baseUrl);

    url.searchParams.set("limit", String(input.limit ?? this.config.pageLimit));

    if (input.dateOnAfter) {
      url.searchParams.set("dateOnAfter", input.dateOnAfter);
    }

    if (input.modifiedAfter) {
      url.searchParams.set("modifiedAfter", input.modifiedAfter);
    }

    if (input.after) {
      url.searchParams.set("after", input.after);
    }

    if (typeof input.currentPage === "number") {
      url.searchParams.set("currentPage", String(input.currentPage));
    }

    return this.authedRequest<TransactionListResponse>(url.toString(), {
      method: "GET",
    });
  }

  public async listTransactionsFromNextLink(nextLink: string): Promise<TransactionListResponse> {
    const url = new URL(nextLink, this.config.baseUrl);
    return this.authedRequest<TransactionListResponse>(url.toString(), {
      method: "GET",
    });
  }

  public async getEarliestDateOn(accountIds: string[] = []): Promise<EarliestDateOnResponse> {
    const url = new URL("/transactions/earliest-date-on", this.config.baseUrl);
    return this.authedRequest<EarliestDateOnResponse>(url.toString(), {
      method: "POST",
      body: JSON.stringify({ accountIds }),
    });
  }

  // No mutating request method exists on this client. updateTransaction was the
  // only PUT and it is gone; nothing here issues PUT, PATCH, or DELETE. The one
  // remaining non-GET is getEarliestDateOn above, which is a read that Quicken
  // happens to expose as a POST — see the allowlist assertion in
  // tests/simplifi/read-only-client.test.ts.

  public async listCategories(input: ListReferenceInput = {}): Promise<CategoryListResponse> {
    const url = new URL("/categories", this.config.baseUrl);
    url.searchParams.set("limit", String(input.limit ?? 5000));
    if (input.modifiedAfter) {
      url.searchParams.set("modifiedAfter", input.modifiedAfter);
    }
    return this.authedRequest<CategoryListResponse>(url.toString(), { method: "GET" });
  }

  public async listCategoriesFromNextLink(nextLink: string): Promise<CategoryListResponse> {
    const url = new URL(nextLink, this.config.baseUrl);
    return this.authedRequest<CategoryListResponse>(url.toString(), { method: "GET" });
  }

  /**
   * Accounts, with balances and — on credit accounts — statement detail.
   *
   * `listAccountsFromNextLink` exists even when a typical response fits on one
   * page. Assuming a collection endpoint will never paginate can silently omit
   * accounts when the collection grows.
   */
  public async listAccounts(input: ListReferenceInput = {}): Promise<AccountListResponse> {
    const url = new URL("/accounts", this.config.baseUrl);
    url.searchParams.set("limit", String(input.limit ?? 5000));
    if (input.modifiedAfter) {
      url.searchParams.set("modifiedAfter", input.modifiedAfter);
    }
    return this.authedRequest<AccountListResponse>(url.toString(), { method: "GET" });
  }

  public async listAccountsFromNextLink(nextLink: string): Promise<AccountListResponse> {
    const url = new URL(nextLink, this.config.baseUrl);
    return this.authedRequest<AccountListResponse>(url.toString(), { method: "GET" });
  }

  /** Scheduled bills, subscriptions, and transfers, each with a due date. */
  public async listScheduledTransactions(input: ListReferenceInput = {}): Promise<ScheduledTransactionListResponse> {
    const url = new URL("/scheduled-transactions", this.config.baseUrl);
    url.searchParams.set("limit", String(input.limit ?? 5000));
    if (input.modifiedAfter) {
      url.searchParams.set("modifiedAfter", input.modifiedAfter);
    }
    return this.authedRequest<ScheduledTransactionListResponse>(url.toString(), { method: "GET" });
  }

  public async listScheduledTransactionsFromNextLink(nextLink: string): Promise<ScheduledTransactionListResponse> {
    const url = new URL(nextLink, this.config.baseUrl);
    return this.authedRequest<ScheduledTransactionListResponse>(url.toString(), { method: "GET" });
  }

  public async listTags(input: ListReferenceInput = {}): Promise<TagListResponse> {
    const url = new URL("/tags", this.config.baseUrl);
    url.searchParams.set("limit", String(input.limit ?? 5000));
    if (input.modifiedAfter) {
      url.searchParams.set("modifiedAfter", input.modifiedAfter);
    }
    return this.authedRequest<TagListResponse>(url.toString(), { method: "GET" });
  }

  public async listTagsFromNextLink(nextLink: string): Promise<TagListResponse> {
    const url = new URL(nextLink, this.config.baseUrl);
    return this.authedRequest<TagListResponse>(url.toString(), { method: "GET" });
  }

  private async authedRequest<T>(url: string, init: RequestInit): Promise<T> {
    const token = await this.authService.getAccessToken();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "qcs-dataset-id": this.config.datasetId,
          "app-client-id": this.config.clientId,
          "app-release": "6.5.0",
          "app-build": "63580",
          ...(init.headers ?? {}),
        },
      });

      if (response.status >= 400) {
        const body = await response.text();
        throw new Error(`Simplifi request failed status=${response.status}, url=${url}, body=${body}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
