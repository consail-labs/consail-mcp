import { McpServer } from "@modelcontextprotocol/server";
import { ConsailClient, type ClientIdentity } from "./client.js";
import type { ConsailConfig } from "./config.js";
import { registerTools } from "./tools.js";

export function createConsailMcpServer(cfg: ConsailConfig, identity: ClientIdentity): McpServer {
  const client = new ConsailClient(cfg);
  const server = new McpServer({
    name: "consail-mcp",
    version: "0.1.0",
  });
  registerTools(server, client, identity);
  return server;
}
