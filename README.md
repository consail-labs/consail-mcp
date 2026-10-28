# Consail MCP

Governed [Model Context Protocol](https://modelcontextprotocol.io) server for [Consail](https://consail.com).

> **Agents connect to Consail. They never get the database password.**

Phase A ships a **local stdio** server for **Cursor** and **Claude Desktop**. Tools are registered only for capabilities on the identity. A hosted or CI process sets `CONSAIL_CLIENT_ID` (the client UUID) and `CONSAIL_CLIENT_SECRET` (`consailc_`). Those are exchanged at `POST /oauth/token`. Tool calls send the access token, not the secret. The client is bound to one environment, so this process does not send `X-Consail-Environment`. A user `consail_*` key is rejected at startup. With no secret, local stdio reads the CLI credential file (the same lock `consail login` uses) and sends that user access token.

Public hosted origin will be **`https://mcp.consail.com`** (Phase B — not implemented in this package yet).

## Phase A tools

`status` and `env_list` are registered for any live client. The others are registered only when the startup identity includes the capability. Arguments cannot add a dataset, a pipeline, or an environment.

| Tool | Needs | Consail API |
|------|-------|-------------|
| `status` | live identity | client: `GET /api/v1/auth/client`; user: `GET /api/v1/auth/me`. Bound env + stats when the identity has an environment |
| `env_list` | live client | `GET /api/v1/environments` (bound environment only) |
| `catalog_list` | `dataset_read` | `GET /api/v1/catalogs` |
| `dataset_list` | `dataset_read` | `GET /api/v1/datasets` |
| `dataset_get` | `dataset_read` | `GET /api/v1/datasets/{id}` |
| `dataset_preview` | `dataset_read` | `GET /api/v1/datasets/{id}/preview?rows=` (default **50**, hard cap **5000**) |
| `action_list` | any grant | `GET /api/v1/actions` |
| `pipeline_get` | `pipeline_read` | `GET /api/v1/pipelines/{id}` |
| `pipeline_validate` | `pipeline_read` | `POST /api/v1/pipelines/validate` |
| `ask` | `ask` | `POST /api/v1/ask` with `mode: sql_only` only |

`ask` takes a question and an optional subset of granted dataset ids. It has no SQL argument and no `execute` mode.

**Never exposed:** raw SQL, query explorer, `secret_get`, API-client management, deletes, writes. `pipeline_run` / `run_get` stay Phase C and need the `pipeline_run` grant.

## Requirements

- Node.js **22.12+**
- A Consail instance (local, staging, or prod API)
- An API client id and secret (`consailc_`), or a CLI session from `consail login`. User `consail_*` keys are rejected. The secret is exchanged for an access token and is not sent on tool calls.

## Install / run locally

```bash
git clone https://github.com/consail-labs/consail-mcp.git
cd consail-mcp
npm install
npm run build
```

### Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `CONSAIL_URL` | yes | Consail API base URL (e.g. `http://localhost:8080` or `https://api.consail.dev`) |
| `CONSAIL_CLIENT_ID` | with a secret | API client UUID |
| `CONSAIL_CLIENT_SECRET` | or a CLI session | API client secret. Must start with `consailc_`. Exchanged at `POST /oauth/token`. Not written to the CLI credential file |
| `CONSAIL_TIMEOUT_MS` | no | Per-request timeout (default `30000`) |

Copy `.env.example` if useful — the MCP host should inject env vars into the server process (do not commit real keys).

```bash
export CONSAIL_URL=http://localhost:8080
export CONSAIL_CLIENT_ID=00000000-0000-0000-0000-000000000000
export CONSAIL_CLIENT_SECRET=consailc_your_secret
npm start
```

`npm start` speaks **MCP over stdio** (stdout is the protocol channel; logs go to stderr).

## Cursor config

Add to Cursor MCP settings (JSON), pointing at the built entrypoint:

```json
{
  "mcpServers": {
    "consail": {
      "command": "node",
      "args": ["/absolute/path/to/consail-mcp/dist/index.js"],
      "env": {
        "CONSAIL_URL": "http://localhost:8080",
        "CONSAIL_CLIENT_ID": "00000000-0000-0000-0000-000000000000",
        "CONSAIL_CLIENT_SECRET": "consailc_your_secret"
      }
    }
  }
}
```

Or via `npx` after publish:

```json
{
  "mcpServers": {
    "consail": {
      "command": "npx",
      "args": ["-y", "@consail-labs/consail-mcp"],
      "env": {
        "CONSAIL_URL": "https://api.consail.dev",
        "CONSAIL_CLIENT_ID": "00000000-0000-0000-0000-000000000000",
        "CONSAIL_CLIENT_SECRET": "consailc_your_secret"
      }
    }
  }
}
```

## Claude Desktop config

Edit Claude Desktop config (`claude_desktop_config.json`):

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "consail": {
      "command": "node",
      "args": ["C:\\\\absolute\\\\path\\\\to\\\\consail-mcp\\\\dist\\\\index.js"],
      "env": {
        "CONSAIL_URL": "http://localhost:8080",
        "CONSAIL_CLIENT_ID": "00000000-0000-0000-0000-000000000000",
        "CONSAIL_CLIENT_SECRET": "consailc_your_secret"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## Security defaults

- **Auth fail-closed** — a missing secret with no CLI session, a `consail_*` user key, a secret without `CONSAIL_CLIENT_ID`, or a non-2xx startup probe exits before tools are served. The client probe is `GET /api/v1/auth/client`. The user probe is `GET /api/v1/auth/me`. The access token is re-exchanged or refreshed when it is inside 60 seconds of expiry, and once after a 401. A 403 does not refresh. API 401/403 returns structured errors (no stack dumps).
- **Grant binding** — the client is pinned to one environment. Tool arguments cannot name another environment, or a dataset or pipeline outside the grant list. The access token is not sent to routes outside the read allowlist plus `POST /api/v1/ask`. A user session skips the grant list; the API enforces that user's access.
- **Preview row cap** — default 50, hard max 5000 (enforced in this server before calling Consail).
- **Ask** — registered only with the `ask` grant. The body is `sql_only`. There is no `execute` mode and no SQL argument.
- **No secrets in payloads** — tools never call secret APIs; fixtures are grepped in CI (`npm run check:secrets`).

## Tests (security gate A)

```bash
npm test
npm run check:secrets
```

Gate coverage:

1. Auth fail-closed (`consail_` rejected, `consailc_` accepted with a client id, startup probe failure exits)
2. Preview row cap (default + hard 5000)
3. Fixtures contain no secret values
4. A tool call sends the access token, and routes outside the allowlist are refused before the request

## Stack

- **TypeScript** + official **`@modelcontextprotocol/server`** (MCP SDK v2)
- Thin HTTP client → Consail REST (same shapes as `consail-cli --json`)

Why TypeScript: official MCP SDK, natural fit for Cursor/Claude Desktop stdio packaging (`node` / `npx`), while staying a separate thin repo (not in Atlas Core).

## Roadmap

| Phase | Status |
|-------|--------|
| **A** stdio read tools + `ask` `sql_only` when granted | this package |
| **B** hosted streamable HTTP at `https://mcp.consail.com` | not implemented |
| **C** `pipeline_run` / `run_get` (needs the `pipeline_run` grant) | not in this slice |

## License

Apache-2.0
