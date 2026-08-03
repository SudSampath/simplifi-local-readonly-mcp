/**
 * The analysis layer's public surface.
 *
 * Everything here is a plain typed function over cached transactions. Nothing in
 * this directory imports the database, the Simplifi client, or the MCP SDK, and
 * nothing needs a server running to be called — which is the point. The app and
 * an agent reach the same numbers by calling the same functions, rather than by
 * two implementations that agree today.
 */

export { classifySpending, partitionSpending, amountCentsOf } from "./classify.js";
export type { SpendingClassification, SpendingPartition } from "./classify.js";

export { assertDate, describeCoverage, monthBounds, monthOf, monthsBetween, periodStatus } from "./periods.js";

export { monthlyBurn, spendingByCategoryByMonth, traceFigure } from "./spending.js";
export type { AnalysisInput, CategoryAnalysisInput } from "./spending.js";

export { cadenceForDates, recurringChargeChanges } from "./recurring.js";
export type { RecurringAnalysisInput } from "./recurring.js";

export type * from "./types.js";
