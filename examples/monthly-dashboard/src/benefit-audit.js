const CALENDAR_CADENCES = new Set(["monthly", "quarterly", "semiannual", "calendar-year"]);

function monthEnd(month) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function windowForMonth(benefit, month) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const two = (value) => String(value).padStart(2, "0");
  if (benefit.cadence === "monthly") return { key: month, start: `${month}-01`, end: monthEnd(month), label: month };
  if (benefit.cadence === "quarterly") {
    const quarter = Math.floor((monthNumber - 1) / 3);
    const startMonth = quarter * 3 + 1;
    return { key: `${year}-Q${quarter + 1}`, start: `${year}-${two(startMonth)}-01`, end: monthEnd(`${year}-${two(startMonth + 2)}`), label: `Q${quarter + 1} ${year}` };
  }
  if (benefit.cadence === "semiannual") {
    const half = monthNumber <= 6 ? 1 : 2;
    return { key: `${year}-H${half}`, start: `${year}-${half === 1 ? "01" : "07"}-01`, end: `${year}-${half === 1 ? "06-30" : "12-31"}`, label: `${half === 1 ? "Jan–Jun" : "Jul–Dec"} ${year}` };
  }
  if (benefit.cadence === "calendar-year") return { key: String(year), start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
  return { key: `${year}-${benefit.cadence}`, start: `${year}-01-01`, end: `${year}-12-31`, label: benefit.cadence === "anniversary-year" ? "Cardmember year · anniversary date needed" : "Manual eligibility period" };
}

function windowsThrough(benefit, selectedMonth) {
  const windows = new Map();
  const year = selectedMonth.slice(0, 4);
  for (let index = 1; index <= Number(selectedMonth.slice(5, 7)); index += 1) {
    const month = `${year}-${String(index).padStart(2, "0")}`;
    const window = windowForMonth(benefit, month);
    if (benefit.effectiveFrom <= window.end && (!benefit.effectiveTo || benefit.effectiveTo >= window.start)) windows.set(window.key, window);
  }
  return [...windows.values()];
}

function validateBenefit(benefit) {
  if (!benefit.key || !benefit.cardKey || !benefit.name) throw new Error("A benefit requires key, cardKey, and name.");
  if (!Number.isSafeInteger(benefit.capCents) && benefit.capCents !== null) throw new Error(`${benefit.key}.capCents must be an integer or null.`);
  if (!benefit.sourceUrl?.startsWith("https://")) throw new Error(`${benefit.key}.sourceUrl must be HTTPS.`);
  if (!benefit.verifiedThrough) throw new Error(`${benefit.key}.verifiedThrough is required.`);
  return benefit;
}

/**
 * Audit summary-safe benefit evidence. A private adapter should convert local
 * transactions or issuer confirmations into evidence tags before calling this.
 * Raw merchants, account identifiers, and transaction identifiers do not
 * belong in the public report contract.
 */
export function auditBenefitUtilization({ benefits, selectedMonth, evidence = [], overrides = [] }) {
  const selectedEnd = monthEnd(selectedMonth);
  const items = benefits.map(validateBenefit).flatMap((benefit) => windowsThrough(benefit, selectedMonth).map((window) => {
    const matchingEvidence = evidence.filter((event) => event.cardKey === benefit.cardKey
      && event.occurredOn >= window.start
      && event.occurredOn <= window.end
      && event.occurredOn <= selectedEnd
      && event.tags.includes(benefit.evidenceTag));
    const observedCents = matchingEvidence.reduce((sum, event) => sum + event.valueCents, 0);
    const override = overrides.find((item) => item.cardKey === benefit.cardKey && item.benefitKey === benefit.key && item.periodKey === window.key);
    const likelyUsedCents = benefit.capCents === null ? null : Math.min(benefit.capCents, observedCents);
    const expired = CALENDAR_CADENCES.has(benefit.cadence) && window.end < selectedEnd;
    const status = override?.status ?? (matchingEvidence.length > 0 ? "likely" : expired ? "expired-unconfirmed" : "unconfirmed");
    const usedCents = status === "confirmed" ? (override.usedCents ?? likelyUsedCents) : status === "likely" ? likelyUsedCents : 0;
    const countable = benefit.includeInTotals !== false && CALENDAR_CADENCES.has(benefit.cadence);
    return {
      benefitKey: benefit.key,
      cardKey: benefit.cardKey,
      name: benefit.name,
      cadence: benefit.cadence,
      periodKey: window.key,
      periodLabel: window.label,
      availableCents: benefit.capCents,
      countableAvailableCents: countable ? benefit.capCents : null,
      usedCents,
      evidenceCount: matchingEvidence.length,
      status,
      sourceUrl: benefit.sourceUrl,
      verifiedThrough: benefit.verifiedThrough,
      instructions: benefit.instructions,
      ...(benefit.valueLabel ? { valueLabel: benefit.valueLabel } : {}),
      ...(override?.note ? { note: override.note } : {}),
    };
  }));
  const countable = items.filter((item) => item.countableAvailableCents !== null);
  return {
    selectedMonth,
    availableCents: countable.reduce((sum, item) => sum + item.countableAvailableCents, 0),
    confirmedCents: countable.filter((item) => item.status === "confirmed").reduce((sum, item) => sum + item.usedCents, 0),
    likelyCents: countable.filter((item) => item.status === "likely").reduce((sum, item) => sum + item.usedCents, 0),
    openUnconfirmedCents: countable.filter((item) => item.status === "unconfirmed").reduce((sum, item) => sum + item.countableAvailableCents, 0),
    expiredUnconfirmedCents: countable.filter((item) => item.status === "expired-unconfirmed").reduce((sum, item) => sum + item.countableAvailableCents, 0),
    items,
  };
}
