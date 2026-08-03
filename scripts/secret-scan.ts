/**
 * Commit-time scan for our own financial data.
 *
 * Scope, stated plainly: this stops the reflex mistake — pasting a real response
 * into a fixture, committing an export, leaving a real balance in a README. It is
 * not a defence against anyone determined, and it cannot be. The structural
 * guards are .gitignore and the repo being private; this is the last cheap net
 * before a mistake becomes permanent, because git history outlives every later
 * decision about this repo.
 *
 * **No household-specific value lives in this file.** An earlier version shipped a
 * list of bank names under a comment reading "institution names we bank with" —
 * committing exactly the identifying detail the privacy rule exists to keep out of
 * the repo. The scanner would have leaked what it was built to catch. Institution
 * names now come from `.secret-scan.local.json`, which is gitignored and stays on
 * the operator's machine.
 *
 * The limitation that creates, said out loud: **in a fresh clone or in CI there is
 * no local config, so institution-name detection does not run there.** Only the
 * structural rules do. That is the deliberate trade — a guardrail that works
 * everywhere but leaks, against one that leaks nothing and is weaker in the places
 * the data never is. Account numbers and credentials are caught regardless, and
 * the hook that matters runs on the machine that has the config.
 *
 * Exported as functions so it is testable, with a CLI at the bottom for the
 * pre-commit hook. Run directly:
 *
 *     npx tsx scripts/secret-scan.ts
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Finding {
  file: string;
  line: number;
  rule: string;
  /** The exact text that matched, so an exception can be declared precisely. */
  match: string;
  detail: string;
}

interface Rule {
  name: string;
  pattern: RegExp;
  describe: (match: string) => string;
}

/**
 * Declared exceptions. Matched on file, rule, **and** the exact offending text.
 * Never on a file alone: a whole-file exemption would let a real transaction,
 * account number, or credential pasted into that file bypass both the staged-diff
 * hook and the whole-tree scan.
 *
 * Every entry needs a reason. An undocumented exception is indistinguishable from
 * a leak someone waved through.
 */
export interface Allowance {
  file: string;
  rule: string;
  /**
   * SHA-256 of the exact permitted match, hex. **Not the value itself.**
   *
   * The first attempt at this list stored the literals, and that turned out to be
   * self-defeating twice over: writing an account-number-shaped string into this
   * file made the scanner flag its own source, and the alternative — exempting
   * this file wholesale — is precisely the whole-file hole that review rejected.
   * A digest is exact (no substring slop, one allowance permits one value) and
   * puts nothing sensitive in the repo. `describes` carries the human-readable
   * account of what was allowed.
   */
  matchSha256: string;
  /** What the permitted value is, in prose that cannot itself match a rule. */
  describes: string;
  reason: string;
}

