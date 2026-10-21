/**
 * Runtime config for the Consail MCP server.
 * The client secret comes only from the environment (never from tool args).
 */
export type ConsailConfig = {
  baseUrl: string;
  clientSecret: string;
  timeoutMs: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Load and validate config. Fail-closed: missing URL or a non-client secret throws.
 * A user API key (consail_) is rejected. The bound environment is the client's, not a header.
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
  if (!clientSecret) {
    throw new ConfigError(
      "CONSAIL_CLIENT_SECRET is required (consailc_ API client secret)"
    );
  }
  if (clientSecret.startsWith("consail_") && !clientSecret.startsWith("consailc_")) {
    throw new ConfigError(
      "CONSAIL_CLIENT_SECRET must be an API client secret (consailc_), not a user API key (consail_)"
    );
  }
  if (!clientSecret.startsWith("consailc_")) {
    throw new ConfigError("CONSAIL_CLIENT_SECRET must start with consailc_");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError("CONSAIL_TIMEOUT_MS must be a positive number");
  }

  return { baseUrl, clientSecret, timeoutMs };
}
