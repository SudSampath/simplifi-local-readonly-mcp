export const monthLabel = (month, compact = false) => new Intl.DateTimeFormat("en-US", {
  month: compact ? "short" : "long",
  year: compact ? undefined : "numeric",
  timeZone: "UTC",
}).format(new Date(`${month}-15T12:00:00Z`));

export function percentChange(current, previous) {
  if (previous === 0) return current === 0 ? null : Infinity;
  return ((current - previous) / previous) * 100;
}

export function reportView(months, selectedMonth) {
  const selectedIndex = months.findIndex((month) => month.month === selectedMonth);
  if (selectedIndex < 0) throw new Error(`Unknown report month ${selectedMonth}.`);
  const selected = months[selectedIndex];
  const previous = months[selectedIndex - 1];
  const year = selected.month.slice(0, 4);
  const ytdMonths = months.slice(0, selectedIndex + 1).filter((month) => month.month.startsWith(year));
  const sum = (key) => ytdMonths.reduce((total, month) => total + month[key], 0);

  return {
    selected,
    previous,
    monthlyNetCents: selected.incomeCents - selected.outflowCents,
    incomeChangePercent: previous ? percentChange(selected.incomeCents, previous.incomeCents) : null,
    outflowChangePercent: previous ? percentChange(selected.outflowCents, previous.outflowCents) : null,
    ytdIncomeCents: sum("incomeCents"),
    ytdOutflowCents: sum("outflowCents"),
    ytdNetCents: sum("incomeCents") - sum("outflowCents"),
    ytdMonths,
  };
}
