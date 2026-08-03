import { describe, expect, test } from "vitest";

import { cadenceForDates, recurringChargeChanges } from "../../src/analysis/index.js";
import type { CachedTransaction } from "../../src/types.js";
import { aCachedTransaction } from "../support/fixtures.js";

/**
 * SUD-16, fifth acceptance criterion: when a recurring charge has gone up, report
 * the before and after amounts with the transactions evidencing each.
 *
 * "It went up by four dollars" is a claim. The two runs of transactions showing
 * the old amount and the new one are what make it checkable, which is the whole
 * reason this returns runs rather than a delta.
 *
 * Fixtures are SYNTHETIC; see support/fixtures.ts.
 */

/** A monthly charge on the 6th, at the given amounts in order, starting January. */
function monthlyCharges(merchant: string, amountsCents: readonly number[], idPrefix: string): CachedTransaction[] {
  return amountsCents.map((amountCents, index) =>
    aCachedTransaction({
      id: `${idPrefix}-${index + 1}`,
      payee: merchant,
      amountCents,
      transactionDate: `2026-${String(index + 1).padStart(2, "0")}-06`,
    }),
  );
}

function report(
  transactions: readonly CachedTransaction[],
  overrides: { minChangeCents?: number; minEstablishedRun?: number } = {},
) {
  return recurringChargeChanges({
    transactions,
    from: "2026-01-01",
    to: "2026-06-30",
    asOf: "2026-07-15",
    cachedEarliest: "2025-01-01",
    cachedLatest: "2026-07-14",
    minChangeCents: overrides.minChangeCents,
    minEstablishedRun: overrides.minEstablishedRun,
  });
}

describe("Given a monthly subscription whose price rose partway through", () => {
  const charges = monthlyCharges("Fictional Llama Streaming", [-999, -999, -999, -1_499, -1_499], "llama");
  const change = report(charges).changes.find((entry) => entry.merchant === "Fictional Llama Streaming");

  test("When the analysis runs, then it identifies the charge as having increased", () => {
    expect(change?.direction).toBe("increased");
    expect(change?.cadence).toBe("monthly");
    expect(change?.changeCents).toBe(500);
    expect(change?.changeFormatted).toBe("5.00");
  });

  test("When it reports the increase, then the before and after amounts are both stated", () => {
    expect(change?.beforeAmountCents).toBe(-999);
    expect(change?.beforeAmountFormatted).toBe("-9.99");
    expect(change?.afterAmountCents).toBe(-1_499);
    expect(change?.afterAmountFormatted).toBe("-14.99");
  });

  test("When it reports the increase, then the transactions evidencing each amount come with it", () => {
    expect(change?.before.transactionIds).toEqual(["llama-1", "llama-2", "llama-3"]);
    expect(change?.after.transactionIds).toEqual(["llama-4", "llama-5"]);
  });

  test("When I re-sum the cited ids, then each run's total is its per-charge amount times its count", () => {
    // Both facts are asserted against the same ids, so a run that cited the
    // wrong transactions could not satisfy them together.
    expect(change?.before.totalCents).toBe(-999 * 3);
    expect(change?.after.totalCents).toBe(-1_499 * 2);
    expect(change?.before.transactionCount).toBe(3);
  });

  test("When it reports the increase, then it says when the new amount first appeared", () => {
    expect(change?.changedOn).toBe("2026-04-06");
    expect(change?.occurrenceCount).toBe(5);
  });
});

describe("Given a monthly subscription whose price fell", () => {
  test("When the analysis runs, then the direction is reported as a decrease rather than as a negative rise", () => {
    const charges = monthlyCharges("Fictional Llama Gym", [-5_000, -5_000, -5_000, -3_000], "gym");
    const change = report(charges).changes[0];

    expect(change?.direction).toBe("decreased");
    expect(change?.changeCents).toBe(-2_000);
  });
});

describe("Given a recurring charge whose amount has never moved", () => {
  test("When the analysis runs, then it is counted as steady rather than listed as a change", () => {
    const charges = monthlyCharges("Fictional Llama Insurance", [-2_500, -2_500, -2_500, -2_500], "ins");
    const result = report(charges);

    expect(result.changes).toEqual([]);
    expect(result.steadyCount).toBe(1);
  });

  test("When a change is smaller than the threshold, then it is treated as steady", () => {
    const charges = monthlyCharges("Fictional Llama Insurance", [-2_500, -2_500, -2_500, -2_501], "ins");
    const result = report(charges, { minChangeCents: 100 });

    expect(result.changes).toEqual([]);
    expect(result.steadyCount).toBe(1);
  });
});

