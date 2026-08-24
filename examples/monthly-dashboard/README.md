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
