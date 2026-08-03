/**
 * Money as integer cents, enforced by the type system.
 *
 * Ordinary binary floating point cannot represent many decimal amounts exactly.
 * A value can be individually within a rounding error of correct while repeated
 * arithmetic accumulates drift. `amount REAL` in the schema therefore made every
 * total, average, and min/max filter float arithmetic.
 *
 * `Cents` is a branded number so that a bare `number` cannot be passed where
 * money is expected. That turns "do not use floats for money" from a convention
 * someone has to remember into a compile error. The brand exists only at compile
 * time; at runtime a Cents is an ordinary integer.
 */

declare const CENTS: unique symbol;

export type Cents = number & { readonly [CENTS]: true };

/** Zero, as money. Handy as a reduce seed without casting. */
export const ZERO_CENTS = 0 as Cents;

/**
 * Converts a decimal amount from Simplifi into exact integer cents.
 *
 * Rounding is half-away-from-zero rather than JavaScript's `Math.round`, which
 * is half-up and therefore asymmetric about zero: `Math.round(-0.5)` is `-0`,
 * so -0.005 and 0.005 would round to magnitudes that differ by a cent. For
 * money, a debit and the credit that reverses it must round the same way or a
 * transfer pair stops summing to zero.
 *
 * The tolerance corrects representation error at the scale of the input while
 * preserving genuine sub-cent differences.
 */
export function toCents(amount: number): Cents {
  if (!Number.isFinite(amount)) {
    throw new Error(`Cannot convert a non-finite amount to cents: ${amount}`);
  }

  const scaled = amount * 100;
  const magnitude = Math.abs(scaled);

  // Correct for binary representation error before rounding. The amount arrived
  // as decimal text in JSON, so 1.005 means one dollar and half a cent — but no
  // binary double lands exactly on it, and the nearest one sits a hair below.
  // Scaling therefore falls just under the .5 boundary, and rounding directly
  // gives 100 rather than 101, losing the cent the source actually stated. The
  // representation error scales with magnitude, so the tolerance has to as well:
  // a fixed epsilon would be far too large for small amounts and far too small
  // for a six-figure balance.
  const tolerance = Math.max(magnitude, 1) * Number.EPSILON * 4;
  const rounded = Math.round(magnitude + tolerance);

  if (!Number.isSafeInteger(rounded)) {
    throw new Error(`Amount is too large to represent exactly in cents: ${amount}`);
  }

  return (scaled < 0 ? -rounded : rounded) as Cents;
}

/**
 * Asserts that a value already stored as cents really is an integer.
 *
 * Used at the read boundary. A REAL column that once held dollars can still
 * contain a fractional value after a schema change, and silently trusting it
 * would reintroduce exactly the drift the integer column exists to remove.
 */
export function asCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Value read as cents is not a safe integer: ${value}`);
  }
  return value as Cents;
}

export function addCents(a: Cents, b: Cents): Cents {
  return asCents(a + b);
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return asCents(total);
}

export function negateCents(value: Cents): Cents {
  return (-value) as Cents;
}

export function absCents(value: Cents): Cents {
  return Math.abs(value) as Cents;
}

/**
 * Formats cents as a decimal string. The only place money becomes a decimal.
 *
 * Deliberately returns a string, not a number: handing back `12.34` would put
 * the value straight back into a float and invite it to be summed there.
 */
export function formatCents(value: Cents): string {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
