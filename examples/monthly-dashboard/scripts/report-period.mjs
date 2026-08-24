const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const isoDate = (date) => date.toISOString().slice(0, 10);

export function previousCalendarMonth(date = new Date()) {
  return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0))).slice(0, 7);
}

export function reportPeriod(month, asOf = isoDate(new Date())) {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new Error(`Invalid report month "${month}". Expected YYYY-MM.`);
  if (!DATE_PATTERN.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
    throw new Error(`Invalid as-of date "${asOf}". Expected YYYY-MM-DD.`);
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const from = new Date(Date.UTC(year, monthIndex - 11, 1));
  const to = new Date(Date.UTC(year, monthIndex + 1, 0));

  return {
    selectedMonth: month,
    label: new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, monthIndex, 1))),
    from: isoDate(from),
    to: isoDate(to),
    asOf,
  };
}

export function readArguments(argv = process.argv.slice(2)) {
  const valueFor = (name) => {
    const prefix = `--${name}=`;
    const inline = argv.find((argument) => argument.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    month: valueFor("month"),
    asOf: valueFor("as-of"),
    input: valueFor("input"),
  };
}
