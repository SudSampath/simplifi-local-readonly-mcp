# Simplifi Local Read-Only MCP

An unofficial, local MCP server for exploring your Quicken Simplifi data with an
MCP host such as Claude Desktop or Codex. It runs as a subprocess over stdio,
keeps a SQLite cache on your machine, and exposes **read-only** finance tools.

This is designed for a single person analysing their own finances—not for
hosting on the internet, sharing one account with other people, or letting an
agent change financial records.

> Quicken and Simplifi are trademarks of their respective owners. This project
> is independent and is not affiliated with, endorsed by, or supported by
> Quicken.

## Why this exists

The original project this work builds on supported an HTTP service, downstream
OAuth, and write operations. That is useful for a hosted application, but it is
the wrong default for a personal finance assistant: it enlarges the attack
surface and lets an accidental or adversarial prompt alter real records.

This version makes different choices:

- **Local only.** It speaks JSON-RPC over stdin/stdout and opens no network
  listener. Your MCP host starts it as a local child process.
- **Read-only by construction.** The source contains no transaction-update or
  categorisation tools, and the Simplifi client has no write request path.
- **Operator-only authentication.** A single terminal command performs first
  login and handles MFA. MCP tools cannot trigger login, submit an MFA code, or
  wait for a TTY.
- **Local data ownership.** Credentials, tokens, and cached transactions stay
  in your local `.env` and SQLite cache. They are ignored by Git.
- **Guardrails that run in CI.** Tests enforce the read-only boundary, use only
  synthetic fixtures, block ambient network access, and scan committed content
  for common financial-data and credential mistakes.

These choices are deliberate tradeoffs. If you need a shared or hosted service,
or need to edit transactions, this project is not the right tool.

## What it can do

All 17 MCP tools are reads. Nothing here can create, modify, or delete a record.

**Accounts and balances**

| Tool | What it returns |
| --- | --- |
| `list_accounts` | Accounts with balances. `valueCents` is the canonical signed current value and `valueSource` identifies where it came from; other `*Cents` fields preserve raw balance variants, and `*Formatted` strings are display-only. |
| `net_worth` | Current net worth from canonical signed account values. Returns every included account **and every exclusion**, so the total is traceable. Closed, ignored, and valueless accounts are excluded. |

**Spending analysis**

| Tool | What it returns |
| --- | --- |
| `spending_by_category` | Spending by category by calendar month, with the transaction ids behind every figure. Transfers, balance adjustments, investment activity, and future-dated projections are excluded and reported separately. Defaults to the last twelve months. |
| `monthly_burn` | Money out, money in, and the net by month, with the transaction ids behind every figure. The average covers complete months only — a month still in progress is reported as incomplete and left out of it. |
| `recurring_charge_changes` | Recurring charges whose amount changed, largest rise first, with the transactions evidencing the old and new amounts. Groups outflows by merchant and infers cadence from spacing. Merchants that cost something different every time are listed separately rather than reported as changes. |

**Bills and statements**

| Tool | What it returns |
| --- | --- |
| `list_credit_card_statements` | Credit accounts with a statement, soonest due first, with amount due, minimum payment, and anything past due. |
| `list_upcoming_bills` | Scheduled bills, subscriptions, and transfers due in a date range, soonest first. Omitting `from` returns everything scheduled, including past due dates. |

**Transactions**

| Tool | What it returns |
| --- | --- |
| `list_transactions` | Cached transactions with optional filters and pagination. |
| `search_transactions` | Cached transactions matching text, with optional filters. |
| `get_transaction` | A single transaction by id, syncing on a cache miss. |
| `list_uncategorized_transactions` | Transactions that look uncategorized. |

**Reference data**

| Tool | What it returns |
| --- | --- |
| `list_categories` / `search_categories` | Simplifi categories. |
| `list_tags` / `search_tags` | Simplifi tags. |
| `search_merchants` | Merchants (payee names) with frequency counts. |
| `suggest_categories_for_merchant` | Likely categories for a merchant, based on your own transaction history. |

The server keeps an incremental local cache of accounts, transactions,
categories, and tags. The first query that needs data performs a full sync;
later queries use fresh cached data and sync as needed.

