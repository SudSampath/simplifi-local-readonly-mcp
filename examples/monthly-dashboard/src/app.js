import { monthLabel, reportView } from "./report-model.js";

const snapshot = window.MONTHLY_REPORT_SNAPSHOT;
const money = (cents) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: snapshot.currency,
  maximumFractionDigits: 0,
}).format(cents / 100);
const signedPercent = (value) => value === null
  ? "Baseline"
  : value === Infinity
    ? "New"
    : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

const select = document.querySelector("#month-select");
for (const month of [...snapshot.months].reverse()) {
  const option = document.createElement("option");
  option.value = month.month;
  option.textContent = monthLabel(month.month);
  select.append(option);
}

const requested = new URLSearchParams(location.search).get("month");
const initial = snapshot.months.some((month) => month.month === requested)
  ? requested
  : snapshot.selectedMonth ?? snapshot.months.at(-1).month;

function render(month) {
  const view = reportView(snapshot.months, month);
  select.value = month;
  document.querySelector("#period").textContent = monthLabel(month);
  document.querySelector("#income").textContent = money(view.selected.incomeCents);
  document.querySelector("#outflow").textContent = money(view.selected.outflowCents);
  document.querySelector("#net").textContent = money(view.monthlyNetCents);
  document.querySelector("#income-change").textContent = signedPercent(view.incomeChangePercent);
  document.querySelector("#outflow-change").textContent = signedPercent(view.outflowChangePercent);
  document.querySelector("#ytd-income").textContent = money(view.ytdIncomeCents);
  document.querySelector("#ytd-outflow").textContent = money(view.ytdOutflowCents);
  document.querySelector("#ytd-net").textContent = money(view.ytdNetCents);
  document.querySelector("#as-of").textContent = `Summary generated ${snapshot.generatedAt.slice(0, 10)}`;

  const maximum = Math.max(...view.ytdMonths.flatMap((entry) => [entry.incomeCents, entry.outflowCents]));
  document.querySelector("#trend-rows").replaceChildren(...view.ytdMonths.map((entry) => {
    const row = document.createElement("div");
    row.className = `trend-row${entry.month === month ? " selected" : ""}`;
    row.innerHTML = `
      <strong>${monthLabel(entry.month, true)}</strong>
      <div class="track"><i class="income" style="width:${entry.incomeCents / maximum * 100}%"><span>${money(entry.incomeCents)}</span></i></div>
      <div class="track"><i class="outflow" style="width:${entry.outflowCents / maximum * 100}%"><span>${money(entry.outflowCents)}</span></i></div>
      <small>${money(entry.incomeCents - entry.outflowCents)}</small>`;
    return row;
  }));
}

select.addEventListener("change", () => {
  const url = new URL(location.href);
  url.searchParams.set("month", select.value);
  history.replaceState({}, "", url);
  render(select.value);
});

render(initial);
