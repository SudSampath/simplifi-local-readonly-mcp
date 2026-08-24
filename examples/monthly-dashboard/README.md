# Synthetic monthly dashboard

This standalone example captures the reusable part of a monthly household
report without publishing household data. It includes:

- a month picker that defaults to the latest available month;
- month-over-month income, outflow, and net comparisons;
- year-to-date totals through the selected month;
- a rolling twelve-month build boundary; and
- a privacy validator that rejects raw transactions, account identifiers,
  credentials, and incomplete months.

All included values and labels are invented.

## Behavior-driven tests

The example treats its Given/When/Then acceptance criteria as executable
scenarios. Test titles describe the precondition, action, and observable result,
and a contract test prevents new scenarios from drifting to implementation-only
names. Shared rewards fixture builders live under `test/support/`; their values
are visibly synthetic and their serialized shapes exclude private account and
transaction fields.

This uses Node's existing test runner rather than adding a second Cucumber
runtime. The behavior contract is the important part: each acceptance outcome
must have an assertion, and a failed test should name the behavior that broke.

Reward rules are effective-dated, deterministic configuration. The evaluator
supports base and bonus rates, activation requirements, spending caps, explicit
valuations, and verification warnings without fetching issuer websites during a
build. Different reward currencies stay separate rather than being combined
into a misleading household points total.

For a source-backed implementation, store an official issuer URL and a
`verifiedThrough` date on every rule. Use `requiredEvidenceTags` for bonuses that
depend on a booking portal, named merchant, or other fact that a broad spending
category cannot prove. Private adapters may derive tags such as
`portal:synthetic-travel`, but neither payee text nor raw transactions belong in
the generated public summary.

Cards can use either a fixed `valuationCentsPerUnit` or a configurable range:

```js
{
  valuationRangeCentsPerUnit: { low: 1.5, high: 2 },
  valuationLabel: "Household redemption assumption",
}
```

The report keeps low and high values separate. Cash-like currencies should use
a fixed issuer-backed value, and unlike point currencies should never be added
together merely because their unit names both contain “points.” Actual issuer
earnings and balances remain manual reconciliation inputs; transaction-derived
estimates do not imply issuer account access.

Current standard annual fees are configured separately from monthly rewards and
must include integer cents, an official HTTPS source, and a `verifiedThrough`
date. The reusable model keeps a $0 fee explicit, totals each configured card
once, and warns when research is stale. A published product fee is not evidence
that the household paid it in the selected month: legacy agreements, waivers,
retention offers, authorized-user fees, and membership requirements belong in
private configuration or a source caveat.

```js
{
  annualFeeCents: 9500,
  annualFeeSourceUrl: "https://example.invalid/synthetic-card-fees",
  annualFeeVerifiedThrough: "2026-12-31",
  annualFeeCaveat: "A separate synthetic membership is excluded.",
}
```

## Run it

Node.js 22 or newer is the only requirement.

```bash
npm test
npm run report:build
```

Open `dist/index.html` in a browser. The generated page works directly from the
filesystem and does not send data anywhere.

To build a particular completed month:

```bash
npm run report:build -- --month 2026-08 --as-of 2026-09-03
```

The input defaults to `fixtures/snapshot.example.json`. A private integration can
write the same summary shape elsewhere and pass it with `--input`:

```bash
npm run report:build -- --input /private/path/monthly-summary.json
```

## Monthly automation contract

A scheduler should run after the source system has closed the prior month:

1. Refresh the private financial cache.
2. Generate a summary-only JSON file matching the example schema.
3. Run `npm run report:build -- --month YYYY-MM --as-of YYYY-MM-DD --input ...`.
4. Publish only after validation and an explicit review of the generated report.

The public template intentionally does not include a Simplifi adapter, hosting
credentials, authentication, or deployment configuration. Those belong in the
private household project.
