import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsailClient, SESSION_ENDED } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { ConsailApiError, toolErrorText } from "../src/errors.js";
import { credentialFile } from "../src/session.js";

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

describe("revoked CLI session (MC-05)", () => {
  it("tells the user to run consail login and drops the entry", async () => {
    let refreshes = 0;
    const srv = await listen(async (_req, res, url) => {
      if (url.pathname === "/api/v1/auth/refresh") {
        refreshes += 1;
        return json(res, 401, { message: "refresh token revoked" });
      }
      return json(res, 401, { message: "session revoked" });
    });
    try {
      const home = mkdtempSync(path.join(tmpdir(), "mcp-ended-"));
      const file = credentialFile(home);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            [srv.baseUrl]: {
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
      const cfg = loadConfig({
        CONSAIL_URL: srv.baseUrl,
        CONSAIL_CLIENT_SECRET: "",
        APPDATA: home,
        XDG_CONFIG_HOME: home,
        HOME: home,
      });
      const client = new ConsailClient(cfg);
      const err = await client.getJson("/api/v1/auth/me").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConsailApiError);
      expect((err as ConsailApiError).statusCode).toBe(401);
      expect((err as ConsailApiError).message).toBe(SESSION_ENDED);
      expect(toolErrorText(err)).toContain("Run consail login.");
      expect(refreshes).toBe(1);
      expect(readFileSync(file, "utf8")).not.toContain(srv.baseUrl);
    } finally {
      await srv.close();
    }
  });
});
