/**
 * SYNTHETIC fixtures. Provenance: every value in this file was invented by hand
 * for testing. None of it comes from a real Simplifi response, a real account,
 * or a real institution.
 *
 * This is a hard project rule, not a preference: the privacy boundary covers
 * test data. A fixture pasted from a real response is a real transaction living
 * in a git history forever, and git history survives every later attempt to
 * make the repo public.
 *
 * Payee names here are deliberately absurd so that a real one is obvious on
 * sight during review. Account ids are short and non-numeric so they cannot be
 * mistaken for account numbers.
 *
 * NOTE: amounts are decimal here because that is what upstream currently
 * returns and stores (`amount REAL`). SUD-13 converts money to integer cents
 * end to end; this factory changes with it.
 */

import type { CachedTransaction, Transaction } from "../../src/types.js";

/**
 * Typed against the real `Transaction` interface rather than a parallel shape,
 * so a fixture that would not survive the actual data layer fails the
 * typecheck rather than passing a test and failing in production.
 */
export type SyntheticTransaction = Transaction & {
  id: string;
  postedOn: string;
  accountId: string;
  payee: string;
  amount: number;
  state: string;
  coa: { type: string; id: string };
};

const DEFAULT_TRANSACTION: SyntheticTransaction = {
  id: "txn-synthetic-0001",
  postedOn: "2026-01-15",
  accountId: "acct-teal",
  payee: "Fictional Llama Emporium",
  amount: -42.5,
  state: "POSTED",
  coa: { type: "CATEGORY", id: "cat-supplies" },
};

/**
 * Build one synthetic transaction. Override only the fields the test is about,
 * so the test reads as the behavior under examination rather than a wall of
 * irrelevant setup.
 */
export function aTransaction(overrides: Partial<SyntheticTransaction> = {}): SyntheticTransaction {
  return { ...DEFAULT_TRANSACTION, ...overrides, coa: { ...DEFAULT_TRANSACTION.coa, ...overrides.coa } };
}

/**
 * Build one synthetic transaction as the *server hands it out* — integer cents
 * and a resolved transaction date, rather than the decimal amount upstream
 * sends.
 *
 * This is the shape the analysis layer consumes, so its fixtures are built here
 * rather than by round-tripping through the database: a test about how a total
 * treats a transfer should not also be a test of SQLite.
 */
export function aCachedTransaction(overrides: Partial<CachedTransaction> & { id: string }): CachedTransaction {
  return {
    payee: "Fictional Llama Emporium",
    amountCents: -4_250,
    amountFormatted: "-42.50",
    transactionDate: "2026-01-15",
    transactionDateSource: "cpData.txnOn",
    accountId: "acct-teal",
    type: "CASH_FLOW",
    state: "CLEARED",
    ...overrides,
    coa: overrides.coa ?? { type: "CATEGORY", id: "cat-supplies" },
  };
}

/** Both legs of one transfer between our own accounts, as Simplifi represents it. */
export function aCachedTransferPair(input: {
  outId: string;
  inId: string;
  amountCents: number;
  transactionDate: string;
}): [CachedTransaction, CachedTransaction] {
  return [
    aCachedTransaction({
      id: input.outId,
      amountCents: -input.amountCents,
      transactionDate: input.transactionDate,
      coa: { type: "ACCOUNT", id: "acct-plum" },
      transfer: { id: input.inId },
    }),
    aCachedTransaction({
      id: input.inId,
      amountCents: input.amountCents,
      transactionDate: input.transactionDate,
      coa: { type: "ACCOUNT", id: "acct-teal" },
      transfer: { id: input.outId },
    }),
  ];
}

/** Build a numbered series of synthetic transactions. */
export function someTransactions(count: number, overrides: Partial<SyntheticTransaction> = {}): SyntheticTransaction[] {
  return Array.from({ length: count }, (_unused, index) =>
    aTransaction({
      id: `txn-synthetic-${String(index + 1).padStart(4, "0")}`,
      ...overrides,
    }),
  );
}