Every analysis tool returns the transaction ids behind its numbers, so any
figure an assistant reports back to you can be checked against the source rows.

## Requirements

- Node.js 22 or newer
- npm
- A Quicken Simplifi account

## Setup

### 1. Install

**Clone and build** — this is the path that works today:

```bash
git clone https://github.com/SudSampath/simplifi-local-readonly-mcp.git
cd simplifi-local-readonly-mcp
npm install
npm run build
```

Worth doing regardless: reading the code before handing it your banking
credentials is a reasonable thing to want, and this is a small enough project to
actually do it.

**Installing from npm** is supported by the package, but nothing is published
yet — `npm install -g simplifi-local-readonly-mcp` will not resolve until a
release exists. Once it does, it puts two commands on your PATH,
`simplifi-local-readonly-mcp` (the server) and `simplifi-local-readonly-mcp-auth`
(the one-time login), with nothing to build.

Installing straight from GitHub does **not** work, and deliberately so: this
project sets `ignore-scripts=true` so that `better-sqlite3` uses its shipped
prebuilt binary instead of attempting a `node-gyp` build, and that same setting
stops npm from building `dist/` during a git install.

### 2. Create your `.env`

Where this file goes depends on how you installed:

| How you installed | Where `.env` and the cache live |
| --- | --- |
| Installed as a package | `~/.simplifi-local-readonly-mcp/` |
| Cloned the repository | the repository directory |
| Either, with `SIMPLIFI_MCP_HOME` set | wherever that points |

An installed package lives under a directory npm manages and may prune, so
configuration and cached data are deliberately kept outside it — otherwise your
cache would vanish on an unrelated `npm` operation.

If you installed the package, create that directory and copy the template into
it:

```bash
mkdir -p ~/.simplifi-local-readonly-mcp
cp "$(dirname "$(readlink -f "$(which simplifi-local-readonly-mcp)")")/../.env.example" \
   ~/.simplifi-local-readonly-mcp/.env
```

If that path lookup is awkward on your system, just create
`~/.simplifi-local-readonly-mcp/.env` by hand — the variables are listed below,
and anything you omit is reported by name on first run.

If you cloned, copy it in place:

```bash
cp .env.example .env
```

On PowerShell, use `Copy-Item .env.example .env`.

Set `SIMPLIFI_MCP_HOME` to override the location in either case.

### 3. Fill in `.env`

Three values are yours and must be set:

| Variable | Where it comes from |
| --- | --- |
| `SIMPLIFI_EMAIL` | Your Simplifi login email |
| `SIMPLIFI_PASSWORD` | Your Simplifi password |
| `SIMPLIFI_DATASET_ID` | See below — it is not shown anywhere in the Simplifi UI |

`SIMPLIFI_CLIENT_ID` and `SIMPLIFI_CLIENT_SECRET` are the Simplifi web
application's own public client credentials and are already filled in. They are
not personal to you.

`SIMPLIFI_THREAT_METRIX_SESSION_ID` is **optional**. If you leave it empty the
server generates a random session id per login, which is usually fine. Set it
only if authentication fails in a way that suggests device fingerprinting is
being rejected.

#### Finding your `SIMPLIFI_DATASET_ID`

Simplifi identifies your household's dataset with a header on every API call,
and does not display it in the UI. To read it off a live session:

1. Sign in to <https://simplifi.quicken.com> in a desktop browser.
2. Open developer tools (`F12`) and select the **Network** tab.
3. Reload the page, then click any request to `services.quicken.com`.
4. In **Request Headers**, find `qcs-dataset-id`. Its value — a long number —
   is your dataset id.

Paste it into `.env` as `SIMPLIFI_DATASET_ID`.

### 4. Authenticate once, in a terminal

If you installed the package:

```bash
simplifi-local-readonly-mcp-auth
```

If you cloned:

```bash
npm run auth
```

If Simplifi asks for MFA, enter the code at this prompt. The command stores
access and refresh tokens in the local cache.

This is the only command that can log in. The MCP server uses stored tokens
only — it never falls back to a password login and never prompts through stdio,
so an unattended sync can't trigger an MFA request or a login attempt. If a
token expires or is revoked, tools return an error telling you to run it again.

