import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { ConsailClient, type ClientIdentity } from "../src/client.js";
import { clampPreviewRows, PREVIEW_DEFAULT_ROWS, PREVIEW_HARD_CAP } from "../src/caps.js";
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

describe("security gate A — preview row cap", () => {
  it("defaults to 50", () => {
    expect(clampPreviewRows(undefined)).toBe(PREVIEW_DEFAULT_ROWS);
    expect(clampPreviewRows(null)).toBe(PREVIEW_DEFAULT_ROWS);
    expect(clampPreviewRows(0)).toBe(PREVIEW_DEFAULT_ROWS);
    expect(clampPreviewRows(-1)).toBe(PREVIEW_DEFAULT_ROWS);
  });

  it("hard-caps at 5000", () => {
    expect(clampPreviewRows(5000)).toBe(PREVIEW_HARD_CAP);
    expect(clampPreviewRows(5001)).toBe(PREVIEW_HARD_CAP);
    expect(clampPreviewRows(1_000_000)).toBe(PREVIEW_HARD_CAP);
  });

  it("passes through valid counts under the cap", () => {
    expect(clampPreviewRows(1)).toBe(1);
    expect(clampPreviewRows(50)).toBe(50);
    expect(clampPreviewRows(100)).toBe(100);
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
    expect(PHASE_A_TOOLS).toHaveLength(9);
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

  it("registers ask only with the ask grant and does not register execute", () => {
    const server = createConsailMcpServer(
      {
        baseUrl: "http://127.0.0.1:9",
        clientSecret: "consailc_test",
        timeoutMs: 1000,
      },
      {
        ...readIdentity,
        capabilities: [...readIdentity.capabilities, "ask"],
        grants: [
          ...readIdentity.grants,
          { capability: "ask", resource_id: "11111111-1111-1111-1111-111111111111" },
        ],
      }
    );
    const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools;
    expect(tools && "ask" in tools).toBe(true);
    expect(tools && "execute" in tools).toBe(false);
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
  let previewCalls: Array<{ auth: string; envHeader: string | null; path: string }> = [];
  let askBodies: unknown[] = [];

  beforeAll(async () => {
    previewCalls = [];
    askBodies = [];
    const routes: Record<string, RouteHandler> = {
      "GET /api/v1/datasets/11111111-1111-1111-1111-111111111111/preview": (req, res, url) => {
        previewCalls.push({
          auth: req.headers.authorization ?? "",
          envHeader: req.headers["x-consail-environment"]?.toString() ?? null,
          path: url.pathname + url.search,
        });
        const rows = Number(url.searchParams.get("rows") ?? "50");
        return json(res, 200, {
          columns: [{ name: "id", type: "int" }],
          rows: [{ id: 1 }],
          total_rows: 1,
          echo_rows: rows,
        });
      },
      "GET /api/v1/auth/client": (req, res) => {
        if (req.headers.authorization !== "Bearer mcp-access-token") {
          return json(res, 401, { message: "unauthorized" });
        }
        return json(res, 200, { client: readIdentity });
      },
      "POST /api/v1/ask": async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        askBodies.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        return json(res, 200, { sql: "select 1", mode: "sql_only" });
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
    await expect(client.postJson("/api/v1/query", { sql: "select 1" })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(client.getJson("/api/v1/datasets/tags")).rejects.toMatchObject({
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
    const ref = "11111111-1111-1111-1111-111111111111";
    await tools!.dataset_preview.handler({ ref, rows: 50 });
    const last = previewCalls.at(-1);
    expect(last?.auth).toBe("Bearer mcp-access-token");
    expect(last?.auth).not.toContain(secret);
    expect(last?.envHeader).toBeNull();
  });

  it("ask sends sql_only and no execute mode", async () => {
    const cfg = {
      baseUrl,
      clientSecret: "consailc_env_a_key",
      clientId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accessToken: "",
      expiresAt: 0,
      principal: "client" as const,
      configHome: "",
      timeoutMs: 3000,
    };
    const server = createConsailMcpServer(cfg, {
      ...readIdentity,
      capabilities: [...readIdentity.capabilities, "ask"],
      grants: [
        ...readIdentity.grants,
        { capability: "ask", resource_id: "11111111-1111-1111-1111-111111111111" },
      ],
    });
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;
    await tools!.ask.handler({ question: "how many rows" });
    expect(askBodies.at(-1)).toEqual({ question: "how many rows", mode: "sql_only" });
  });

  it("MCP clamps rows before calling API (hard cap)", async () => {
    const cfg = {
      baseUrl,
      clientSecret: "consailc_env_a_key",
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
    const ref = "11111111-1111-1111-1111-111111111111";
    await tools!.dataset_preview.handler({ ref, rows: 99999 });
    const last = previewCalls.at(-1);
    expect(last?.path).toContain("rows=5000");
    expect(last?.auth).toBe("Bearer mcp-access-token");
  });
});