export const ALLOWANCES: Allowance[] = [
  {
    file: ".env.example",
    rule: "credential-literal-env",
    matchSha256: "6a1ecc4b58e9b3ad3e0609afd62ab7b75d9abab1329a70585c567131e818e117",
    describes: "the SIMPLIFI_CLIENT_SECRET assignment in the example env file",
    reason:
      "Quicken's own client secret, extracted from the public Simplifi JS bundle. Not ours, already public, and needed as a default so the server runs without extra configuration.",
  },
  {
    file: ".env.example",
    rule: "account-number-shape",
    matchSha256: "f52c8d67fee7efb959112a57eba8adcd538eb00418d4e902e26af0cc4f0b2830",
    describes: "the placeholder dataset id in the example env file",
    reason: "Inherited from upstream. Structurally a long digit run, not a real identifier.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "account-number-shape",
    matchSha256: "f7811bc64767990e863c17cf5d5304c13754332416636146165e1bc360093964",
    describes: "an invented card-shaped number used as scanner input",
    reason: "Required as input to prove the account-number rule fires. Belongs to no account of ours.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "account-number-shape",
    matchSha256: "bc99b4bf100ad96cc4db80d1f6b724f9d17d0a1c19f011d908ee810fffda7484",
    describes: "an epoch-milliseconds timestamp used as scanner input",
    reason:
      "Pins an accepted false positive, so the rule's known imprecision stays documented rather than rediscovered.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "money-magnitude-in-prose",
    matchSha256: "d8d6054db35ad2822f9c4170b317c62ed71e996b59aec64434d22fe85be447ee",
    describes: "a magnitude written in words, used as scanner input",
    reason:
      "Required as input to prove the prose rule fires. A generic magnitude phrase naming no account and no figure of ours.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "measured-currency-amount",
    matchSha256: "2103c22f55affbb7063b32c86aa0b5717f8c3eebbf90e1d63e651ce1f9b06914",
    describes: "an invented separated amount with odd cents, used as scanner input",
    reason:
      "Required as input to prove the currency rule fires on a total that reads as measured. Invented digits in sequence; corresponds to no figure of ours.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "measured-currency-amount",
    matchSha256: "dac5d2391de8fb2048392132bbb2cafb80d3783919d237bcda4ce7f5ae56d15f",
    describes: "an invented unseparated amount with odd cents, used as scanner input",
    reason:
      "Required as input to prove the rule still fires without a thousands separator, which is the form that would otherwise slip past it.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "account-number-shape",
    matchSha256: "534ffdc0f306796bdf7b2c7d45c36f5f0b2ffacaf41d80a70e45c4373f368ccb",
    describes: "an invented account-shaped number inside a sample unified diff",
    reason: "Required as input to prove diff parsing reports the right file and line.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "credential-literal-env",
    matchSha256: "03ced2dbdad00ef1312b6edfd0809f3a3e2d4c47140cee3154f60e6ec646a368",
    describes: "an invented credential in env-assignment form",
    reason: "Required as input to prove the .env credential rule fires.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "credential-literal-quoted",
    matchSha256: "ca4c40f0332afed26c18305d986ee364e3dca389c4aaeae3a3696c5fdd30c5d5",
    describes: "an invented credential assigned to a quoted string literal",
    reason: "Required as input to prove the quoted-literal credential rule fires.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "dataset-derived-count",
    matchSha256: "6646941dae6e367cabb0067dc5958918edca6eaa332389cee0a8a735384e5ab1",
    describes: "an invented row count used in multiple scanner inputs",
    reason:
      "Required to prove dataset counts are rejected even when no currency amount accompanies them.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "dataset-derived-count",
    matchSha256: "aeb2af0276f904cd2f080688366dae2b4b62369f7846d8f435085a89084f1b16",
    describes: "an invented typed-row count used as scanner input",
    reason:
      "Required to prove a data-type token between the number and row unit does not evade the rule.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "dataset-derived-count",
    matchSha256: "71ae14667f7920ba89086dd26d2f2897c8eb4b9e828aee6a4cef77eed443d7d4",
    describes: "an invented transfer-leg count used as scanner input",
    reason:
      "Required to prove the rule covers relationship counts as well as generic transaction rows.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "dataset-derived-count",
    matchSha256: "7b71951a312fd8016d2d929e88bb23a96dd4d7d6c4d50993005a4468ffac0e42",
    describes: "an invented balance-adjustment count used as scanner input",
    reason:
      "Required to prove a prose category name does not make a household-derived count safe to commit.",
  },
  {
    file: "tests/scripts/secret-scan.test.ts",
    rule: "dataset-derived-boundary",
    matchSha256: "73b16c06d5380c1b9a4a20a6e7946b655d670494c3063e0597aae22945ed45b9",
    describes: "an invented cache coverage date used as scanner input",
    reason:
      "Required to prove a claimed cache boundary is rejected; the date was invented for this assertion.",
  },
];

export function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isAllowed(finding: Finding): boolean {
  const digest = digestOf(finding.match);

  return ALLOWANCES.some(
    (allowance) =>
      allowance.file === finding.file && allowance.rule === finding.rule && allowance.matchSha256 === digest,
  );
}

/**
 * Machine-generated files with no household data in them, excluded from the
 * whole-tree scan. package-lock.json carries integrity hashes whose base64 can
 * contain long digit runs, and nothing about it is ours to leak.
 */
export const UNSCANNED_FILES = new Set(["package-lock.json"]);

/**
 * Values that are obviously not real. Written once and shared by both credential
 * rules so the two cannot drift into disagreeing about what a placeholder is.
 */
const PLACEHOLDER_VALUE = String.raw`(?:your-|your_|replace|change-?me|example|placeholder|dummy|fake|test-|xxx|\.\.\.|\$\{|process\.env|<)`;

export const LOCAL_CONFIG_FILE = ".secret-scan.local.json";

interface LocalConfig {
  /** Institution names to treat as identifying. Never committed. */
  institutions?: string[];
}

/**
 * Read the operator's local, gitignored configuration. Absent in a fresh clone and
 * in CI, which is expected — see the limitation noted at the top of this file.
 */
