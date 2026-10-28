import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OPERATOR_UNSUPPORTED,
  probeIdentity,
  SESSION_ENDED,
  ConsailClient,
  type ClientIdentity,
} from "../src/client.js";
import { CORE_JSON_BODY_MAX_BYTES, WORKFLOW_YAML_MAX_BYTES } from "../src/caps.js";
import { loadConfig, ConfigError, type ConsailConfig } from "../src/config.js";
import { runStartup } from "../src/index.js";
import { credentialFile } from "../src/session.js";
import { createConsailMcpServer } from "../src/server.js";

type Tool = {
  inputSchema?: { safeParse: (args: unknown) => { success: boolean } };
  handler: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  annotations?: Record<string, boolean>;
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>
) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    await handler(req, res, url);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const GRANTED_DS = "11111111-1111-1111-1111-111111111111";
const GRANTED_PL = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";
const RANDOM = "44444444-4444-4444-4444-444444444444";

const identity: ClientIdentity = {
  id: "client-1",
  environment_id: "env-1",
  capabilities: ["dataset_read", "pipeline_read", "ask"],
  grants: [
    { capability: "dataset_read", resource_id: GRANTED_DS },
    { capability: "pipeline_read", resource_id: GRANTED_PL },
    { capability: "ask", resource_id: GRANTED_DS },
  ],
  principal: "client",
};

function clientCfg(baseUrl: string): ConsailConfig {
  return {
    baseUrl,
    clientSecret: "consailc_env_a_key",
    clientId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    accessToken: "",
    expiresAt: 0,
    principal: "client",
    configHome: "",
    timeoutMs: 3000,
  };
}

function toolsOf(server: unknown): Record<string, Tool> {
  return (server as { _registeredTools: Record<string, Tool> })._registeredTools;
}

