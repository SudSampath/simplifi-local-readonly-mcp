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
- **Operator-only authentication.** `npm run auth` is the one terminal command
  that can perform first login and handle MFA. MCP tools cannot trigger login,
  submit an MFA code, or wait for a TTY.
- **Local data ownership.** Credentials, tokens, and cached transactions stay
  in your local `.env` and SQLite cache. They are ignored by Git.
- **Guardrails that run in CI.** Tests enforce the read-only boundary, use only
  synthetic fixtures, block ambient network access, and scan committed content
  for common financial-data and credential mistakes.

These choices are deliberate tradeoffs. If you need a shared or hosted service,
or need to edit transactions, this project is not the right tool.

## What it can do

All MCP tools are reads:

- `list_transactions`, `search_transactions`, and `get_transaction`
- `list_uncategorized_transactions`
- `search_merchants`
- `list_categories` and `search_categories`
- `list_tags` and `search_tags`
- `suggest_categories_for_merchant`

The server keeps an incremental local cache of transactions, categories, and
tags. The first query that needs data performs a full sync; later queries use
fresh cached data and sync as needed.

## How authentication works

1. Copy `.env.example` to `.env` and set the required Simplifi values.
2. Run `npm run auth` directly in a terminal. If Simplifi asks for MFA, enter
   the code there.
3. The command stores access and refresh tokens in the local cache.
4. Start the MCP server. It uses stored tokens only; it never falls back to a
   password login or prompts through stdio.

If a token is expired or revoked, the server explains that you need to run
`npm run auth` again. This avoids unattended background syncs requesting MFA
codes or sending repeated login attempts.

## Requirements

- Node.js 22 or newer
- npm
- A local Quicken Simplifi account and the account values required in `.env`

## Setup

Install dependencies:

```bash
npm install
```

Create the local configuration:

```bash
cp .env.example .env
```

On PowerShell:

```powershell
Copy-Item .env.example .env
```

At minimum, set these values in `.env`:

- `SIMPLIFI_EMAIL`
- `SIMPLIFI_PASSWORD`
- `SIMPLIFI_DATASET_ID`
- `SIMPLIFI_THREAT_METRIX_SESSION_ID` (recommended and required by the current
  Simplifi authorization flow)

Complete the one-time interactive login:

```bash
npm run auth
```

Build the server:

```bash
npm run build
```

Configure your MCP host to run:

```text
node /absolute/path/to/dist/index.js
```

The host-specific part is only the executable path and arguments. No URL,
browser redirect, or server-side OAuth configuration is needed.

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

This project is based on [krconv/quicken-simplifi-mcp](https://github.com/krconv/quicken-simplifi-mcp)
and retains its MIT license. The public release should preserve the license and
attribution.
