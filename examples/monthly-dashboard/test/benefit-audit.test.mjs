import assert from "node:assert/strict";
import test from "node:test";

import { auditBenefitUtilization } from "../src/benefit-audit.js";
import { aBenefitEvidence, aCardBenefit } from "./support/rewards-fixtures.mjs";

test("Given matching summary-safe evidence, when card benefits are audited, then utilization is likely rather than issuer-confirmed", () => {
  const audit = auditBenefitUtilization({ benefits: [aCardBenefit()], selectedMonth: "2026-02", evidence: [aBenefitEvidence()] });
  const february = audit.items.find((item) => item.periodKey === "2026-02");
  assert.equal(february.status, "likely");
  assert.equal(february.usedCents, 1_000);
  assert.equal(audit.likelyCents, 1_000);
  assert.equal(audit.confirmedCents, 0);
});

test("Given no evidence for a closed period, when card benefits are audited, then value is expired-unconfirmed rather than definitely unused", () => {
  const audit = auditBenefitUtilization({ benefits: [aCardBenefit()], selectedMonth: "2026-03" });
  assert.equal(audit.items.find((item) => item.periodKey === "2026-01").status, "expired-unconfirmed");
  assert.equal(audit.items.find((item) => item.periodKey === "2026-03").status, "unconfirmed");
  assert.equal(audit.expiredUnconfirmedCents, 2_000);
  assert.equal(audit.openUnconfirmedCents, 1_000);
});

test("Given a private manual confirmation, when the benefit audit regenerates, then the manual status wins", () => {
  const audit = auditBenefitUtilization({
    benefits: [aCardBenefit()],
    selectedMonth: "2026-01",
    overrides: [{ cardKey: "card-synthetic-travel", benefitKey: "benefit-synthetic-streaming", periodKey: "2026-01", status: "confirmed", usedCents: 800, note: "Synthetic statement checked" }],
  });
  assert.equal(audit.items[0].status, "confirmed");
  assert.equal(audit.items[0].usedCents, 800);
  assert.equal(audit.confirmedCents, 800);
});

test("Given an anniversary benefit without a reset date, when YTD totals are built, then its face value is excluded from countable availability", () => {
  const audit = auditBenefitUtilization({ benefits: [aCardBenefit({ cadence: "anniversary-year", capCents: 30_000, includeInTotals: false })], selectedMonth: "2026-07" });
  assert.equal(audit.availableCents, 0);
  assert.equal(audit.items[0].availableCents, 30_000);
  assert.match(audit.items[0].periodLabel, /anniversary date needed/i);
});

test("Given benefit evidence is prepared for publication, when serialized, then it contains aggregate evidence counts but no tags or raw transaction fields", () => {
  const serialized = JSON.stringify(auditBenefitUtilization({ benefits: [aCardBenefit()], selectedMonth: "2026-02", evidence: [aBenefitEvidence()] }));
  assert.match(serialized, /"evidenceCount":1/);
  assert.doesNotMatch(serialized, /benefit:synthetic-streaming/);
  assert.doesNotMatch(serialized, /accountId|transactionId|memo|payee|merchant/i);
});