describe("F-MCPa: grant misses are a uniform 404", () => {
  let srv: Awaited<ReturnType<typeof listen>>;
  const apiCalls: string[] = [];
  const workflowBodies: unknown[] = [];

  beforeAll(async () => {
    srv = await listen(async (req, res, url) => {
      if (url.pathname === "/oauth/token") {
        return json(res, 200, { access_token: "tok", expires_in: 900 });
      }
      apiCalls.push(`${req.method} ${url.pathname}`);
      if (req.method === "POST" && url.pathname === "/api/v1/pipelines/validate") {
        const body = await readBody(req);
        if (String(body.definition_yaml).includes("qa_x")) {
          return json(res, 200, { valid: true });
        }
        // Core's dataset gate: same 403 for ungranted, other-tenant and nonexistent.
        return json(res, 403, { code: "FORBIDDEN", message: "dataset is not granted to this client" });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/workflows/validate") {
        const body = await readBody(req);
        workflowBodies.push(body);
        if (String(body.yaml).includes(GRANTED_PL)) {
          return json(res, 200, { valid: true, nodes: [{ id: "n1", pipeline: GRANTED_PL }] });
        }
        return json(res, 404, { code: "NOT_FOUND", message: "pipeline not found", detail: "id=x" });
      }
      return json(res, 500, { message: `unexpected ${req.method} ${url.pathname}` });
    });
  });

  afterAll(async () => {
    await srv.close();
  });

  it("dataset_get, dataset_preview, pipeline_get and ask return the same 404 without calling Core", async () => {
    const tools = toolsOf(createConsailMcpServer(clientCfg(srv.baseUrl), identity));
    const before = apiCalls.length;
    for (const ref of [OTHER, RANDOM, "not-a-uuid"]) {
      for (const [name, args] of [
        ["dataset_get", { ref }],
        ["dataset_preview", { ref, rows: 5 }],
        ["ask", { question: "q", dataset_ids: [ref] }],
      ] as const) {
        const out = await tools[name].handler(args);
        expect(out.isError).toBe(true);
        expect(JSON.parse(out.content[0].text)).toEqual({
          error: "dataset not found",
          status_code: 404,
        });
      }
      const pl = await tools.pipeline_get.handler({ ref });
      expect(JSON.parse(pl.content[0].text)).toEqual({
        error: "pipeline not found",
        status_code: 404,
      });
      expect(pl.content[0].text).not.toMatch(/grant/i);
    }
    expect(apiCalls.length).toBe(before);
  });

  it("pipeline_validate maps Core's 403 dataset gate to the same 404", async () => {
    const tools = toolsOf(createConsailMcpServer(clientCfg(srv.baseUrl), identity));
    const ok = await tools.pipeline_validate.handler({ definition_yaml: "source: qa_x" });
    expect(ok.isError).toBeUndefined();
    const local = await tools.dataset_get.handler({ ref: OTHER });
    for (const yaml of ["source: qa_y", "source: qa_b", "source: nope"]) {
      const out = await tools.pipeline_validate.handler({ definition_yaml: yaml });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toBe(local.content[0].text);
    }
  });

  it("workflow_validate posts { yaml } and passes Core's 404 through", async () => {
    const tools = toolsOf(createConsailMcpServer(clientCfg(srv.baseUrl), identity));
    const ok = await tools.workflow_validate.handler({ yaml: `nodes: [${GRANTED_PL}]` });
    expect(JSON.parse(ok.content[0].text)).toMatchObject({ valid: true });
    expect(workflowBodies.at(-1)).toEqual({ yaml: `nodes: [${GRANTED_PL}]` });
    const miss = await tools.workflow_validate.handler({ yaml: `nodes: [${OTHER}]` });
    expect(JSON.parse(miss.content[0].text)).toMatchObject({
      error: "pipeline not found",
      status_code: 404,
    });
  });

  it("workflow_validate refuses YAML over Core's YAMLMaxLen (bytes) before the request", async () => {
    const tools = toolsOf(createConsailMcpServer(clientCfg(srv.baseUrl), identity));
    const before = apiCalls.length;
    // 2-byte characters: under the limit in UTF-16 units, over it in bytes.
    const big = "é".repeat(WORKFLOW_YAML_MAX_BYTES / 2 + 1);
    const out = await tools.workflow_validate.handler({ yaml: big });
    expect(JSON.parse(out.content[0].text)).toMatchObject({
      error: "yaml too large",
      status_code: 400,
    });
    expect(apiCalls.length).toBe(before);
  });

  // F-MCPh: Core's JSON body limit, minus the {"yaml":""} wrapper.
  const WRAPPER_BYTES = JSON.stringify({ yaml: "" }).length;

  it("workflow_validate: ASCII YAML over 1 MB passes the schema and gets the handler's 400", async () => {
    const tools = toolsOf(createConsailMcpServer(clientCfg(srv.baseUrl), identity));
    const big = "x".repeat(WORKFLOW_YAML_MAX_BYTES + 1);
    expect(tools.workflow_validate.inputSchema?.safeParse({ yaml: big }).success).toBe(true);
    const before = apiCalls.length;
    const out = await tools.workflow_validate.handler({ yaml: big });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text)).toMatchObject({
      error: "yaml too large",
      status_code: 400,
    });
    expect(apiCalls.length).toBe(before);
  });

  it("workflow_validate sends YAML whose JSON body is exactly at Core's limit", async () => {
    const tools = toolsOf(createConsailMcpServer(clientCfg(srv.baseUrl), identity));
    const head = `nodes: [${GRANTED_PL}] # `;
    const yaml = head + "x".repeat(CORE_JSON_BODY_MAX_BYTES - WRAPPER_BYTES - head.length);
    expect(Buffer.byteLength(JSON.stringify({ yaml }))).toBe(CORE_JSON_BODY_MAX_BYTES);
    const before = apiCalls.length;
    const out = await tools.workflow_validate.handler({ yaml });
    expect(out.isError).toBeUndefined();
    expect(apiCalls.length).toBe(before + 1);
    expect(workflowBodies.at(-1)).toEqual({ yaml });
  });

  it("workflow_validate refuses YAML under YAMLMaxLen whose JSON body is over Core's limit", async () => {
    const tools = toolsOf(createConsailMcpServer(clientCfg(srv.baseUrl), identity));
    const cases = [
      // One byte over the body limit.
      "x".repeat(CORE_JSON_BODY_MAX_BYTES - WRAPPER_BYTES + 1),
      // Each quote encodes as \" (2 bytes): YAML is half the limit, the body is over it.
      '"'.repeat(WORKFLOW_YAML_MAX_BYTES / 2 + 1),
      // Control characters encode as \u00XX (6 bytes).
      "\u0001".repeat(WORKFLOW_YAML_MAX_BYTES / 6 + 1),
    ];
    const before = apiCalls.length;
    for (const yaml of cases) {
      expect(Buffer.byteLength(yaml)).toBeLessThanOrEqual(WORKFLOW_YAML_MAX_BYTES);
      const out = await tools.workflow_validate.handler({ yaml });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content[0].text)).toMatchObject({
        error: "yaml too large",
        status_code: 400,
      });
    }
    expect(apiCalls.length).toBe(before);
  });

  it("workflow_validate is registered only with pipeline_read", () => {
    const tools = toolsOf(
      createConsailMcpServer(clientCfg(srv.baseUrl), {
        ...identity,
        capabilities: ["dataset_read"],
      })
    );
    expect("workflow_validate" in tools).toBe(false);
  });
});

