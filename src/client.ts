import type { ConsailConfig } from "./config.js";
import { ConsailApiError } from "./errors.js";

export type RequestOptions = {
  /** When false, omit X-Consail-Environment (tenant-level endpoints). Default: send when env set. */
  withEnvironment?: boolean;
  signal?: AbortSignal;
};

/**
 * Thin Consail HTTP API client. Maps 1:1 to existing REST endpoints.
 * Auth: Bearer consail_* + optional X-Consail-Environment.
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
    const url = this.cfg.baseUrl + (path.startsWith("/") ? path : `/${path}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      Accept: "application/json",
      "User-Agent": "consail-mcp/0.1.0",
    };

    const withEnv = opts.withEnvironment !== false;
    if (withEnv && this.cfg.environment) {
      headers["X-Consail-Environment"] = this.cfg.environment;
    }

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
