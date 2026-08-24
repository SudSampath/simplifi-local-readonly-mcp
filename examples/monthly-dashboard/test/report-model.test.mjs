import assert from "node:assert/strict";
import test from "node:test";

import { reportView } from "../src/report-model.js";

const months = [
  { month: "2026-01", incomeCents: 800000, outflowCents: 600000 },
  { month: "2026-02", incomeCents: 880000, outflowCents: 630000 },
];

test("Given a selected month, when trends are calculated, then MoM and YTD use only months through the selection", () => {
  const result = reportView(months, "2026-02");
  assert.equal(result.incomeChangePercent, 10);
  assert.equal(result.outflowChangePercent, 5);
  assert.equal(result.ytdIncomeCents, 1680000);
  assert.equal(result.ytdOutflowCents, 1230000);
  assert.equal(result.ytdNetCents, 450000);
});

test("Given January, when trends are calculated, then it is the month-over-month baseline", () => {
  const result = reportView(months, "2026-01");
  assert.equal(result.previous, undefined);
  assert.equal(result.incomeChangePercent, null);
});
