import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { ConsailClient, type ClientIdentity } from "../src/client.js";
import { loadConfig, ConfigError } from "../src/config.js";
import { ConsailApiError } from "../src/errors.js";
import { FORBIDDEN_TOOLS, PHASE_A_TOOLS } from "../src/tools.js";
import { createConsailMcpServer } from "../src/server.js";
import { runStartup } from "../src/index.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) => void | Promise<void>;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const readIdentity: ClientIdentity = {
  id: "client-1",
  environment_id: "env-1",
  capabilities: ["dataset_read", "pipeline_read"],
  grants: [
    { capability: "dataset_read", resource_id: "11111111-1111-1111-1111-111111111111" },
    { capability: "pipeline_read", resource_id: "22222222-2222-2222-2222-222222222222" },
  ],
};

describe("security gate A — config fail-closed", () => {
  it("rejects missing client secret when no CLI session exists", () => {
    expect(() =>
      loadConfig({
        CONSAIL_URL: "http://localhost:9",
        CONSAIL_CLIENT_SECRET: "",
        APPDATA: "",
        XDG_CONFIG_HOME: "",
        HOME: "",
        USERPROFILE: "",
      })
    ).toThrow(ConfigError);
  });

  it("rejects a user consail_ API key", () => {
    expect(() =>
      loadConfig({
        CONSAIL_URL: "http://localhost:9",
        CONSAIL_CLIENT_SECRET: "consail_user_key",
      })
    ).toThrow(/consail_/);
  });

  it("rejects a non-client secret", () => {
    expect(() =>
      loadConfig({
        CONSAIL_URL: "http://localhost:9",
        CONSAIL_CLIENT_SECRET: "sk_live_wrong",
      })
    ).toThrow(/consailc_/);
  });

  it("rejects missing URL", () => {
    expect(() =>
      loadConfig({ CONSAIL_URL: "", CONSAIL_CLIENT_SECRET: "consailc_test" })
    ).toThrow(/CONSAIL_URL/);
  });

  it("accepts a consailc_ secret", () => {
    const cfg = loadConfig({
      CONSAIL_URL: "http://localhost:9/",
      CONSAIL_CLIENT_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      CONSAIL_CLIENT_SECRET: "consailc_test_key",
    });
    expect(cfg.baseUrl).toBe("http://localhost:9");
    expect(cfg.clientSecret).toBe("consailc_test_key");
    expect(cfg.clientId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(cfg.principal).toBe("client");
  });

  it("rejects a client secret without a client id", () => {
    expect(() =>
      loadConfig({
        CONSAIL_URL: "http://localhost:9",
        CONSAIL_CLIENT_SECRET: "consailc_test_key",
      })
    ).toThrow(/CONSAIL_CLIENT_ID/);
  });

  it("startup probe failure exits before tools are served", async () => {
    let served = false;
    const code = await runStartup(
      {
        CONSAIL_URL: "http://127.0.0.1:9",
        CONSAIL_CLIENT_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        CONSAIL_CLIENT_SECRET: "consailc_test_key",
      },
      async () => {
        served = true;
      }
    );
    expect(code).toBe(1);
    expect(served).toBe(false);
  });
});

describe("security gate A — tool allowlist", () => {
  it("registers read tools only when the capability is present", () => {
    const server = createConsailMcpServer(
      {
        baseUrl: "http://127.0.0.1:9",
        clientSecret: "consailc_test",
        timeoutMs: 1000,
      },
      readIdentity
    );
    const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools;
    expect(PHASE_A_TOOLS).toHaveLength(8);
    for (const name of FORBIDDEN_TOOLS) {
      expect(PHASE_A_TOOLS).not.toContain(name as (typeof PHASE_A_TOOLS)[number]);
    }
    if (tools) {
      const names = Object.keys(tools).sort();
      expect(names).toEqual([...PHASE_A_TOOLS].sort());
      for (const bad of FORBIDDEN_TOOLS) {
        expect(names).not.toContain(bad);
      }
    }
  });

});

describe("security gate A — fixtures contain no secrets", () => {
  it("grep fixtures: no secret-like values", () => {
    const dir = join(process.cwd(), "tests/fixtures");
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);

    const secretPatterns = [
      /consail_[a-zA-Z0-9]{16,}/, // real-looking API keys
      /"password"\s*:\s*"[^"]+"/i,
      /"secret(?:_value)?"\s*:\s*"[^"]+"/i,
      /"api_key"\s*:\s*"consail_[^"]+"/i,
      /BEGIN (RSA |OPENSSH )?PRIVATE KEY/,
      /postgres(?:ql)?:\/\/[^:]+:[^@]+@/i,
    ];

    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const re of secretPatterns) {
        expect(text, `${file} matched ${re}`).not.toMatch(re);
      }
    }
  });
});

