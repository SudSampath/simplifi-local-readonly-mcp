import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AccountService } from "../../src/services/account-service.js";
import type { AnalysisService } from "../../src/services/analysis-service.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { TransactionToolService } from "../../src/services/transaction-tool-service.js";

/**
 * The read-only boundary as a *caller* experiences it.
 *
 * The tool-list snapshot in read-only-boundary.test.ts asserts the write tools are
 * not registered, which is introspection — it reads the server's internals. It does
 * not answer what SUD-8's acceptance criteria actually ask: what happens when
 * someone names `update_transaction` and sends it?
 *
 * That distinction is the whole point of the ticket. "The capability does not
 * exist" and "the capability exists but was denied" are different guarantees — a
 * permission error implies something is there to be permitted, and anything that
 * can be permitted can be mis-permitted. This drives a real MCP client over a real
 * transport and pins the failure as the former.
 *
 * Raised in review of PR #4, and correctly: the assertion was missing.
 *
 * Note on the shape being asserted: the SDK does **not** reject for an unknown
 * tool. `callTool` resolves with `{ isError: true, content: [...] }` carrying
 * `MCP error -32602: Tool <name> not found`. Writing this test discovered that —
 * the first version asserted a rejection and failed. Asserting the real
 * client-observable shape is the point, since that is what an agent host sees.
 */

// Registration never invokes a handler, and the sealed environment would reject
// any network access if one somehow ran.
const NO_SERVICE = {} as TransactionToolService;

const NOT_FOUND = /not found|unknown tool|does not exist/i;
const PERMISSION_LANGUAGE = /permission|forbidden|denied|not allowed|unauthoriz|disabled|read-only/i;

let client: Client;
let closeAll: () => Promise<void>;

/** The text of an error result, or "" if the call unexpectedly succeeded. */
async function callAndReadError(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };

  if (result.isError !== true) {
    return "";
  }

  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

beforeEach(async () => {
  const server = createMcpServer(NO_SERVICE, {} as AccountService, {} as AnalysisService, 60_000);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  client = new Client({ name: "read-only-boundary-test", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  closeAll = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await closeAll();
});

describe("Given a connected MCP client and the server as it ships", () => {
  test("When I list the tools over the protocol, then no write tool is offered", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).not.toContain("update_transaction");
    expect(names).not.toContain("categorize_transaction");
    // Guards against an empty list making this vacuous.
    expect(names).toContain("list_transactions");
  });

  test("When I call update_transaction by name, then the call comes back as an error", async () => {
    const result = (await client.callTool({
      name: "update_transaction",
      arguments: { transactionId: "txn-synthetic-0001", patch: {} },
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  test("When I call update_transaction by name, then the error says the tool is not found", async () => {
    const message = await callAndReadError("update_transaction", { transactionId: "txn-synthetic-0001" });

    expect(message).toMatch(NOT_FOUND);
  });

  test("When I call update_transaction by name, then the error never reads as a permission refusal", async () => {
    // The assertion that carries the ticket's intent. If this ever starts
    // matching, the write path was reintroduced behind a guard rather than
    // stopped from existing.
    const message = await callAndReadError("update_transaction", { transactionId: "txn-synthetic-0001" });

    expect(message).not.toMatch(PERMISSION_LANGUAGE);
  });

  test("When I call categorize_transaction by name, then it fails the same way", async () => {
    const message = await callAndReadError("categorize_transaction", { transactionId: "t", categoryId: "c" });

    expect(message).toMatch(NOT_FOUND);
    expect(message).not.toMatch(PERMISSION_LANGUAGE);
  });

  test("When I call a tool nobody ever wrote, then the removed tools fail identically", async () => {
    // Proves the removed tools are genuinely absent rather than specially handled:
    // they behave exactly like a name that never existed at all.
    const removed = await callAndReadError("update_transaction");
    const neverExisted = await callAndReadError("delete_every_transaction");

    const shape = (message: string): string =>
      message.replace(/update_transaction|delete_every_transaction/g, "<name>");

    expect(shape(removed)).toBe(shape(neverExisted));
    expect(removed).not.toBe("");
  });

  test("When I call a tool that does exist, then it is dispatched rather than rejected as unknown", async () => {
    // Without this, every assertion above could pass on a server that refuses
    // everything. The stub service has no methods, so dispatch fails on the
    // handler — but the failure must not be "not found".
    const message = await callAndReadError("list_transactions", { limit: 1 });

    expect(message).not.toMatch(/not found/i);
  });
});
