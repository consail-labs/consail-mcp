/**
 * Runtime config for the Consail MCP server.
 * Credentials come only from environment variables (never from tool args).
 */
export type ConsailConfig = {
  baseUrl: string;
  apiKey: string;
  environment: string;
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
 * Load and validate config. Fail-closed: missing/invalid key or URL throws.
 * Environment may be empty for tenant-level tools (env_list); data tools check separately.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): ConsailConfig {
  const baseUrl = (env.CONSAIL_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (env.CONSAIL_API_KEY ?? "").trim();
  const environment = (env.CONSAIL_ENVIRONMENT ?? "").trim();
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
  if (!apiKey) {
    throw new ConfigError("CONSAIL_API_KEY is required (consail_* API key)");
  }
  if (!apiKey.startsWith("consail_")) {
    throw new ConfigError(
      "CONSAIL_API_KEY must be a Consail API key with the consail_ prefix"
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError("CONSAIL_TIMEOUT_MS must be a positive number");
  }

  return { baseUrl, apiKey, environment, timeoutMs };
}

export function requireEnvironment(cfg: ConsailConfig): string {
  if (!cfg.environment) {
    throw new ConfigError(
      "CONSAIL_ENVIRONMENT is required for this tool (environment slug binding)"
    );
  }
  return cfg.environment;
}
