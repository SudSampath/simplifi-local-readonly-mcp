import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aRewardCard,
  aRewardPurchase,
  aRewardRule,
  aRewardStatement,
} from "./support/rewards-fixtures.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const BDD_TITLE = /^Given .+, when .+, then .+/;
const PRIVATE_FIELD = /\b(?:accountId|accountNumber|cardNumber|credential|memo|payee|routingNumber|token|transactionId)\b/;

test("Given the monthly dashboard test suite, when test titles are inspected, then every scenario states Given, when, and then behavior", async () => {
  const files = (await readdir(testDirectory)).filter((file) => file.endsWith(".test.mjs"));
  const offenders = [];

  for (const file of files) {
    const source = await readFile(path.join(testDirectory, file), "utf8");
    const titles = [...source.matchAll(/\btest\(\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
    for (const title of titles) {
      if (!BDD_TITLE.test(title)) offenders.push(`${file}: ${title}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("Given rewards behavior needs test data, when fixture builders are used, then their defaults are visibly synthetic and safely overridable", () => {
  const fixture = {
    card: aRewardCard({ displayName: "Synthetic Grocery Card" }),
    purchase: aRewardPurchase({ amountCents: 5_000 }),
    rule: aRewardRule({ unitsPerDollar: 3 }),
    statement: aRewardStatement({ issuerEarnedUnits: 15_000 }),
  };

  assert.match(JSON.stringify(fixture), /synthetic/i);
  assert.equal(fixture.card.displayName, "Synthetic Grocery Card");
  assert.equal(fixture.purchase.amountCents, 5_000);
  assert.equal(fixture.rule.unitsPerDollar, 3);
  assert.equal(fixture.statement.issuerEarnedUnits, 15_000);
});

test("Given committed rewards fixtures, when their serialized shape is inspected, then private account and transaction fields are absent", () => {
  const serialized = JSON.stringify({
    card: aRewardCard(),
    purchase: aRewardPurchase(),
    rule: aRewardRule(),
    statement: aRewardStatement(),
  });

  assert.doesNotMatch(serialized, PRIVATE_FIELD);
});
