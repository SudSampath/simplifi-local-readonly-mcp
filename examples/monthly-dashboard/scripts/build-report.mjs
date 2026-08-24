import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readArguments, reportPeriod } from "./report-period.mjs";
import { validateSnapshot } from "./validate-snapshot.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = readArguments();
const inputPath = path.resolve(projectRoot, arguments_.input ?? "fixtures/snapshot.example.json");
const snapshot = validateSnapshot(JSON.parse(await readFile(inputPath, "utf8")));
const selectedMonth = arguments_.month ?? snapshot.months.at(-1).month;
const period = reportPeriod(selectedMonth, arguments_.asOf ?? snapshot.generatedAt.slice(0, 10));
const months = snapshot.months.filter((month) => month.month >= period.from.slice(0, 7) && month.month <= selectedMonth);

if (!months.some((month) => month.month === selectedMonth)) {
  throw new Error(`The input does not contain completed month ${selectedMonth}.`);
}
if (months.length > 12) throw new Error("A public build may contain at most twelve months.");

const output = {
  ...snapshot,
  generatedAt: period.asOf,
  selectedMonth,
  months,
};
const dist = path.join(projectRoot, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(projectRoot, "src"), dist, { recursive: true });
await writeFile(
  path.join(dist, "snapshot.js"),
  `window.MONTHLY_REPORT_SNAPSHOT = ${JSON.stringify(output, null, 2)};\n`,
  "utf8",
);

process.stdout.write(`Built ${period.label} with ${months.length} month(s) of synthetic summary data.\n`);