export function loadLocalInstitutions(repoRoot = path.resolve(import.meta.dirname, "..")): string[] {
  const configPath = path.join(repoRoot, LOCAL_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as LocalConfig;
    return Array.isArray(parsed.institutions) ? parsed.institutions.filter((name) => name.trim().length > 0) : [];
  } catch {
    // A malformed local config must not silently disable the rule it configures.
    process.stderr.write(`secret-scan: ${LOCAL_CONFIG_FILE} exists but could not be parsed; institution rule is off.\n`);
    return [];
  }
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Structural rules only. Nothing here identifies our household, which is what
 * makes all of it safe to commit.
 */
function structuralRules(): Rule[] {
  return [
    {
      name: "account-number-shape",
      // Eight or more consecutive digits: account, routing, or card number shape.
      // Underscored and hyphenated digit groups (ids, dates, versions) do not match.
      pattern: /\b\d{8,}\b/g,
      describe: (match) => `${match.length}-digit run looks like an account or card number`,
    },
    {
      name: "measured-currency-amount",
      // A currency amount whose cents are not `00`.
      //
      // This exists because the file rules never fired on the leak that actually
      // happened: real net totals from the live account were written into source
      // comments to justify a classification rule, and a formatted amount is
      // neither an 8+ digit run nor a credential-shaped literal.
      //
      // Keying on the cents is what makes the rule self-enforcing rather than a
      // list of exceptions. A total measured from a real account carries
      // arbitrary cents; an illustrative stand-in is written round. So the rule
      // permits the convention — round, clearly-labelled amounts — and rejects
      // anything that reads as having been measured.
      //
      // Requiring a thousands separator or four digits keeps the small amounts in
      // money-formatting tests out of it. Those are arithmetic, not disclosure.
      pattern: /\$\s?(?:\d{1,3}(?:,\d{3})+|\d{4,})\.(?!00)\d{2}/g,
      describe: () =>
        "currency amount with non-zero cents reads as a total measured from a real account rather than a round illustrative stand-in",
    },
    {
      name: "money-magnitude-in-prose",
      // The same disclosure written in words instead of digits.
      //
      // `measured-currency-amount` was added first and missed a test header that
      // named a seven-figure sum in words, because there is no currency symbol
      // and no digits at all to key on. A magnitude in prose says the same thing
      // about the size of an account as the figure it stands in for.
      pattern: /\b(?:a|an|\d[\d,.]*)\s+(?:hundred|thousand|million|billion)\s+dollars?\b/gi,
      describe: () => "states the size of an amount in words, which discloses the same thing as the figure",
    },
    {
      name: "dataset-derived-count",
      // Counts and ratios measured from a household dataset are still household
      // data: account composition, history size, and exception frequency can all
      // identify or profile the operator even when every money amount is removed.
      pattern:
        /\b(?:(?:\d{1,3}(?:,\d{3})+|\d+)\s+of\s+(?:\d{1,3}(?:,\d{3})+|\d+)|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?\s+(?:[A-Za-z_`'-]+\s+){0,4}(?:rows|transactions|accounts|entries|legs|charges|adjustments|merchants|categories)|(?:\d{1,3}(?:,\d{3})+|\d+)\s+(?:[A-Za-z_-]+\s+){0,3}against\s+(?:\d{1,3}(?:,\d{3})+|\d+))\b/gi,
      describe: () =>
        "states a dataset count or ratio that could disclose household composition or activity",
    },
    {
      name: "dataset-derived-boundary",
      // A cache start/end date reveals account history even if no transaction is
      // shown. Ordinary synthetic dates remain valid; only prose claiming a real
      // cache boundary is rejected.
      pattern: /\b(?:cache (?:starts|ends) at|running (?:out )?to)\s+\d{4}-\d{2}(?:-\d{2})?\b/gi,
      describe: () => "states a cache coverage boundary that could disclose household history",
    },
    {
      name: "credential-literal-env",
      // A .env-style assignment of a real-looking value to a credential variable.
      // Anchored to a SCREAMING_SNAKE key at the start of a line, which is what a
      // pasted .env looks like and what ordinary source does not.
      pattern: new RegExp(
        String.raw`^\s*[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY)\s*=\s*(?!${PLACEHOLDER_VALUE})\S{8,}`,
        "gm",
      ),
      describe: () => "assigns a real-looking credential in .env syntax rather than a placeholder",
    },
    {
      name: "credential-literal-quoted",
      // A credential assigned a quoted string literal. Requiring quotes is what
      // keeps this off ordinary code: `accessToken: row.access_token` is a property
      // reference, not a secret, and an earlier looser version of this rule flagged
      // 17 such lines across src/ — a scanner that cries wolf gets bypassed, which
      // is strictly worse than no scanner.
      pattern: new RegExp(
        String.raw`\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[=:]\s*["'](?!${PLACEHOLDER_VALUE})[^"'\s]{8,}["']`,
        "gi",
      ),
      describe: () => "assigns a credential-shaped string literal rather than a placeholder",
    },
  ];
}

function institutionRule(institutions: string[]): Rule | undefined {
  if (institutions.length === 0) {
    return undefined;
  }

  // Lookarounds rather than \b. A name ending in a non-word character — "A.B.
  // Savings (Holdings)" — has no word boundary after the final ")", so \b would
  // silently never match it and the rule would appear to work while ignoring
  // exactly the entries someone took the trouble to configure.
  return {
    name: "institution-name",
    pattern: new RegExp(`(?<!\\w)(${institutions.map(escapeForRegex).join("|")})(?!\\w)`, "gi"),
    describe: (match) => `names a financial institution ("${match}")`,
  };
}

export interface ScanOptions {
  /**
   * Institution names to match. Defaults to the operator's local config. Tests
   * pass invented names, which is how this rule stays covered without committing a
   * real one.
   */
  institutions?: string[];
}

/** Scan arbitrary text. `file` is used only for reporting. */
export function scanText(text: string, file = "<input>", startLine = 1, options: ScanOptions = {}): Finding[] {
  const institutions = options.institutions ?? loadLocalInstitutions();
  const rules = structuralRules();
  const optional = institutionRule(institutions);
  if (optional) {
    rules.push(optional);
  }

  const findings: Finding[] = [];

  text.split("\n").forEach((lineText, index) => {
    for (const rule of rules) {
      // Fresh lastIndex per line: a /g regex reused across lines skips matches.
      rule.pattern.lastIndex = 0;
      for (const match of lineText.matchAll(rule.pattern)) {
        const finding: Finding = {
          file,
          line: startLine + index,
          rule: rule.name,
          match: match[0],
          detail: rule.describe(match[0]),
        };

        if (!isAllowed(finding)) {
          findings.push(finding);
        }
      }
    }
  });

  return findings;
}

/**
 * Parse `git diff --cached` output and scan only added lines. Scanning the whole
 * file would flag pre-existing content on every unrelated commit; scanning the
 * diff means the hook complains about what this commit introduces.
 */
export function scanUnifiedDiff(diff: string, options: ScanOptions = {}): Finding[] {
  const findings: Finding[] = [];
  let currentFile = "<unknown>";
  let currentLine = 0;

  for (const rawLine of diff.split("\n")) {
    const fileHeader = /^\+\+\+ b\/(.+)$/.exec(rawLine);
    if (fileHeader?.[1]) {
      currentFile = fileHeader[1];
      continue;
    }

    const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunkHeader?.[1]) {
      currentLine = Number(hunkHeader[1]);
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      findings.push(...scanText(rawLine.slice(1), currentFile, currentLine, options));
      currentLine += 1;
    } else if (!rawLine.startsWith("-") && !rawLine.startsWith("\\")) {
      currentLine += 1;
    }
  }

  return findings;
}

export function formatFindings(findings: Finding[]): string {
  const lines = ["", "Commit rejected: staged changes look like they contain our real financial data.", ""];

  for (const finding of findings) {
    lines.push(`  ${finding.file}:${finding.line}  [${finding.rule}] ${finding.detail}`);
  }

  lines.push(
    "",
    "If this is a false positive, the fix is to make the value obviously synthetic",
    "rather than to bypass the hook. Fixtures should read as invented on sight.",
    "",
  );

  return lines.join("\n");
}

function main(): void {
  // -U0 keeps the diff to added lines only, with no surrounding context to
  // re-flag content that is already committed.
  const diff = execFileSync("git", ["diff", "--cached", "-U0"], { encoding: "utf8" });
  const findings = scanUnifiedDiff(diff);

  if (findings.length > 0) {
    process.stderr.write(formatFindings(findings));
    process.exit(1);
  }
}

// Run only when invoked directly, so importing this from a test does not scan.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
