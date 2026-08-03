# Testing conventions

The project rule: **every PR carries Given/When/Then tests with independently
testable attributes, covering the acceptance criteria of the ticket it closes.**
Each `Then`/`And` in a ticket's AC maps to at least one assertion. An AC with no
assertion means the ticket is not done.

These conventions are asserted, not just described — see `tests/conventions/`.
A convention that is only written down decays.

## Where tests live

All tests live under `tests/`, mirroring `src/`. They are **not** co-located with
source: `tsconfig.json` compiles `src/` → `dist/` with `rootDir: "src"`, so
co-located tests would either ship in the build or need an exclude rule that
drifts out of sync.

```
tests/
  conventions/   the tests that test our tests
  example/       the template to copy when starting a ticket
  support/       setup, fixtures, helpers — no tests
```

Test files end in `.test.ts`. Anything under `support/` is helpers only.

## Naming

```ts
describe("Given <precondition>", () => {
  test("When <action>, then <expected outcome>", () => { ... });
});
```

Nested `describe` blocks add further Given context and start with `"And "`.

The reason is failure output: a CI log reading
`Given a transfer between two of our accounts > When spending is computed, then neither leg is counted`
tells you what broke. A log reading `computeSpending > handles transfers` does
not. This is enforced by `conventions/bdd-naming.test.ts`, which parses the suite
with the TypeScript compiler — so titles must be plain string literals.

## Fixtures are synthetic

Never a real payee, balance, account number, institution name, or transaction —
including in a fixture, a snapshot, or a comment. The privacy rule covers test
data: a value pasted from a real response becomes a real transaction in a git
history that outlives every later decision about this repo.

Build fixtures from `support/fixtures.ts`, overriding only the fields the test is
about. Every fixture file declares `SYNTHETIC` provenance, and
`conventions/fixtures-are-synthetic.test.ts` asserts both that and the absence of
account-number-shaped digit runs.

## The privacy rule is enforced in three places

None of them relies on remembering:

1. **`.gitignore`** — exports, spreadsheets, the SQLite cache, and every `.env`
   except `.env.example`. Deliberately *not* a blanket `*.json`, which would hide
   `package.json`; data-shaped JSON is confined to `exports/`, `out/`, `tmp/`,
   `scratch/`. `conventions/gitignore.test.ts` asserts this by asking
   `git check-ignore` rather than by parsing the file, so git's real precedence
   and negation rules are what get tested.
2. **The pre-commit scanner** (`scripts/secret-scan.ts`) — reads
   `git diff --cached` and rejects added lines that look like an account number, a
   financial institution, or a real credential. It runs *first* in the hook,
   because a type error is fixable in the next commit and a real transaction in
   git history is not removable from clones that already have it.
3. **The whole-tree scan** (`conventions/no-real-data-committed.test.ts`) — the
   hook cannot catch what landed before it existed, and this repo inherited its
   entire history from upstream.

**No household-specific value lives in the repo.** Institution names — which
identify an account as surely as its number does — are read from
`.secret-scan.local.json`, gitignored, on the operator's machine only. See
`.secret-scan.local.example.json` for the format.

The limitation that creates, stated rather than hidden: **in a fresh clone and in
CI there is no local config, so institution-name detection does not run there.**
Only the structural rules do. That is the deliberate trade — a guardrail that
works everywhere but leaks, against one that leaks nothing and is weaker where the
data never is. Account numbers and credentials are caught either way, and the hook
that matters runs on the machine that has the config.

Exceptions live in `ALLOWANCES`, pinned by **SHA-256 of the exact permitted
match** — not by filename, and not by the literal value. Two reasons, both learned
the hard way:

- A whole-file exemption is a hole. A real transaction pasted into an exempt file
  would pass both the hook and the whole-tree scan.
- Storing the literal made the scanner flag its own source, and the only way out
  of that was the whole-file exemption above. A digest permits exactly one string,
  with no substring slop, and puts nothing sensitive in the repo.

Each entry carries a `describes` (what was allowed, in prose that cannot itself
match a rule) and a `reason`. Allowances on `tests/` files are scanner *inputs* — a
rule cannot be proven to fire without feeding it something that matches — so those
are expected; allowances on shipped files are the ones that erode the guardrail and
are held to a tighter budget, asserted at two.

The scanner is tuned against false positives on purpose. An earlier, looser
credential rule flagged 17 ordinary lines across `src/` like
`accessToken: row.access_token`. **A scanner that cries wolf gets bypassed, which
is strictly worse than no scanner** — so those cases are pinned as negative tests.

## No network, no credentials

`support/setup.ts` runs for every test. It replaces `globalThis.fetch` with a
stub that throws, and strips `SIMPLIFI_*` and `OAUTH_*` from the environment.

A test that needs HTTP behavior calls `installFakeFetch()` and asserts on the
recorded requests — which is how the read-only boundary gets tested without
talking to Quicken. That friction is deliberate: reaching for the network should
be a decision, not an accident.

## Negative acceptance criteria are tested as negatives

"No write tool exists" is an assertion over the registered tool list, not a
comment. The same goes for "no non-GET call reaches Quicken" — an allowlist of
`(method, path)` pairs, so a newly added call fails the test until it is
deliberately allowed.

## Commands

| | |
|---|---|
| `npm test` | watch mode |
| `npm test -- --run` | once, as CI and the hook do |
| `npm run typecheck` | typecheck `src/` and `tests/` |
| `npm run setup-hooks` | enable the pre-commit hook (once per clone) |

**This repo uses npm, not yarn, and that is load-bearing.** `better-sqlite3` ships
N-API prebuilt binaries inside its own tarball; npm uses them, while yarn 1
unconditionally runs `node-gyp rebuild` for any package with a `binding.gyp` and
ignores the prebuild — which fails on a machine with no MSVC toolchain and means
the server cannot start at all. `conventions/package-manager.test.ts` asserts
this so it cannot be undone by muscle memory.

The typecheck is `typecheck`, not `check`, which is a leftover from the yarn era
worth keeping: yarn 1 has a builtin `check` that shadowed the script, so
upstream's `"check": "tsc --noEmit"` was verifying `node_modules` and exiting 0 —
it had silently never run. The unambiguous name stays.

`.githooks/pre-commit` runs the typecheck and the suite before every commit. CI
runs the same two commands, so `git commit --no-verify` is caught before merge
rather than never.
