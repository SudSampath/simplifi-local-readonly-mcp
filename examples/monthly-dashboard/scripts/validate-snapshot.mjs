const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const FORBIDDEN_KEYS = new Set([
  "accountId",
  "accountNumber",
  "credential",
  "memo",
  "payee",
  "routingNumber",
  "tags",
  "token",
  "transactionId",
  "transactions",
]);

function walk(value, path = "snapshot") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`${path}.${key} is forbidden in a public summary snapshot.`);
    }
    walk(child, `${path}.${key}`);
  }
}

export function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1) throw new Error("Unsupported snapshot schema version.");
  if (snapshot?.containsRawTransactions !== false) {
    throw new Error("containsRawTransactions must be explicitly false.");
  }
  if (!Array.isArray(snapshot.months) || snapshot.months.length === 0) {
    throw new Error("Snapshot must contain at least one completed month.");
  }

  walk(snapshot);

  let previous;
  for (const month of snapshot.months) {
    if (!MONTH_PATTERN.test(month.month)) throw new Error(`Invalid month ${month.month}.`);
    if (month.complete !== true) throw new Error(`${month.month} is incomplete.`);
    if (previous && month.month <= previous) throw new Error("Months must be unique and ascending.");
    for (const key of ["incomeCents", "outflowCents", "essentialCents", "discretionaryCents"]) {
      if (!Number.isSafeInteger(month[key]) || month[key] < 0) {
        throw new Error(`${month.month}.${key} must be a non-negative integer.`);
      }
    }
    if (month.essentialCents + month.discretionaryCents !== month.outflowCents) {
      throw new Error(`${month.month} spending buckets must equal outflow.`);
    }
    previous = month.month;
  }

  return snapshot;
}
