#!/usr/bin/env node
/**
 * Consail MCP — stdio entrypoint for Cursor + Claude Desktop.
 *
 * Auth (fail-closed): CONSAIL_URL + CONSAIL_CLIENT_SECRET (consailc_).
 * The client is bound to one environment by Core. This process does not send an environment header.
 *
 * Phase A: read tools plus ask sql_only when granted. No hosted HTTP (Phase B). No pipeline_run (Phase C).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { probeIdentity, type ClientIdentity } from "./client.js";
import { loadConfig, ConfigError, type ConsailConfig } from "./config.js";
import { createConsailMcpServer } from "./server.js";

export async function runStartup(
  env: Record<string, string | undefined>,
  onReady: (prepared: { cfg: ConsailConfig; identity: ClientIdentity }) => Promise<void>
): Promise<number> {
  try {
    const cfg = loadConfig(env);
    const identity = await probeIdentity(cfg);
    await onReady({ cfg, identity });
    return 0;
  } catch (err) {
    const msg =
      err instanceof ConfigError
        ? err.message
        : err instanceof Error
          ? err.message
          : "invalid configuration";
    console.error(`consail-mcp: ${msg}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const code = await runStartup(process.env, async ({ cfg, identity }) => {
    const server = createConsailMcpServer(cfg, identity);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });
  if (code !== 0) {
    process.exit(code);
  }
}

// Importing runStartup from tests must not start stdio or call process.exit.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((err) => {
    console.error(
      "consail-mcp: fatal:",
      err instanceof Error ? err.message : "unknown error"
    );
    process.exit(1);
  });
}