describe("Given a merchant charged on a regular cadence but for a different amount each time", () => {
  // A variable purchase should not make every difference look like a price
  // change. A price has to have held before it can be said to have moved.
  const groceries = monthlyCharges("Fictional Llama Grocer", [-8_112, -9_540, -7_233, -10_004], "gro");

  test("When the analysis runs, then no price change is reported for it", () => {
    expect(report(groceries).changes).toEqual([]);
  });

  test("When the analysis runs, then it is listed as variable rather than dropped without mention", () => {
    expect(report(groceries).variableAmountMerchants).toEqual(["Fictional Llama Grocer"]);
  });

  test("When the established-run threshold is lowered to one, then the variation is reported as a change", () => {
    // The threshold is a judgement about noise, so it is a parameter and the
    // judgement is visible rather than compiled in.
    const result = report(groceries, { minEstablishedRun: 1 });

    expect(result.changes).toHaveLength(1);
    expect(result.variableAmountMerchants).toEqual([]);
  });
});

describe("Given charges to a merchant with no regular spacing", () => {
  test("When the analysis runs, then it is reported as irregular rather than assigned a cadence", () => {
    const charges = [
      aCachedTransaction({ id: "odd-1", payee: "Fictional Llama Hardware", amountCents: -1_000, transactionDate: "2026-01-02" }),
      aCachedTransaction({ id: "odd-2", payee: "Fictional Llama Hardware", amountCents: -1_000, transactionDate: "2026-01-09" }),
      aCachedTransaction({ id: "odd-3", payee: "Fictional Llama Hardware", amountCents: -4_000, transactionDate: "2026-05-30" }),
    ];

    const result = report(charges);

    expect(result.changes).toEqual([]);
    expect(result.irregularMerchants).toEqual(["Fictional Llama Hardware"]);
  });
});

describe("Given a merchant charged only twice", () => {
  test("When the analysis runs with the default threshold, then it is not treated as recurring", () => {
    const charges = monthlyCharges("Fictional Llama Cobbler", [-1_000, -2_000], "cob");
    const result = report(charges);

    expect(result.changes).toEqual([]);
    expect(result.irregularMerchants).toEqual([]);
    expect(result.steadyCount).toBe(0);
  });
});

describe("Given a recurring deposit rather than a charge", () => {
  test("When the analysis runs, then a raise is not reported alongside price rises", () => {
    const income = monthlyCharges("Fictional Llama Payroll", [250_000, 250_000, 250_000, 275_000], "pay");
    const result = report(income);

    expect(result.changes).toEqual([]);
  });
});

describe("Given an outflow that carries no payee at all", () => {
  test("When the analysis runs, then it is reported as unattributable rather than grouped under a wrong name", () => {
    const orphan = aCachedTransaction({
      id: "nameless",
      payee: undefined,
      renamedPayee: undefined,
      mlInferredPayee: undefined,
      amountCents: -1_200,
      transactionDate: "2026-03-03",
    });

    const undetermined = report([orphan]).undetermined.find((entry) => entry.what.includes("merchant"));

    expect(undetermined?.transactionIds).toEqual(["nameless"]);
  });
});

describe("Given a merchant Simplifi has renamed", () => {
  test("When charges are grouped, then the renamed payee is what they group under", () => {
    const charges = monthlyCharges("raw name from the bank", [-999, -999, -1_299], "ren").map((transaction) => ({
      ...transaction,
      renamedPayee: "Fictional Llama Streaming",
    }));

    expect(report(charges).changes[0]?.merchant).toBe("Fictional Llama Streaming");
  });
});

describe("Given a set of dates spaced at a known interval", () => {
  test("When the cadence is derived, then the interval is named rather than guessed at", () => {
    expect(cadenceForDates(["2026-01-06", "2026-02-06", "2026-03-06"])).toBe("monthly");
    expect(cadenceForDates(["2026-01-06", "2026-01-13", "2026-01-20"])).toBe("weekly");
    expect(cadenceForDates(["2025-01-06", "2026-01-06", "2027-01-06"])).toBe("annual");
    expect(cadenceForDates(["2026-01-06", "2026-04-06", "2026-07-06"])).toBe("quarterly");
    expect(cadenceForDates(["2026-01-06", "2026-01-08", "2026-06-01"])).toBeUndefined();
  });
});
