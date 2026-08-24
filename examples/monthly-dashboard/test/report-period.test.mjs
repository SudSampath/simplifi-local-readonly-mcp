import assert from "node:assert/strict";
import test from "node:test";

import { previousCalendarMonth, reportPeriod } from "../scripts/report-period.mjs";

test("Given a report month, when its period is calculated, then it uses a rolling twelve-month window", () => {
  assert.deepEqual(reportPeriod("2026-08", "2026-09-03"), {
    selectedMonth: "2026-08",
    label: "August 2026",
    from: "2025-09-01",
    to: "2026-08-31",
    asOf: "2026-09-03",
  });
});

test("Given a run date, when no month is supplied, then the prior completed month is available", () => {
  assert.equal(previousCalendarMonth(new Date("2026-09-03T16:00:00Z")), "2026-08");
});

test("Given malformed input, when the period is calculated, then it fails before reading private data", () => {
  assert.throws(() => reportPeriod("August 2026", "2026-09-03"), /Expected YYYY-MM/);
});
