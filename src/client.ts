import type { ConsailConfig } from "./config.js";
import { ConfigError } from "./config.js";
import { ConsailApiError } from "./errors.js";
import { loadFreshSession, type StoredSession } from "./session.js";

export type ClientGrant = {
  capability: string;
  resource_id?: string;
};

export type ClientIdentity = {
  id: string;
  environment_id: string;
  capabilities: string[];
  grants: ClientGrant[];
  principal?: "client" | "user";
};

export type RequestOptions = {
  signal?: AbortSignal;
};

/**
 * Thin Consail HTTP API client.
 * Auth: Bearer access token. A client secret is exchanged at /oauth/token and is not
 * sent on tool calls. The server pins an API client's environment, so this process
 * does not send X-Consail-Environment.
 */
// Same wording as the CLI, so the user knows how to recover.
export const SESSION_ENDED = "CLI session ended. Run consail login.";

export class ConsailClient {
  constructor(private readonly cfg: ConsailConfig) {}

  get config(): ConsailConfig {
    return this.cfg;
  }

  async getJson<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.requestJson<T>("GET", path, undefined, opts);
  }

  async postJson<T = unknown>(
    path: string,
    body: unknown,
    opts: RequestOptions = {}
  ): Promise<T> {
    return this.requestJson<T>("POST", path, body, opts);
  }

  /**
   * Paginate Consail list endpoints that return { items, total } or raw arrays.
   * Mirrors consail-cli fetchAll behaviour for common shapes.
   */
  async listAll<T>(path: string, opts: RequestOptions = {}): Promise<T[]> {
    const u = new URL(path, "http://local.invalid");
    const basePath = u.pathname;
    const params = u.searchParams;

    const collected: T[] = [];
    let skip = 0;
    const top = 100;

    for (;;) {
      params.set("top", String(top));
      params.set("skip", String(skip));
      const qs = params.toString();
      const pagePath = qs ? `${basePath}?${qs}` : basePath;
      const data = await this.getJson<unknown>(pagePath, opts);

      if (Array.isArray(data)) {
        collected.push(...(data as T[]));
        break;
      }

      if (data && typeof data === "object" && "items" in data) {
        const page = data as { items: T[]; total?: number };
        collected.push(...(page.items ?? []));
        const total = page.total ?? collected.length;
        if (collected.length >= total || (page.items?.length ?? 0) < top) {
          break;
        }
        skip += top;
        continue;
      }

      break;
    }

    return collected;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body: unknown | undefined,
    opts: RequestOptions
  ): Promise<T> {
    assertAllowedRoute(method, path);
    await this.ensureToken(false);
    return this.send(method, path, body, opts, false);
  }

  private canRefresh(): boolean {
    if (this.cfg.principal === "user") return this.cfg.configHome !== "";
    return Boolean(this.cfg.clientSecret && this.cfg.clientId);
  }

  // A 403 does not refresh. A 401 re-exchanges or refreshes once.
  private async ensureToken(force: boolean): Promise<void> {
    const fresh =
      Boolean(this.cfg.accessToken) &&
      this.cfg.expiresAt > 0 &&
      Date.now() + 60_000 < this.cfg.expiresAt;
    if (fresh && !force) return;
    if (this.cfg.principal === "user") {
      if (!this.cfg.configHome) throw new ConsailApiError(401, SESSION_ENDED);
      const next = await loadFreshSession(
        this.cfg.configHome,
        this.cfg.baseUrl,
        force || !fresh,
        (current) => refreshUserSession(this.cfg, current)
      );
      if (!next?.access_token) throw new ConsailApiError(401, SESSION_ENDED);
      this.cfg.accessToken = next.access_token;
      this.cfg.expiresAt = Date.parse(next.expires_at) || 0;
      return;
    }
    if (!this.cfg.clientSecret || !this.cfg.clientId) {
      throw new ConsailApiError(401, "not authenticated");
    }
    const tok = await exchangeClient(this.cfg);
    this.cfg.accessToken = tok.accessToken;
    this.cfg.expiresAt = tok.expiresAt;
  }

  private async send<T>(
    method: string,
    path: string,
    body: unknown | undefined,
    opts: RequestOptions,
    retried: boolean
  ): Promise<T> {
    const url = this.cfg.baseUrl + (path.startsWith("/") ? path : `/${path}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      Accept: "application/json",
      "User-Agent": "consail-mcp/0.1.0",
    };

    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;

    try {
      const res = await fetch(url, { method, headers, body: payload, signal });
      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (res.status === 401 && !retried && this.canRefresh()) {
        await this.ensureToken(true);
        return this.send(method, path, body, opts, true);
      }

      if (res.status >= 300) {
        throw new ConsailApiError(
          res.status,
          extractErrorMessage(parsed, res.status),
          extractErrorDetail(parsed)
        );
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof ConsailApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ConsailApiError(408, "request timed out");
      }
      throw new ConsailApiError(
        0,
        err instanceof Error ? err.message : "network error"
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function exchangeClient(
  cfg: ConsailConfig
): Promise<{ accessToken: string; expiresAt: number }> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "consail-mcp/0.1.0",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw new ConsailApiError(0, err instanceof Error ? err.message : "network error");
  }
  if (!res.ok) {
    throw new ConsailApiError(res.status, `token request failed: ${res.status}`);
  }
  const parsed = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!parsed.access_token) {
    throw new ConsailApiError(res.status, "token response missing access_token");
  }
  const seconds = Number(parsed.expires_in ?? 0);
  return {
    accessToken: parsed.access_token,
    expiresAt: seconds > 0 ? Date.now() + seconds * 1000 : 0,
  };
}

async function refreshUserSession(
  cfg: ConsailConfig,
  current: StoredSession
): Promise<StoredSession | "ended"> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "consail-mcp/0.1.0",
      },
      body: JSON.stringify({ refresh_token: current.refresh_token }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw new ConsailApiError(0, err instanceof Error ? err.message : "network error");
  }
  if (res.status === 401) return "ended";
  if (!res.ok) {
    throw new ConsailApiError(res.status, `refresh failed: ${res.status}`);
  }
  const parsed = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!parsed.access_token || !parsed.refresh_token) {
    throw new ConsailApiError(res.status, "refresh response missing tokens");
  }
  const seconds = Number(parsed.expires_in ?? 0);
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_at: new Date(Date.now() + Math.max(seconds, 0) * 1000).toISOString(),
  };
}

/** Startup probe. Non-2xx throws before tools are registered. */
export async function probeIdentity(cfg: ConsailConfig): Promise<ClientIdentity> {
  const client = new ConsailClient(cfg);
  const probePath =
    cfg.principal === "user" ? "/api/v1/auth/me" : "/api/v1/auth/client";
  let body: { client?: ClientIdentity; user?: { id?: string } };
  try {
    body = await client.getJson(probePath);
  } catch (err) {
    const status = err instanceof ConsailApiError ? err.statusCode : 0;
    throw new ConfigError(
      `startup probe GET ${probePath} failed (${status || "network"})`
    );
  }
  if (cfg.principal === "user") {
    if (!body?.user?.id) {
      throw new ConfigError("startup probe did not return a user");
    }
    return {
      id: body.user.id,
      environment_id: "",
      capabilities: ["dataset_read", "pipeline_read", "ask"],
      grants: [],
      principal: "user",
    };
  }
  if (!body?.client?.id || !Array.isArray(body.client.capabilities)) {
    throw new ConfigError("startup probe did not return an API client");
  }
  if (!Array.isArray(body.client.grants)) {
    body.client.grants = [];
  }
  body.client.principal = "client";
  return body.client;
}

function assertAllowedRoute(method: string, path: string): void {
  const pathname = new URL(path, "http://local.invalid").pathname;
  const get = method === "GET";
  const allowed =
    (get && pathname === "/api/v1/auth/client") ||
    (get && pathname === "/api/v1/auth/me") ||
    (get && pathname === "/api/v1/environments") ||
    (get && /^\/api\/v1\/environments\/[^/]+$/.test(pathname)) ||
    (get && /^\/api\/v1\/environments\/[^/]+\/stats$/.test(pathname)) ||
    (get && pathname === "/api/v1/datasets") ||
    (get &&
      /^\/api\/v1\/datasets\/[^/]+$/.test(pathname) &&
      pathname !== "/api/v1/datasets/tags") ||
    (get && /^\/api\/v1\/datasets\/[^/]+\/preview$/.test(pathname)) ||
    (get && pathname === "/api/v1/catalogs") ||
    (get && /^\/api\/v1\/pipelines\/[^/]+$/.test(pathname)) ||
    (method === "POST" && pathname === "/api/v1/pipelines/validate") ||
    (get && pathname === "/api/v1/actions") ||
    (method === "POST" && pathname === "/api/v1/ask");
  if (!allowed) {
    throw new ConsailApiError(403, `route not allowed for MCP: ${method} ${pathname}`);
  }
}

function extractErrorMessage(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (typeof o.message === "string" && o.message) return o.message;
    if (typeof o.error === "string" && o.error) return o.error;
  }
  return `HTTP ${status}`;
}

function extractErrorDetail(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (typeof o.detail === "string") return o.detail;
  }
  return undefined;
}