describe("F-MCPg: tool annotations", () => {
  it("every tool is read-only and non-destructive", () => {
    const tools = toolsOf(createConsailMcpServer(clientCfg("http://127.0.0.1:9"), identity));
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(tools[name].annotations, name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
    }
  });
});

function writeSession(home: string, baseUrl: string) {
  const file = credentialFile(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        [baseUrl]: {
          access_token: "stored-access",
          refresh_token: "stored-refresh",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

function userEnv(baseUrl: string, home: string) {
  return {
    CONSAIL_URL: baseUrl,
    CONSAIL_CLIENT_SECRET: "",
    APPDATA: home,
    XDG_CONFIG_HOME: home,
    HOME: home,
  };
}

describe("F-MCPc: revoked CLI session says run consail login", () => {
  it("startup probe 401 exits with the login hint, not a raw 401", async () => {
    const srv = await listen(async (_req, res, url) => {
      if (url.pathname === "/api/v1/auth/refresh") {
        return json(res, 401, { message: "refresh token revoked" });
      }
      return json(res, 401, { message: "session revoked" });
    });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const home = mkdtempSync(path.join(tmpdir(), "mcp-c-"));
      writeSession(home, srv.baseUrl);
      let served = false;
      const code = await runStartup(userEnv(srv.baseUrl, home), async () => {
        served = true;
      });
      expect(code).toBe(1);
      expect(served).toBe(false);
      expect(errors.join("\n")).toContain(SESSION_ENDED);
      expect(errors.join("\n")).not.toMatch(/\(401\)|stored-access|stored-refresh/);
    } finally {
      console.error = orig;
      await srv.close();
    }
  });

  it("a 401 that survives a successful refresh is reported as session ended", async () => {
    let refreshes = 0;
    const srv = await listen(async (_req, res, url) => {
      if (url.pathname === "/api/v1/auth/refresh") {
        refreshes += 1;
        return json(res, 200, { access_token: "a2", refresh_token: "r2", expires_in: 900 });
      }
      return json(res, 401, { message: "user disabled" });
    });
    try {
      const home = mkdtempSync(path.join(tmpdir(), "mcp-c2-"));
      writeSession(home, srv.baseUrl);
      const client = new ConsailClient(loadConfig(userEnv(srv.baseUrl, home)));
      await expect(client.getJson("/api/v1/datasets")).rejects.toMatchObject({
        statusCode: 401,
        message: SESSION_ENDED,
      });
      expect(refreshes).toBe(1);
    } finally {
      await srv.close();
    }
  });
});

describe("F-MCPd: operator-mode clients get a clear integration-only error", () => {
  it("maps the probe 403 from Core's operator allowlist", async () => {
    const srv = await listen(async (_req, res, url) => {
      if (url.pathname === "/oauth/token") {
        return json(res, 200, { access_token: "op-access", expires_in: 900 });
      }
      return json(res, 403, { code: "FORBIDDEN", message: "operation not allowed for this client" });
    });
    try {
      const err = await probeIdentity(clientCfg(srv.baseUrl)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toBe(OPERATOR_UNSUPPORTED);
      expect((err as Error).message).not.toContain("op-access");
    } finally {
      await srv.close();
    }
  });
});
