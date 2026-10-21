import type { ConsailConfig } from "./config.js";
import { ConfigError } from "./config.js";
import { ConsailApiError } from "./errors.js";

export type ClientGrant = {
  capability: string;
  resource_id?: string;
};

export type ClientIdentity = {
  id: string;
  environment_id: string;
  capabilities: string[];
  grants: ClientGrant[];
};

export type RequestOptions = {
  signal?: AbortSignal;
};

/**
 * Thin Consail HTTP API client.
 * Auth: Bearer consailc_ client secret. The server pins the client's environment,
 * so this process does not send X-Consail-Environment.
 */
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
    const url = this.cfg.baseUrl + (path.startsWith("/") ? path : `/${path}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.clientSecret}`,
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

/** Startup probe. Non-2xx throws before tools are registered. */
export async function probeIdentity(cfg: ConsailConfig): Promise<ClientIdentity> {
  const client = new ConsailClient(cfg);
  let body: { client?: ClientIdentity };
  try {
    body = await client.getJson("/api/v1/auth/me");
  } catch (err) {
    const status = err instanceof ConsailApiError ? err.statusCode : 0;
    throw new ConfigError(
      `startup probe GET /api/v1/auth/me failed (${status || "network"})`
    );
  }
  if (!body?.client?.id || !Array.isArray(body.client.capabilities)) {
    throw new ConfigError("startup probe did not return an API client");
  }
  if (!Array.isArray(body.client.grants)) {
    body.client.grants = [];
  }
  return body.client;
}

function assertAllowedRoute(method: string, path: string): void {
  const pathname = new URL(path, "http://local.invalid").pathname;
  const get = method === "GET";
  const allowed =
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
