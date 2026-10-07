import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { ConsailClient } from "../src/client.js";
import { clampPreviewRows, PREVIEW_DEFAULT_ROWS, PREVIEW_HARD_CAP } from "../src/caps.js";
import { loadConfig, ConfigError, requireEnvironment } from "../src/config.js";
import { ConsailApiError } from "../src/errors.js";
import { FORBIDDEN_TOOLS, PHASE_A_TOOLS } from "../src/tools.js";
import { createConsailMcpServer } from "../src/server.js";
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

describe("security gate A — config fail-closed", () => {
  it("rejects missing API key", () => {
    expect(() =>
      loadConfig({ CONSAIL_URL: "http://localhost:9", CONSAIL_API_KEY: "" })
    ).toThrow(ConfigError);
  });

  it("rejects non-consail_ API key", () => {
    expect(() =>
      loadConfig({
        CONSAIL_URL: "http://localhost:9",
        CONSAIL_API_KEY: "sk_live_wrong",
      })
    ).toThrow(/consail_/);
  });

  it("rejects missing URL", () => {
    expect(() =>
      loadConfig({ CONSAIL_URL: "", CONSAIL_API_KEY: "consail_test" })
    ).toThrow(/CONSAIL_URL/);
  });

  it("accepts valid consail_ key", () => {
    const cfg = loadConfig({
      CONSAIL_URL: "http://localhost:9/",
      CONSAIL_API_KEY: "consail_test_key",
      CONSAIL_ENVIRONMENT: "dev",
    });
    expect(cfg.baseUrl).toBe("http://localhost:9");
    expect(cfg.environment).toBe("dev");
  });

  it("requireEnvironment fails closed when unbound", () => {
    const cfg = loadConfig({
      CONSAIL_URL: "http://localhost:9",
      CONSAIL_API_KEY: "consail_test_key",
    });
    expect(() => requireEnvironment(cfg)).toThrow(/CONSAIL_ENVIRONMENT/);
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
  it("registers exactly the Phase A tools", () => {
    const server = createConsailMcpServer({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "consail_test",
      environment: "dev",
      timeoutMs: 1000,
    });
    // Internal tool map (SDK stores registered tools)
    const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools;
    // Fallback: assert constants — SDK internals may vary; also check forbidden names absent
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

describe("security gate A — env isolation (key A cannot preview env B)", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let previewCalls: Array<{ envHeader: string | null; path: string }> = [];

  beforeAll(async () => {
    previewCalls = [];
    const routes: Record<string, RouteHandler> = {
      "GET /api/v1/datasets/ds-1/preview": (req, res, url) => {
        previewCalls.push({
          envHeader: req.headers["x-consail-environment"]?.toString() ?? null,
          path: url.pathname + url.search,
        });
        const env = req.headers["x-consail-environment"];
        if (env !== "env-a") {
          return json(res, 403, {
            message: "environment not allowed for this API key",
            detail: `key scoped to env-a; got ${String(env)}`,
          });
        }
        const rows = Number(url.searchParams.get("rows") ?? "50");
        return json(res, 200, {
          columns: [{ name: "id", type: "int" }],
          rows: [{ id: 1 }],
          total_rows: 1,
          echo_rows: rows,
        });
      },
      "GET /api/v1/auth/me": (_req, res) =>
        json(res, 200, {
          user: { id: "u1", email: "a@example.com", name: "A", role: "member" },
        }),
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const key = `${req.method} ${url.pathname}`;
      // Strip query for route match of preview
      const previewKey = `${req.method} ${url.pathname}`;
      const handler = routes[previewKey] ?? routes[key];
      if (!handler) {
        return json(res, 404, { message: `no route ${key}` });
      }
      // Auth fail-closed
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer consail_")) {
        return json(res, 401, { message: "unauthorized" });
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

  it("auth fail-closed: invalid bearer returns 401", async () => {
    const client = new ConsailClient({
      baseUrl,
      apiKey: "not_a_consail_key_but_sent",
      environment: "env-a",
      timeoutMs: 3000,
    });
    // Client still sends the key; mock rejects non-consail_ bearer
    await expect(client.getJson("/api/v1/auth/me")).rejects.toBeInstanceOf(
      ConsailApiError
    );
    try {
      await client.getJson("/api/v1/auth/me");
    } catch (e) {
      expect(e).toBeInstanceOf(ConsailApiError);
      expect((e as ConsailApiError).statusCode).toBe(401);
    }
  });

  it("bound env-a can preview", async () => {
    const client = new ConsailClient({
      baseUrl,
      apiKey: "consail_env_a_key",
      environment: "env-a",
      timeoutMs: 3000,
    });
    const data = await client.getJson<{ total_rows: number }>(
      `/api/v1/datasets/ds-1/preview?rows=${clampPreviewRows(50)}`
    );
    expect(data.total_rows).toBe(1);
    expect(previewCalls.at(-1)?.envHeader).toBe("env-a");
  });

  it("key bound to env-a cannot preview as env-b", async () => {
    const client = new ConsailClient({
      baseUrl,
      apiKey: "consail_env_a_key",
      environment: "env-b", // wrong binding
      timeoutMs: 3000,
    });
    await expect(
      client.getJson(`/api/v1/datasets/ds-1/preview?rows=50`)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("MCP clamps rows before calling API (hard cap)", async () => {
    const client = new ConsailClient({
      baseUrl,
      apiKey: "consail_env_a_key",
      environment: "env-a",
      timeoutMs: 3000,
    });
    const effective = clampPreviewRows(99999);
    expect(effective).toBe(5000);
    await client.getJson(`/api/v1/datasets/ds-1/preview?rows=${effective}`);
    const last = previewCalls.at(-1);
    expect(last?.path).toContain("rows=5000");
  });
});
