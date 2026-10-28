import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { probeIdentity, ConsailClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { credentialFile } from "../src/session.js";
import { createConsailMcpServer } from "../src/server.js";
import { FORBIDDEN_TOOLS } from "../src/tools.js";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>) {
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

function writeSession(home: string, baseUrl: string, session: Record<string, string>) {
  const file = credentialFile(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ [baseUrl]: session }, null, 2)}\n`, { mode: 0o600 });
}

describe("CLI session bearer", () => {
  it("uses the stored access token and does not exchange a secret", async () => {
    let tokenCalls = 0;
    let auth = "";
    const srv = await listen(async (req, res, url) => {
      if (url.pathname === "/oauth/token") {
        tokenCalls += 1;
        return json(res, 500, { message: "unexpected exchange" });
      }
      auth = req.headers.authorization ?? "";
      if (url.pathname === "/api/v1/auth/me") {
        return json(res, 200, { user: { id: "user-1" } });
      }
      return json(res, 404, { message: "no route" });
    });
    try {
      const home = mkdtempSync(path.join(tmpdir(), "mcp-session-"));
      const refresh = "refresh-token-value";
      writeSession(home, srv.baseUrl, {
        access_token: "stored-access",
        refresh_token: refresh,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      const cfg = loadConfig({
        CONSAIL_URL: srv.baseUrl,
        CONSAIL_CLIENT_SECRET: "",
        APPDATA: home,
        XDG_CONFIG_HOME: home,
        HOME: home,
      });
      const identity = await probeIdentity(cfg);
      expect(identity).toMatchObject({ id: "user-1", principal: "user" });
      expect(auth).toBe("Bearer stored-access");
      expect(tokenCalls).toBe(0);
      expect(readFileSync(credentialFile(home), "utf8")).toContain(refresh);
      const server = createConsailMcpServer(cfg, identity);
      const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })
        ._registeredTools;
      // Core /api/v1/ask needs an API client, so a user session never gets the tool (F-MCPb).
      expect(identity.capabilities).not.toContain("ask");
      expect(tools && "ask" in tools).toBe(false);
      expect(tools && "dataset_get" in tools).toBe(true);
      for (const name of FORBIDDEN_TOOLS) {
        expect(tools && name in tools).toBe(false);
      }
    } finally {
      await srv.close();
    }
  });

  it("refreshes inside 60 seconds and does not leak the refresh token", async () => {
    const oldRefresh = "old-refresh-secret";
    let refreshes = 0;
    const srv = await listen(async (req, res, url) => {
      if (url.pathname === "/api/v1/auth/refresh") {
        refreshes += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
          refresh_token?: string;
        };
        if (body.refresh_token !== oldRefresh) {
          return json(res, 401, { message: "no" });
        }
        return json(res, 200, {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 900,
        });
      }
      if (req.headers.authorization !== "Bearer new-access") {
        return json(res, 401, { message: "unauthorized" });
      }
      return json(res, 200, { user: { id: "user-1" } });
    });
    try {
      const home = mkdtempSync(path.join(tmpdir(), "mcp-refresh-"));
      writeSession(home, srv.baseUrl, {
        access_token: "stored-access",
        refresh_token: oldRefresh,
        expires_at: new Date(Date.now() + 30 * 1000).toISOString(),
      });
      const cfg = loadConfig({
        CONSAIL_URL: srv.baseUrl,
        CONSAIL_CLIENT_SECRET: "",
        APPDATA: home,
        XDG_CONFIG_HOME: home,
        HOME: home,
      });
      const identity = await probeIdentity(cfg);
      expect(identity.id).toBe("user-1");
      expect(refreshes).toBe(1);
      const text = readFileSync(credentialFile(home), "utf8");
      expect(text).toContain("new-refresh");
      expect(text).not.toContain(oldRefresh);
      // The rewritten file keeps the CLI's protection: one user ACE, nothing inherited / 0600.
      if (process.platform === "win32") {
        const acl = execFileSync("icacls", [credentialFile(home)], { encoding: "utf8" });
        expect(acl).not.toContain("(I)");
        expect(acl.match(/:\(/g)?.length).toBe(1);
      } else {
        expect(statSync(credentialFile(home)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await srv.close();
    }
  });
});

// MC-02 / U7: the config folder hands an inheritable ACE to new files. After a refresh the rewritten
// credentials.json must still carry only the current user's ACE, with nothing inherited.
describe.runIf(process.platform === "win32")("Windows credential ACL (MC-02/U7)", () => {
  it("drops an inheritable Users ACE from the folder when the file is rewritten", async () => {
    const srv = await listen(async (_req, res, url) => {
      if (url.pathname === "/api/v1/auth/refresh") {
        return json(res, 200, {
          access_token: "u7-access",
          refresh_token: "u7-refresh",
          expires_in: 900,
        });
      }
      return json(res, 200, { user: { id: "user-1" } });
    });
    try {
      const home = mkdtempSync(path.join(tmpdir(), "mcp-u7-"));
      // S-1-5-32-545 is BUILTIN\Users; the SID form does not depend on the Windows locale.
      execFileSync("icacls", [home, "/grant", "*S-1-5-32-545:(OI)(CI)R"], { stdio: "ignore" });
      writeSession(home, srv.baseUrl, {
        access_token: "stored-access",
        refresh_token: "u7-old-refresh",
        expires_at: new Date(Date.now() + 30 * 1000).toISOString(),
      });
      const file = credentialFile(home);
      // Precondition: a plain write inherits the folder's ACEs, including Users.
      const before = execFileSync("icacls", [file], { encoding: "utf8" });
      expect(before).toContain("(I)");
      expect(before.match(/:\(/g)?.length ?? 0).toBeGreaterThan(1);

      const cfg = loadConfig({
        CONSAIL_URL: srv.baseUrl,
        CONSAIL_CLIENT_SECRET: "",
        APPDATA: home,
        XDG_CONFIG_HOME: home,
        HOME: home,
      });
      await probeIdentity(cfg);
      expect(readFileSync(file, "utf8")).toContain("u7-refresh");

      const after = execFileSync("icacls", [file], { encoding: "utf8" });
      expect(after).not.toContain("(I)");
      expect(after.match(/:\(/g)?.length).toBe(1);
      const me = execFileSync("whoami", { encoding: "utf8" }).trim().toLowerCase();
      expect(after.toLowerCase()).toContain(`${me}:(f)`);
      expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      await srv.close();
    }
  });
});

describe("client access token", () => {
  it("re-exchanges once on 401 and not on 403", async () => {
    const secret = "consailc_env_a_key";
    let tokenCalls = 0;
    let apiCalls = 0;
    const srv = await listen(async (req, res, url) => {
      if (url.pathname === "/oauth/token") {
        tokenCalls += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
          client_secret?: string;
        };
        if (body.client_secret !== secret) {
          return json(res, 401, { message: "invalid client credentials" });
        }
        return json(res, 200, {
          access_token: `access-${tokenCalls}`,
          expires_in: 900,
          token_type: "Bearer",
        });
      }
      apiCalls += 1;
      if (apiCalls === 1) return json(res, 401, { message: "unauthorized" });
      if (req.headers.authorization === `Bearer ${secret}`) {
        return json(res, 500, { message: "secret bearer" });
      }
      return json(res, 403, { message: "forbidden" });
    });
    try {
      const client = new ConsailClient({
        baseUrl: srv.baseUrl,
        clientSecret: secret,
        clientId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        accessToken: "",
        expiresAt: 0,
        principal: "client",
        configHome: "",
        timeoutMs: 3000,
      });
      await expect(client.getJson("/api/v1/auth/client")).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(tokenCalls).toBe(2);
      expect(apiCalls).toBe(2);
      const before = tokenCalls;
      await expect(client.getJson("/api/v1/auth/client")).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(tokenCalls).toBe(before);
    } finally {
      await srv.close();
    }
  });
});
