import assert from "node:assert/strict";
import test from "node:test";

import { validateSnapshot } from "../scripts/validate-snapshot.mjs";

const safeSnapshot = () => ({
  schemaVersion: 1,
  containsRawTransactions: false,
  containsPrivateRewardData: false,
  months: [{
    month: "2026-01",
    complete: true,
    incomeCents: 800000,
    outflowCents: 600000,
    essentialCents: 400000,
    discretionaryCents: 200000,
  }],
});

test("Given summary-only data, when it is validated, then publication is allowed", () => {
  assert.equal(validateSnapshot(safeSnapshot()).months.length, 1);
});

test("Given a raw transaction field, when it is validated, then publication is rejected", () => {
  const snapshot = { ...safeSnapshot(), transactions: [] };
  assert.throws(() => validateSnapshot(snapshot), /transactions is forbidden/);
});

test("Given issuer ledger data, when a public snapshot is validated, then publication is rejected", () => {
  const snapshot = { ...safeSnapshot(), ledgerEntries: [{ endingBalanceUnits: 24_000 }] };
  assert.throws(() => validateSnapshot(snapshot), /ledgerEntries is forbidden/);
});

test("Given an incomplete month, when it is validated, then publication is rejected", () => {
  const snapshot = safeSnapshot();
  snapshot.months[0].complete = false;
  assert.throws(() => validateSnapshot(snapshot), /incomplete/);
});

test("Given spending buckets that do not reconcile, when validated, then publication is rejected", () => {
  const snapshot = safeSnapshot();
  snapshot.months[0].discretionaryCents = 100000;
  assert.throws(() => validateSnapshot(snapshot), /must equal outflow/);
});