### 5. Connect your MCP host

The server runs as a local subprocess.

**If you installed the package**, point your host at the command name:

```json
{
  "mcpServers": {
    "simplifi": {
      "command": "simplifi-local-readonly-mcp"
    }
  }
}
```

Some hosts do not resolve PATH the way your shell does. If the server does not
start, use the absolute path that `which simplifi-local-readonly-mcp` (or
`Get-Command` on PowerShell) reports.

**If you cloned**, use an **absolute path** to `dist/index.js`. Relative paths
will not resolve, because your MCP host does not start in that directory.

**Claude Desktop** — edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "simplifi": {
      "command": "node",
      "args": ["/absolute/path/to/simplifi-local-readonly-mcp/dist/index.js"]
    }
  }
}
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.simplifi]
command = "node"
args = ["/absolute/path/to/simplifi-local-readonly-mcp/dist/index.js"]
```

Restart the host. No URL, browser redirect, or server-side OAuth configuration
is involved.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Tools report expired or revoked credentials | Run the auth command again in a terminal (`simplifi-local-readonly-mcp-auth`, or `npm run auth` in a clone). The server cannot re-authenticate on its own by design. |
| `Cannot sign in while another process holds the cache` | One process at a time may write the cache. Quit the MCP host (or the other terminal) and retry. |
| Authentication fails repeatedly with valid credentials | Confirm `SIMPLIFI_DATASET_ID` is correct. If it still fails, capture a real `SIMPLIFI_THREAT_METRIX_SESSION_ID` the same way you found the dataset id. |
| Host shows no tools | Installed: your host may not resolve PATH — use the absolute path from `which simplifi-local-readonly-mcp`. Cloned: check the path is absolute, points at `dist/index.js`, and that `npm run build` has been run. |
| Config seems to be ignored | The server reads `.env` from its home directory, not your working directory. Run the server with no configuration and it prints the exact path it is looking in. Set `SIMPLIFI_MCP_HOME` to point somewhere else. |
| Cached data disappears between runs | You are probably running via `npx`, which re-fetches into a temporary directory. Install with `npm install -g`, or set `SIMPLIFI_MCP_HOME` to a stable path. |
| Empty or stale results | The first query performs a full sync and can take a while. Most tools accept `refresh: true` to force a re-sync. The exceptions are `spending_by_category`, `monthly_burn`, `recurring_charge_changes`, and `search_merchants`, which read whatever the cache already holds — call a tool that does accept `refresh` first if you need those recomputed against fresh data. |

## Safety model

The important boundaries are tested rather than documented only:

| Boundary | How it is enforced |
| --- | --- |
| No record changes | Snapshot of registered MCP tools and an allowlist of Simplifi request methods/paths |
| No login from MCP | Server-side token access cannot call the credential-login path |
| No accidental network in tests | Global `fetch` is blocked unless a test explicitly installs a fake |
| No real household data in tests | Synthetic-fixture and whole-tree privacy checks |
| One process per cache | A local cache lease prevents competing MCP hosts or auth commands |

No software can guarantee the behavior of an upstream service or protect data
after you give another local process access to your account. Review the code,
protect `.env` and the cache file, and use this at your own risk.

## Development

```bash
npm run typecheck
npm test -- --run
npm run build
```

The repository uses Given/When/Then test names and expects every acceptance
criterion to have an executable assertion. Run `npm run setup-hooks` once to
enable the matching pre-commit checks locally.

## Privacy when contributing

Never commit `.env`, SQLite caches, exports, screenshots, transaction samples,
or real merchant/institution names. Fixtures must be synthetic. The repository
includes a local-only institution-name scanner configuration template at
`.secret-scan.local.example.json`; copy it to the gitignored
`.secret-scan.local.json` and populate it only on your machine.

## License and provenance

This project is based on
[krconv/quicken-simplifi-mcp](https://github.com/krconv/quicken-simplifi-mcp)
and is released under the same MIT license, which is retained in full in
[LICENSE](LICENSE) along with the original copyright attribution.
