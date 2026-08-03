import { describe, expect, test } from "vitest";

import { absCents, addCents, asCents, formatCents, negateCents, sumCents, toCents } from "../../src/money.js";

/**
 * Decimal amounts are not generally exact binary floats. These assertions pin
 * the conversion and the arithmetic that replaced `amount REAL` so repeated
 * operations cannot accumulate float drift.
 */

describe("Given a decimal amount from Simplifi", () => {
  test("When it is converted, then an ordinary two-decimal value becomes exact cents", () => {
    expect(toCents(12.34)).toBe(1234);
    expect(toCents(0)).toBe(0);
    expect(toCents(-45.67)).toBe(-4567);
  });

  test("When the value cannot be represented exactly in binary, then conversion still lands on the right cent", () => {
    // The canonical cases: none of these are exact as IEEE-754 doubles.
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(1e-9)).toBe(0);
    expect(toCents(0.07 * 3)).toBe(21);
  });

  test("When the value sits just under a boundary only because of binary error, then it is not rounded down", () => {
    // 1.005 is the canonical case: the nearest double sits a hair below it, so
    // a naive scale-and-round loses the cent the JSON text actually stated.
    expect(toCents(1.005)).toBe(101);
    expect(toCents(8.615)).toBe(862);
    expect(toCents(-1.005)).toBe(-101);
  });

  test("When the value is genuinely below the half-cent, then it still rounds down", () => {
    // The tolerance must correct representation error without swallowing a real
    // difference, or every amount would round up.
    expect(toCents(1.0049)).toBe(100);
    expect(toCents(0.004)).toBe(0);
    expect(toCents(-1.0049)).toBe(-100);
  });

  test("When the value is a half-cent, then it rounds away from zero symmetrically", () => {
    // Math.round is half-up, so Math.round(-0.5) is -0 while Math.round(0.5) is
    // 1. Under that rule 0.005 and -0.005 round to magnitudes differing by a
    // cent, and a transfer pair stops summing to zero.
    expect(toCents(0.005)).toBe(1);
    expect(toCents(-0.005)).toBe(-1);
    expect(toCents(0.005) + toCents(-0.005)).toBe(0);
  });

  test("When a debit is reversed by its credit, then the pair sums to exactly zero", () => {
    const amounts = [1234.56, 0.01, 0.005, 99999.99, 8.615];

    for (const amount of amounts) {
      expect(addCents(toCents(amount), toCents(-amount))).toBe(0);
    }
  });

  test("When the amount is not finite, then conversion fails rather than producing NaN cents", () => {
    expect(() => toCents(Number.NaN)).toThrow(/non-finite/i);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(/non-finite/i);
  });

  test("When the amount exceeds exact integer range, then conversion fails rather than losing precision", () => {
    expect(() => toCents(Number.MAX_SAFE_INTEGER)).toThrow(/too large/i);
  });
});

describe("Given many amounts summed in cents rather than as floats", () => {
  test("When the same values are summed as floats, then only the float sum drifts", () => {
    const amounts = Array.from({ length: 10_000 }, () => 0.1);

    const floatSum = amounts.reduce((total, value) => total + value, 0);
    const centsSum = sumCents(amounts.map(toCents));

    expect(centsSum).toBe(100_000);
    // The failure this ticket exists to prevent, demonstrated rather than asserted in prose.
    expect(floatSum).not.toBe(1000);
    expect(formatCents(centsSum)).toBe("1000.00");
  });

  test("When a running total is accumulated, then it stays an exact integer throughout", () => {
    const values = [0.07, 0.07, 0.07, 12.34, -0.01, 1.005];
    const total = values.map(toCents).reduce(addCents, 0 as ReturnType<typeof toCents>);

    expect(Number.isSafeInteger(total)).toBe(true);
    expect(total).toBe(7 + 7 + 7 + 1234 - 1 + 101);
  });
});

describe("Given a value read back from the cache", () => {
  test("When it is a whole number of cents, then it is accepted", () => {
    expect(asCents(-4567)).toBe(-4567);
    expect(asCents(0)).toBe(0);
  });

  test("When it is fractional, then it is rejected rather than silently trusted", () => {
    // A REAL column that once held dollars can still contain 12.34 after the
    // column changes type. Trusting it would reintroduce the drift.
    expect(() => asCents(12.34)).toThrow(/not a safe integer/i);
  });
});

describe("Given cents being rendered for a person to read", () => {
  test("When they are formatted, then the result is a decimal string rather than a number", () => {
    expect(formatCents(asCents(1234))).toBe("12.34");
    expect(formatCents(asCents(-4567))).toBe("-45.67");
    expect(formatCents(asCents(0))).toBe("0.00");
    expect(formatCents(asCents(5))).toBe("0.05");
    expect(formatCents(asCents(-5))).toBe("-0.05");
    expect(formatCents(asCents(100))).toBe("1.00");
  });

  test("When a large balance is formatted, then no exponent notation appears", () => {
    expect(formatCents(asCents(79_251_600))).toBe("792516.00");
  });
});

describe("Given the sign helpers", () => {
  test("When a value is negated or absolute, then it stays exact cents", () => {
    expect(negateCents(asCents(-1234))).toBe(1234);
    expect(absCents(asCents(-1234))).toBe(1234);
    expect(absCents(asCents(1234))).toBe(1234);
  });
});
