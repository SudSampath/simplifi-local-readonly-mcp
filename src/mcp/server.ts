import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AccountService } from "../services/account-service.js";
import { AnalysisService } from "../services/analysis-service.js";
import { TransactionToolService } from "../services/transaction-tool-service.js";

function toToolResponse(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function createMcpServer(
  toolService: TransactionToolService,
  accountService: AccountService,
  analysisService: AnalysisService,
  maxStaleMs: number,
): McpServer {
  const server = new McpServer({
    name: "household-finance-mcp",
    version: "0.1.0",
  });
  const mcp = server as any;

  mcp.tool(
    "list_transactions",
    "List locally cached Simplifi transactions with optional filters and pagination.",
    {
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.listTransactions(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "search_transactions",
    "Search locally cached Simplifi transactions by text with optional filters.",
    {
      query: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.searchTransactions(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "get_transaction",
    "Get a single transaction by id from local cache (with sync-on-miss).",
    {
      transactionId: z.string().min(1),
      refreshOnMiss: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.getTransaction(input);
      return toToolResponse(result);
    },
  );

  // No write tools. This server is read-only by absence of capability, not by a
  // flag or a permission check: upstream's update_transaction and
  // categorize_transaction are removed, along with the only PUT in the Simplifi
  // client. A tool that does not exist cannot be talked into firing by a mistaken
  // prompt, and the household's actual financial records are behind this process.
  //
  // Asserted in tests/mcp/read-only-boundary.test.ts against the registered tool
  // list, so adding one back fails the suite rather than passing review.

  mcp.tool(
    "list_uncategorized_transactions",
    "List transactions that look uncategorized (coa.type=UNCATEGORIZED or coa.id=0).",
    {
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.listUncategorizedTransactions(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "search_merchants",
    "Search merchants (payee names) from the cached transaction DB and return frequency counts.",
    {
      query: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      includeDeleted: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.searchMerchants(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "list_categories",
    "List Simplifi categories (synced and cached locally).",
    {
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    async (input: any) => {
      const result = await toolService.listCategories(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "search_categories",
    "Search Simplifi categories by name (synced and cached locally).",
    {
      query: z.string().min(1),
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    async (input: any) => {
      const result = await toolService.searchCategories(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "list_tags",
    "List Simplifi tags (synced and cached locally).",
    {
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    async (input: any) => {
      const result = await toolService.listTags(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "search_tags",
    "Search Simplifi tags by name (synced and cached locally).",
    {
      query: z.string().min(1),
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    async (input: any) => {
      const result = await toolService.searchTags(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "suggest_categories_for_merchant",
    "Suggest likely categories for a merchant based on your historical transactions in the local cache.",
    {
      merchant: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(20).optional(),
      matchMode: z.enum(["exact", "contains"]).optional(),
      refreshCategories: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.suggestCategoriesForMerchant(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "list_accounts",
    "List your Simplifi accounts with balances, from the local cache. valueCents is the canonical signed current value and valueSource identifies its source; other *Cents fields preserve raw balance variants. The *Formatted strings are for display only.",
    {
      includeClosed: z.boolean().optional(),
      type: z.enum(["BANK", "CREDIT", "INVESTMENT", "LOAN", "VEHICLE", "REAL_ESTATE"]).optional(),
      refresh: z.boolean().optional(),
    },
    async (input: any) => {
      if (input?.refresh) {
        await accountService.syncAccounts();
      } else {
        await accountService.ensureAccountsFresh(maxStaleMs);
      }
      const accounts = accountService.listAccounts(input ?? {});
      return toToolResponse({ total: accounts.length, accounts });
    },
  );

  mcp.tool(
    "net_worth",
    "Calculate current net worth from canonical signed account values. Returns every included account and every exclusion so the total is traceable. Closed, ignored, and valueless accounts are excluded.",
    { refresh: z.boolean().optional() },
    async (input: any) => {
      if (input?.refresh) {
        await accountService.syncAccounts();
      } else {
        await accountService.ensureAccountsFresh(maxStaleMs);
      }
      return toToolResponse(accountService.netWorth());
    },
  );

  mcp.tool(
    "list_credit_card_statements",
    "List credit accounts that have a statement, soonest due first, with amount due, minimum payment, and anything past due.",
    { refresh: z.boolean().optional() },
    async (input: any) => {
      if (input?.refresh) {
        await accountService.syncAccounts();
      } else {
        await accountService.ensureAccountsFresh(maxStaleMs);
      }
      const statements = accountService.listCreditCardStatements();
      return toToolResponse({ total: statements.length, statements });
    },
  );

  mcp.tool(
    "list_upcoming_bills",
    "List scheduled bills, subscriptions, and transfers due in a date range, soonest first. Pass `from` and `to` as YYYY-MM-DD; omitting `from` returns everything scheduled, including past due dates.",
    {
      from: z.string().optional(),
      to: z.string().optional(),
      type: z.enum(["BILL", "SUBSCRIPTION", "TRANSFER"]).optional(),
      includeCompleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    async (input: any) => {
      if (input?.refresh) {
        await accountService.syncScheduledTransactions();
      } else {
        await accountService.ensureScheduledFresh(maxStaleMs);
      }
      const scheduled = accountService.listScheduledTransactions(input ?? {});
      return toToolResponse({ total: scheduled.length, scheduled });
    },
  );

  // The three analysis tools below are adapters and nothing else: each one calls
  // a single service method and serialises what comes back. No summing, no
  // filtering, no date arithmetic lives here. That is an acceptance criterion of
  // SUD-16 rather than a matter of taste — the app calls the same functions
  // directly, and any logic that lived here would exist only for MCP callers and
  // drift away from what the app computes.
  //
  // Every figure they return carries the ids of the transactions composing it,
  // so responses grow with the range asked about. Narrow the range rather than
  // asking for the ids to be dropped: a total nobody can re-sum is exactly the
  // total this ticket exists to stop shipping.

  const RANGE_SHAPE = {
    from: z.string().optional(),
    to: z.string().optional(),
    asOf: z.string().optional(),
    accountId: z.string().optional(),
    refresh: z.boolean().optional(),
  };

  mcp.tool(
    "spending_by_category",
    "Spending by category by calendar month, with the transaction ids behind every figure. Transfers, balance adjustments, investment activity, and future-dated projections are excluded and reported separately. Defaults to the last twelve months; pass `from`/`to` as YYYY-MM-DD.",
    RANGE_SHAPE,
    async (input: any) => {
      const result = await analysisService.spendingByCategory(input ?? {});
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "monthly_burn",
    "Money out, money in, and the net by month, with the transaction ids behind every figure. The average is taken over complete months only — a month still in progress is reported as incomplete and left out of it.",
    RANGE_SHAPE,
    async (input: any) => {
      const result = await analysisService.monthlyBurn(input ?? {});
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "recurring_charge_changes",
    "Recurring charges whose amount has changed, largest rise first, with the transactions evidencing the old amount and the new one. Groups outflows by merchant and assigns a cadence from the spacing between charges. Merchants that cost something different every time are listed separately rather than reported as changes.",
    {
      ...RANGE_SHAPE,
      minOccurrences: z.coerce.number().int().min(2).max(60).optional(),
      minChangeCents: z.coerce.number().int().min(1).optional(),
      minEstablishedRun: z.coerce.number().int().min(1).max(12).optional(),
    },
    async (input: any) => {
      const result = await analysisService.recurringCharges(input ?? {});
      return toToolResponse(result);
    },
  );

  return server;
}
