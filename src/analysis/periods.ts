import type { Coverage, IncompleteReason, PeriodStatus, Shortfall } from "./types.js";

/**
 * Calendar months, and whether a figure for one describes all of it.
 *
 * Dates are `YYYY-MM-DD` strings throughout and compared as strings. That is not
 * laziness: ISO dates sort lexicographically, and going through `Date` would
 * introduce a timezone — a local-midnight `Date` for `2026-08-01` is
 * `2026-07-31T…Z` in any timezone west of UTC, which silently moves a
 * transaction into the previous month. The only use of `Date` here is arithmetic
 * on month lengths, done in UTC and converted straight back to a string.
 */

const MONTH = /^(\d{4})-(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertDate(value: string, label: string): string {
  if (!DATE.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD, received: ${value}`);
  }
  return value;
}

/** The `YYYY-MM` a date falls in. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** First and last day of a `YYYY-MM`, inclusive. */
export function monthBounds(month: string): { from: string; to: string } {
  const match = MONTH.exec(month);
  if (!match) {
    throw new Error(`Month must be YYYY-MM, received: ${month}`);
  }

  const year = Number(match[1]);
  const index = Number(match[2]);
  // Day 0 of the next month is the last day of this one, and UTC keeps it there.
  const lastDay = new Date(Date.UTC(year, index, 0)).getUTCDate();

  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/** Every `YYYY-MM` touched by the range, inclusive at both ends. */
export function monthsBetween(from: string, to: string): string[] {
  if (from > to) {
    return [];
  }

  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let index = Number(from.slice(5, 7));
  const last = monthOf(to);

  for (;;) {
    const month = `${String(year).padStart(4, "0")}-${String(index).padStart(2, "0")}`;
    months.push(month);
    if (month >= last) {
      return months;
    }

    index += 1;
    if (index > 12) {
      index = 1;
      year += 1;
    }
  }
}

/**
 * What the cache covers against what was asked for.
 *
 * `cached` is the earliest and latest transaction date at or before the as-of
 * date — history, not the projections that run past it. A range reaching beyond
 * either end is answerable only in part, and saying so is the difference between
 * a low total and a wrong one.
 */
export function describeCoverage(input: {
  requestedFrom: string;
  requestedTo: string;
  cachedEarliest?: string;
  cachedLatest?: string;
  asOf: string;
}): Coverage {
  const shortfalls: Shortfall[] = [];

  if (input.cachedEarliest === undefined || input.cachedLatest === undefined) {
    shortfalls.push({
      kind: "cache-is-empty",
      detail: "The cache holds no dated transaction at or before the as-of date, so every figure below is zero for want of data rather than for want of spending.",
    });

    return {
      requested: { from: input.requestedFrom, to: input.requestedTo },
      covered: {},
      complete: false,
      shortfalls,
    };
  }

  if (input.cachedEarliest > input.requestedFrom) {
    shortfalls.push({
      kind: "cache-starts-after-requested-from",
      detail: `Asked from ${input.requestedFrom}, but the earliest cached transaction is ${input.cachedEarliest}. Nothing before that is counted, because nothing before that is here.`,
    });
  }

  if (input.cachedLatest < input.requestedTo) {
    shortfalls.push({
      kind: "cache-ends-before-requested-to",
      detail: `Asked to ${input.requestedTo}, but the latest cached transaction at or before the as-of date is ${input.cachedLatest}.`,
    });
  }

  if (input.requestedTo > input.asOf) {
    shortfalls.push({
      kind: "requested-range-extends-beyond-as-of",
      detail: `Asked to ${input.requestedTo}, which is after the as-of date ${input.asOf}. Transactions dated later are Simplifi's projections and are excluded rather than counted.`,
    });
  }

  return {
    requested: { from: input.requestedFrom, to: input.requestedTo },
    covered: { from: input.cachedEarliest, to: input.cachedLatest },
    complete: shortfalls.length === 0,
    shortfalls,
  };
}

/**
 * Whether a month's figures describe the whole month.
 *
 * Three ways they may not, all reported: the month begins before the cache does,
 * it ends after the cache does, or it has not finished yet. The last is the one
 * that bites — the current month always looks like a collapse in spending unless
 * the response says it is three days old.
 */
export function periodStatus(month: string, coverage: Coverage, asOf: string): PeriodStatus {
  const bounds = monthBounds(month);
  const reasons: IncompleteReason[] = [];

  if (coverage.covered.from === undefined || coverage.covered.to === undefined) {
    reasons.push("month-starts-before-cache-coverage", "month-ends-after-cache-coverage");
    return { month, from: bounds.from, to: bounds.to, complete: false, incompleteReasons: reasons };
  }

  if (bounds.from < coverage.covered.from) {
    reasons.push("month-starts-before-cache-coverage");
  }

  if (bounds.to > coverage.covered.to) {
    reasons.push("month-ends-after-cache-coverage");
  }

  if (bounds.to > asOf) {
    reasons.push("month-not-finished");
  }

  return { month, from: bounds.from, to: bounds.to, complete: reasons.length === 0, incompleteReasons: reasons };
}
