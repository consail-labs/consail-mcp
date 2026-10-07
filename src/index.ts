#!/usr/bin/env node
/**
 * Consail MCP — stdio entrypoint for Cursor + Claude Desktop.
 *
 * Auth (fail-closed): CONSAIL_URL + CONSAIL_API_KEY (consail_*).
 * Env binding: CONSAIL_ENVIRONMENT (required for data tools).
 *
 * Phase A: read/validate tools only. No hosted HTTP (Phase B). No pipeline_run (Phase C).
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig, ConfigError } from "./config.js";
import { createConsailMcpServer } from "./server.js";

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const msg = err instanceof ConfigError ? err.message : "invalid configuration";
    console.error(`consail-mcp: ${msg}`);
    process.exit(1);
    return;
  }

  const server = createConsailMcpServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(
    "consail-mcp: fatal:",
    err instanceof Error ? err.message : "unknown error"
  );
  process.exit(1);
});
