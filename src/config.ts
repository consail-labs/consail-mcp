import path from "node:path";
import { peekSession } from "./session.js";

/**
 * Runtime config for the Consail MCP server.
 * The client secret comes only from the environment (never from tool args).
 */
export type ConsailConfig = {
  baseUrl: string;
  clientSecret: string;
  clientId: string;
  accessToken: string;
  expiresAt: number;
  principal: "client" | "user";
  configHome: string;
  timeoutMs: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configHomeFrom(env: Record<string, string | undefined>): string {
  if (process.platform === "win32") return (env.APPDATA ?? "").trim();
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  if (xdg) return xdg;
  const home = (env.HOME ?? env.USERPROFILE ?? "").trim();
  return home ? path.join(home, ".config") : "";
}

function blankCredential(baseUrl: string, timeoutMs: number): ConsailConfig {
  return {
    baseUrl,
    clientSecret: "",
    clientId: "",
    accessToken: "",
    expiresAt: 0,
    principal: "user",
    configHome: "",
    timeoutMs,
  };
}

/**
 * Load and validate config. Fail-closed: missing URL or a non-client secret throws.
 * A user API key (consail_) is rejected. An empty secret uses the CLI session file.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): ConsailConfig {
  const baseUrl = (env.CONSAIL_URL ?? "").trim().replace(/\/+$/, "");
  const clientSecret = (env.CONSAIL_CLIENT_SECRET ?? "").trim();
  const timeoutRaw = (env.CONSAIL_TIMEOUT_MS ?? "").trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;

  if (!baseUrl) {
    throw new ConfigError(
      "CONSAIL_URL is required (e.g. https://api.consail.com or http://localhost:8080)"
    );
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ConfigError("CONSAIL_URL must start with http:// or https://");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError("CONSAIL_TIMEOUT_MS must be a positive number");
  }
  if (!clientSecret) {
    const configHome = configHomeFrom(env);
    if (!configHome) {
      throw new ConfigError("CONSAIL_CLIENT_SECRET is required, or run consail login");
    }
    let session: ReturnType<typeof peekSession>;
    try {
      session = peekSession(configHome, baseUrl);
    } catch (err) {
      throw new ConfigError(err instanceof Error ? err.message : "credential file is unreadable");
    }
    if (!session) {
      throw new ConfigError("CONSAIL_CLIENT_SECRET is required, or run consail login");
    }
    const cfg = blankCredential(baseUrl, timeoutMs);
    cfg.configHome = configHome;
    cfg.accessToken = session.access_token;
    cfg.expiresAt = Date.parse(session.expires_at) || 0;
    return cfg;
  }
  if (clientSecret.startsWith("consail_") && !clientSecret.startsWith("consailc_")) {
    throw new ConfigError(
      "CONSAIL_CLIENT_SECRET must be an API client secret (consailc_), not a user API key (consail_)"
    );
  }
  if (!clientSecret.startsWith("consailc_")) {
    throw new ConfigError("CONSAIL_CLIENT_SECRET must start with consailc_");
  }
  const clientId = (env.CONSAIL_CLIENT_ID ?? "").trim();
  if (!CLIENT_ID.test(clientId)) {
    throw new ConfigError("CONSAIL_CLIENT_ID must be the API client UUID");
  }

  return {
    ...blankCredential(baseUrl, timeoutMs),
    clientSecret,
    clientId,
    principal: "client",
  };
}
