import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConsailClient } from "./client.js";
import { clampPreviewRows, PREVIEW_DEFAULT_ROWS, PREVIEW_HARD_CAP } from "./caps.js";
import { requireEnvironment } from "./config.js";
import { toolErrorText } from "./errors.js";

type AuthUser = { id: string; email: string; name: string; role: string };
type EnvItem = {
  id: string;
  name: string;
  slug: string;
  env_type: string;
  description?: string;
  capabilities?: Record<string, boolean>;
};
type EnvStats = Record<string, number>;

function okJson(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errResult(err: unknown) {
  return {
    content: [{ type: "text" as const, text: toolErrorText(err) }],
    isError: true as const,
  };
}

async function resolveEnv(
  client: ConsailClient,
  slugOrId: string
): Promise<EnvItem | null> {
  const items = await client.getJson<EnvItem[]>("/api/v1/environments", {
    withEnvironment: false,
  });
  const list = Array.isArray(items) ? items : [];
  return list.find((e) => e.slug === slugOrId || e.id === slugOrId) ?? null;
}

/**
 * Register Phase A read/validate tools. Never registers writes, secret_get, SQL, or run.
 */
export function registerTools(server: McpServer, client: ConsailClient): void {
  server.registerTool(
    "status",
    {
      description:
        "Check Consail connectivity, authenticated user, bound environment, capabilities, and resource counts.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const envSlug = requireEnvironment(client.config);
        const me = await client.getJson<{ user: AuthUser }>("/api/v1/auth/me", {
          withEnvironment: false,
        });
        const env = await resolveEnv(client, envSlug);
        if (!env) {
          throw new Error(`environment ${JSON.stringify(envSlug)} not found or not accessible`);
        }
        const stats = await client.getJson<EnvStats>(
          `/api/v1/environments/${env.id}/stats`,
          { withEnvironment: false }
        );
        return okJson({
          user: me.user,
          environment: env,
          stats,
          bound_environment: envSlug,
        });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "env_list",
    {
      description:
        "List environments accessible to the API key (tenant-level; no environment header).",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const items = await client.getJson<EnvItem[]>("/api/v1/environments", {
          withEnvironment: false,
        });
        return okJson(Array.isArray(items) ? items : []);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "catalog_list",
    {
      description: "List catalogs in the bound environment.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        requireEnvironment(client.config);
        const items = await client.listAll<Record<string, unknown>>("/api/v1/catalogs");
        return okJson({ items, total: items.length });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "dataset_list",
    {
      description:
        "List datasets in the bound environment. Optionally filter by catalog alias.",
      inputSchema: z.object({
        catalog: z
          .string()
          .optional()
          .describe("Optional catalog alias filter"),
      }),
    },
    async ({ catalog }) => {
      try {
        requireEnvironment(client.config);
        const path = catalog
          ? `/api/v1/datasets?catalog=${encodeURIComponent(catalog)}`
          : "/api/v1/datasets";
        const items = await client.listAll<Record<string, unknown>>(path);
        return okJson({ items, total: items.length });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "dataset_get",
    {
      description:
        "Get dataset details by UUID or catalog-alias.dataset-alias in the bound environment.",
      inputSchema: z.object({
        ref: z
          .string()
          .min(1)
          .describe("Dataset UUID or catalog.alias reference"),
      }),
    },
    async ({ ref }) => {
      try {
        requireEnvironment(client.config);
        const detail = await client.getJson<Record<string, unknown>>(
          `/api/v1/datasets/${encodeURIComponent(ref)}`
        );
        return okJson(detail);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "dataset_preview",
    {
      description: `Preview dataset schema and sample rows in the bound environment. Default ${PREVIEW_DEFAULT_ROWS} rows; hard cap ${PREVIEW_HARD_CAP}. Never returns secrets.`,
      inputSchema: z.object({
        ref: z
          .string()
          .min(1)
          .describe("Dataset UUID or catalog.alias reference"),
        rows: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Row count to fetch (default ${PREVIEW_DEFAULT_ROWS}, hard cap ${PREVIEW_HARD_CAP})`
          ),
      }),
    },
    async ({ ref, rows }) => {
      try {
        requireEnvironment(client.config);
        const effective = clampPreviewRows(rows);
        const preview = await client.getJson<Record<string, unknown>>(
          `/api/v1/datasets/${encodeURIComponent(ref)}/preview?rows=${effective}`
        );
        return okJson({
          ...preview,
          rows_requested: rows ?? PREVIEW_DEFAULT_ROWS,
          rows_effective: effective,
          rows_hard_cap: PREVIEW_HARD_CAP,
        });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "action_list",
    {
      description: "List actions installed in the bound environment.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        requireEnvironment(client.config);
        const items = await client.listAll<Record<string, unknown>>("/api/v1/actions");
        return okJson({ items, total: items.length });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "pipeline_get",
    {
      description: "Get a pipeline by slug or UUID in the bound environment.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Pipeline slug or UUID"),
      }),
    },
    async ({ ref }) => {
      try {
        requireEnvironment(client.config);
        const detail = await client.getJson<Record<string, unknown>>(
          `/api/v1/pipelines/${encodeURIComponent(ref)}`
        );
        return okJson(detail);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "pipeline_validate",
    {
      description:
        "Validate a pipeline definition YAML against the Consail API for the bound environment (no create/update).",
      inputSchema: z.object({
        definition_yaml: z
          .string()
          .min(1)
          .describe("Pipeline definition YAML body (definition_yaml)"),
      }),
    },
    async ({ definition_yaml }) => {
      try {
        requireEnvironment(client.config);
        const result = await client.postJson<Record<string, unknown>>(
          "/api/v1/pipelines/validate",
          { definition_yaml }
        );
        return okJson(result);
      } catch (err) {
        return errResult(err);
      }
    }
  );
}

/** Tool names shipped in Phase A (allowlist). */
export const PHASE_A_TOOLS = [
  "status",
  "env_list",
  "catalog_list",
  "dataset_list",
  "dataset_get",
  "dataset_preview",
  "action_list",
  "pipeline_get",
  "pipeline_validate",
] as const;

/** Tools that must never exist in Phase A. */
export const FORBIDDEN_TOOLS = [
  "secret_get",
  "secret_create",
  "secret_delete",
  "api_key_create",
  "api_key_delete",
  "pipeline_run",
  "run_get",
  "sql_query",
  "query",
  "raw_sql",
  "delete",
] as const;
