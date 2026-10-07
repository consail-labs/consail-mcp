# Consail MCP

Governed [Model Context Protocol](https://modelcontextprotocol.io) server for [Consail](https://consail.com).

> **Agents connect to Consail. They never get the database password.**

Phase A ships a **local stdio** server for **Cursor** and **Claude Desktop**. Tools are a fixed allowlist mapped 1:1 to existing Consail HTTP APIs. Auth is your existing `consail_*` API key plus environment binding (`X-Consail-Environment`).

Public hosted origin will be **`https://mcp.consail.com`** (Phase B — not implemented in this package yet).

## Phase A tools (read / validate only)

| Tool | Consail API |
|------|-------------|
| `status` | `GET /api/v1/auth/me` + env + stats |
| `env_list` | `GET /api/v1/environments` |
| `catalog_list` | `GET /api/v1/catalogs` |
| `dataset_list` | `GET /api/v1/datasets` |
| `dataset_get` | `GET /api/v1/datasets/{ref}` |
| `dataset_preview` | `GET /api/v1/datasets/{ref}/preview?rows=` (default **50**, hard cap **5000**) |
| `action_list` | `GET /api/v1/actions` |
| `pipeline_get` | `GET /api/v1/pipelines/{ref}` |
| `pipeline_validate` | `POST /api/v1/pipelines/validate` |

**Never exposed (Phase A):** raw SQL, `secret_get`, API-key create/delete, deletes, writes, `pipeline_run` / `run_get` (Phase C).

## Requirements

- Node.js **20+**
- A Consail instance (local, staging, or prod API)
- A `consail_*` API key scoped to the environment you intend to use

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
| `CONSAIL_API_KEY` | yes | Bearer key with `consail_` prefix |
| `CONSAIL_ENVIRONMENT` | for data tools | Environment **slug** bound on every env-scoped call via `X-Consail-Environment` |
| `CONSAIL_TIMEOUT_MS` | no | Per-request timeout (default `30000`) |

Copy `.env.example` if useful — the MCP host should inject env vars into the server process (do not commit real keys).

```bash
export CONSAIL_URL=http://localhost:8080
export CONSAIL_API_KEY=consail_your_key
export CONSAIL_ENVIRONMENT=dev
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
        "CONSAIL_API_KEY": "consail_your_key",
        "CONSAIL_ENVIRONMENT": "dev"
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
        "CONSAIL_API_KEY": "consail_your_key",
        "CONSAIL_ENVIRONMENT": "dev"
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
        "CONSAIL_API_KEY": "consail_your_key",
        "CONSAIL_ENVIRONMENT": "dev"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## Security defaults

- **Auth fail-closed** — missing/invalid `consail_*` key: process refuses to start; API 401/403 returns structured errors (no stack dumps).
- **Tenant / env binding** — data tools always send `X-Consail-Environment` from `CONSAIL_ENVIRONMENT`. Tool arguments cannot override the bound environment.
- **Preview row cap** — default 50, hard max 5000 (enforced in this server before calling Consail).
- **No secrets in payloads** — tools never call secret APIs; fixtures are grepped in CI (`npm run check:secrets`).

## Tests (security gate A)

```bash
npm test
npm run check:secrets
```

Gate coverage:

1. Auth fail-closed (config + 401)
2. Preview row cap (default + hard 5000)
3. Fixtures contain no secret values
4. Env isolation: key/session for env A cannot preview as env B

## Stack

- **TypeScript** + official **`@modelcontextprotocol/server`** (MCP SDK v2)
- Thin HTTP client → Consail REST (same shapes as `consail-cli --json`)

Why TypeScript: official MCP SDK, natural fit for Cursor/Claude Desktop stdio packaging (`node` / `npx`), while staying a separate thin repo (not in Atlas Core).

## Roadmap

| Phase | Status |
|-------|--------|
| **A** stdio read/validate | this package |
| **B** hosted streamable HTTP at `https://mcp.consail.com` | not in this slice |
| **C** `pipeline_run` / `run_get` | not in this slice |

## License

Apache-2.0
