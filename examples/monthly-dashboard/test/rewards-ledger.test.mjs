import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRewardReconciliationSummary,
  recordedBalanceForMonth,
  reconcileRewardMonth,
  validateRewardLedgerEntry,
} from "../src/rewards-ledger.js";
import { aRewardStatement } from "./support/rewards-fixtures.mjs";

test("Given a manual issuer entry, when it is validated, then rewards, balance, redemptions, credits, fees, benefits, and unknowns retain their meaning", () => {
  const entry = validateRewardLedgerEntry(aRewardStatement({
    walletKey: "wallet-synthetic",
    redeemedUnits: 2_000,
    statementCreditsCents: 1_500,
    annualFeeCents: undefined,
    benefits: [{ benefitKey: "benefit-synthetic", usedOn: "2026-01-10", usedValueCents: undefined }],
  }));

  assert.equal(entry.issuerEarnedUnits, 4_000);
  assert.equal(entry.endingBalanceUnits, 24_000);
  assert.equal(entry.redeemedUnits, 2_000);
  assert.equal(entry.statementCreditsCents, 1_500);
  assert.equal(entry.annualFeeCents, null);
  assert.equal(entry.benefits[0].usedValueCents, null);
});

test("Given estimated and issuer-earned units, when variance is within configured tolerance, then the month is reconciled", () => {
  const result = reconcileRewardMonth({
    estimated: { cardKey: "card-synthetic-travel", month: "2026-01", estimatedUnits: 3_980 },
    ledgerEntry: aRewardStatement({ issuerEarnedUnits: 4_000 }),
    tolerance: { units: 25, percent: 0.5 },
  });

  assert.equal(result.varianceUnits, 20);
  assert.equal(result.variancePercent, (20 / 3_980) * 100);
  assert.equal(result.status, "reconciled");
});

test("Given a material issuer variance, when reconciliation runs, then the card and month are identified without raw transactions", () => {
  const result = buildRewardReconciliationSummary({
    estimates: [{ cardKey: "card-synthetic-travel", month: "2026-01", estimatedUnits: 3_000 }],
    ledgerEntries: [aRewardStatement({ issuerEarnedUnits: 4_000 })],
    selectedMonth: "2026-01",
    tolerance: { units: 25, percent: 1 },
  });

  assert.deepEqual(result.materialMismatches, [{
    cardKey: "card-synthetic-travel",
    month: "2026-01",
    varianceUnits: 1_000,
    variancePercent: 1000 / 3000 * 100,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /transaction|merchant|accountId/i);
});

test("Given issuer-earned units are unknown, when reconciliation runs, then zero is not invented", () => {
  const result = reconcileRewardMonth({
    estimated: { cardKey: "card-synthetic-travel", month: "2026-01", estimatedUnits: 3_000 },
    ledgerEntry: aRewardStatement({ issuerEarnedUnits: undefined }),
  });

  assert.equal(result.issuerEarnedUnits, null);
  assert.equal(result.varianceUnits, null);
  assert.equal(result.status, "estimated-only");
});

test("Given only a current reward balance, when earlier and later history are selected, then the balance never projects backward", () => {
  const entries = [aRewardStatement({ month: "2026-08", asOf: "2026-08-20", endingBalanceUnits: 24_000 })];

  assert.equal(recordedBalanceForMonth(entries, { cardKey: "card-synthetic-travel", selectedMonth: "2026-07" }), null);
  assert.deepEqual(recordedBalanceForMonth(entries, { cardKey: "card-synthetic-travel", selectedMonth: "2026-09" }), {
    endingBalanceUnits: 24_000,
    asOf: "2026-08-20",
    sourceMonth: "2026-08",
  });
});