describe("security gate A — client secret on the wire", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let toolCalls: Array<{ auth: string; envHeader: string | null; path: string; body: string }> = [];

  beforeAll(async () => {
    toolCalls = [];
    const routes: Record<string, RouteHandler> = {
      "POST /api/v1/pipelines/22222222-2222-2222-2222-222222222222/run": async (req, res, url) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        toolCalls.push({
          auth: req.headers.authorization ?? "",
          envHeader: req.headers["x-consail-environment"]?.toString() ?? null,
          path: url.pathname,
          body: Buffer.concat(chunks).toString(),
        });
        return json(res, 202, { run_id: "run-1", status: "PENDING" });
      },
      "POST /api/v1/workflows/validate": async (req, res, url) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        toolCalls.push({
          auth: req.headers.authorization ?? "",
          envHeader: req.headers["x-consail-environment"]?.toString() ?? null,
          path: url.pathname,
          body: Buffer.concat(chunks).toString(),
        });
        return json(res, 200, { valid: true, errors: [] });
      },
      "POST /api/v1/assistant/tools/search/call": async (req, res, url) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        toolCalls.push({
          auth: req.headers.authorization ?? "",
          envHeader: req.headers["x-consail-environment"]?.toString() ?? null,
          path: url.pathname,
          body: Buffer.concat(chunks).toString(),
        });
        return json(res, 200, {
          content: [{ type: "text", text: "{\"items\":[]}" }],
          structuredContent: { items: [], next_offset: null },
          isError: false,
        });
      },
      "POST /api/v1/query": async (req, res, url) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        toolCalls.push({
          auth: req.headers.authorization ?? "",
          envHeader: req.headers["x-consail-environment"]?.toString() ?? null,
          path: url.pathname,
          body: Buffer.concat(chunks).toString(),
        });
        return json(res, 200, {
          columns: [{ name: "n", type: "INTEGER" }],
          rows: [["secret-cell"]],
          total_rows: 4,
          truncated: true,
        });
      },
      "GET /api/v1/auth/client": (req, res) => {
        if (req.headers.authorization !== "Bearer mcp-access-token") {
          return json(res, 401, { message: "unauthorized" });
        }
        return json(res, 200, { client: readIdentity });
      },
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
          client_secret?: string;
          grant_type?: string;
        };
        if (
          body.grant_type !== "client_credentials" ||
          body.client_secret !== "consailc_env_a_key"
        ) {
          return json(res, 401, { message: "invalid client credentials" });
        }
        return json(res, 200, {
          access_token: "mcp-access-token",
          token_type: "Bearer",
          expires_in: 900,
        });
      }
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) {
        return json(res, 404, { message: `no route ${key}` });
      }
      const auth = req.headers.authorization ?? "";
      if (auth !== "Bearer mcp-access-token") {
        return json(res, 401, { message: "unauthorized" });
      }
      if (auth.includes("consailc_")) {
        return json(res, 500, { message: "secret was sent as a bearer" });
      }
      await handler(req, res, url);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    close = () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
  });

  afterAll(async () => {
    await close();
  });

  it("does not send the secret to a route outside the allowlist", async () => {
    const client = new ConsailClient({
      baseUrl,
      clientSecret: "consailc_env_a_key",
      timeoutMs: 3000,
    });
    await expect(client.getJson("/api/v1/query/history")).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(client.postJson("/api/v1/ai/sql", { question: "how many orders" })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(client.getJson("/api/v1/datasets/tags")).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      client.getJson("/api/v1/datasets/11111111-1111-1111-1111-111111111111/preview")
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(client.postJson("/api/v1/pipelines/validate", { definition_yaml: "id: x" })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(client.postJson("/api/v1/pipelines/pipe-1/runs", {})).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(client.getJson("/api/v1/environments/env-1")).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(client.postJson("/api/v1/assistant/tools/run_query/call", {})).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("tool call sends the access token and does not send an environment header", async () => {
    const secret = "consailc_env_a_key";
    const cfg = {
      baseUrl,
      clientSecret: secret,
      clientId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accessToken: "",
      expiresAt: 0,
      principal: "client" as const,
      configHome: "",
      timeoutMs: 3000,
    };
    const server = createConsailMcpServer(cfg, readIdentity);
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;
    await tools!.search.handler({});
    const last = toolCalls.at(-1);
    expect(last?.auth).toBe("Bearer mcp-access-token");
    expect(last?.auth).not.toContain(secret);
    expect(last?.envHeader).toBeNull();
    expect(last?.path).toBe("/api/v1/assistant/tools/search/call");
    expect(JSON.parse(last?.body ?? "{}")).toEqual({
      query: "",
      kinds: null,
      limit: 20,
      offset: null,
    });
  });

  it("workflow_validate posts yaml and does not send the secret", async () => {
    const secret = "consailc_env_a_key";
    const cfg = {
      baseUrl,
      clientSecret: secret,
      clientId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accessToken: "",
      expiresAt: 0,
      principal: "client" as const,
      configHome: "",
      timeoutMs: 3000,
    };
    const server = createConsailMcpServer(cfg, readIdentity);
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;
    const yaml = "name: nightly\nnodes: []\n";
    await tools!["workflow_validate"].handler({ yaml });
    const call = toolCalls.find((entry) => entry.path === "/api/v1/workflows/validate");
    expect(call?.auth).toBe("Bearer mcp-access-token");
    expect(call?.auth).not.toContain(secret);
    expect(call?.envHeader).toBeNull();
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ yaml });
  });

  it("pipeline_run posts the pipeline id and params and does not send the secret", async () => {
    const secret = "consailc_env_a_key";
    const cfg = {
      baseUrl,
      clientSecret: secret,
      clientId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accessToken: "",
      expiresAt: 0,
      principal: "client" as const,
      configHome: "",
      timeoutMs: 3000,
    };
    const server = createConsailMcpServer(cfg, readIdentity);
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;
    const id = "22222222-2222-2222-2222-222222222222";
    await tools!["pipeline_run"].handler({ id, params: { min_amount: 10 } });
    const call = toolCalls.find((entry) => entry.path === `/api/v1/pipelines/${id}/run`);
    expect(call?.auth).toBe("Bearer mcp-access-token");
    expect(call?.auth).not.toContain(secret);
    expect(call?.envHeader).toBeNull();
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ params: { min_amount: 10 } });
  });

  it("query_check posts the sql and dataset ids and does not return cell values", async () => {
    const secret = "consailc_env_a_key";
    const cfg = {
      baseUrl,
      clientSecret: secret,
      clientId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accessToken: "",
      expiresAt: 0,
      principal: "client" as const,
      configHome: "",
      timeoutMs: 3000,
    };
    const server = createConsailMcpServer(cfg, readIdentity);
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { handler: (args: unknown) => Promise<{ content?: { text?: string }[] }> }>;
      }
    )._registeredTools;
    const result = await tools!["query_check"].handler({
      sql: "select count(*) as n from orders",
      dataset_ids: ["11111111-1111-1111-1111-111111111111"],
      params: { min_amount: 10 },
    });
    const call = toolCalls.find((entry) => entry.path === "/api/v1/query");
    expect(call?.auth).toBe("Bearer mcp-access-token");
    expect(call?.auth).not.toContain(secret);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      sql: "select count(*) as n from orders",
      dataset_ids: ["11111111-1111-1111-1111-111111111111"],
      max_rows: 1,
      params: { min_amount: 10 },
    });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("\"row_count\": 4");
    expect(text).toContain("INTEGER");
    expect(text).not.toContain("secret-cell");
  });
});
