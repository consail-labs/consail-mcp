import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ClientIdentity, ConsailClient } from "./client.js";
import { clampPreviewRows, PREVIEW_DEFAULT_ROWS, PREVIEW_HARD_CAP } from "./caps.js";
import { toolErrorText } from "./errors.js";

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

function hasCap(identity: ClientIdentity, name: string): boolean {
  return identity.capabilities.includes(name);
}

function grantIds(identity: ClientIdentity, capability: string): string[] {
  return identity.grants
    .filter((g) => g.capability === capability && g.resource_id)
    .map((g) => g.resource_id as string);
}

function assertGranted(ids: string[], ref: string, label: string): void {
  if (!ids.includes(ref)) {
    throw new Error(`${label} is not in this client's grants`);
  }
}

/**
 * Register a tool only when the probed identity includes the capability.
 * Arguments cannot name a dataset, pipeline, or environment outside that grant list.
 */
export function registerTools(
  server: McpServer,
  client: ConsailClient,
  identity: ClientIdentity
): void {
  server.registerTool(
    "status",
    {
      description:
        "Check Consail connectivity for this API client: identity, bound environment, and stats.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const me = await client.getJson<{ client: ClientIdentity }>("/api/v1/auth/me");
        const envs = await client.getJson<EnvItem[]>("/api/v1/environments");
        const list = Array.isArray(envs) ? envs : [];
        const env = list.find((e) => e.id === identity.environment_id) ?? list[0] ?? null;
        const stats = identity.environment_id
          ? await client.getJson<EnvStats>(`/api/v1/environments/${identity.environment_id}/stats`)
          : null;
        return okJson({ client: me.client, environment: env, stats });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "env_list",
    {
      description: "Return the environment this API client is bound to.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const items = await client.getJson<EnvItem[]>("/api/v1/environments");
        return okJson(Array.isArray(items) ? items : []);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  if (hasCap(identity, "dataset_read")) {
    const datasets = grantIds(identity, "dataset_read");
    server.registerTool(
      "catalog_list",
      {
        description: "List catalogs that own this client's granted datasets.",
        inputSchema: z.object({}),
      },
      async () => {
        try {
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
        description: "List datasets granted to this client. Optionally filter by catalog alias.",
        inputSchema: z.object({
          catalog: z.string().optional().describe("Optional catalog alias filter"),
        }),
      },
      async ({ catalog }) => {
        try {
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
        description: "Get one granted dataset by id. The id must already be in dataset_read.",
        inputSchema: z.object({
          ref: z.string().min(1).describe("Granted dataset id"),
        }),
      },
      async ({ ref }) => {
        try {
          assertGranted(datasets, ref, "dataset");
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
        description: `Preview a granted dataset. Default ${PREVIEW_DEFAULT_ROWS} rows; hard cap ${PREVIEW_HARD_CAP}.`,
        inputSchema: z.object({
          ref: z.string().min(1).describe("Granted dataset id"),
          rows: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              `Row count (default ${PREVIEW_DEFAULT_ROWS}, hard cap ${PREVIEW_HARD_CAP})`
            ),
        }),
      },
      async ({ ref, rows }) => {
        try {
          assertGranted(datasets, ref, "dataset");
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
  }

  if (identity.capabilities.length > 0) {
    server.registerTool(
      "action_list",
      {
        description: "List actions in the bound environment. Bundle URIs are not returned to clients.",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const items = await client.listAll<Record<string, unknown>>("/api/v1/actions");
          return okJson({ items, total: items.length });
        } catch (err) {
          return errResult(err);
        }
      }
    );
  }

  if (hasCap(identity, "pipeline_read")) {
    const pipelines = grantIds(identity, "pipeline_read");
    server.registerTool(
      "pipeline_get",
      {
        description: "Get one granted pipeline by id.",
        inputSchema: z.object({
          ref: z.string().min(1).describe("Granted pipeline id"),
        }),
      },
      async ({ ref }) => {
        try {
          assertGranted(pipelines, ref, "pipeline");
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
          "Validate pipeline YAML. Dataset references outside dataset_read are rejected by Core.",
        inputSchema: z.object({
          definition_yaml: z.string().min(1).describe("Pipeline definition YAML"),
        }),
      },
      async ({ definition_yaml }) => {
        try {
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

  if (hasCap(identity, "ask")) {
    const askDatasets = grantIds(identity, "ask");
    server.registerTool(
      "ask",
      {
        description:
          "Ask a question over granted datasets. SQL is not accepted. The server runs sql_only.",
        inputSchema: z.object({
          question: z.string().min(1),
          dataset_ids: z
            .array(z.string())
            .optional()
            .describe("Optional subset of dataset ids already granted for ask"),
        }),
      },
      async ({ question, dataset_ids }) => {
        try {
          if (dataset_ids) {
            for (const id of dataset_ids) {
              assertGranted(askDatasets, id, "dataset");
            }
          }
          const result = await client.postJson<Record<string, unknown>>("/api/v1/ask", {
            question,
            ...(dataset_ids ? { dataset_ids } : {}),
            mode: "sql_only",
          });
          return okJson(result);
        } catch (err) {
          return errResult(err);
        }
      }
    );
  }
}

/** Read tools shipped when the matching grants are present. */
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

/** Tools that must never exist in this slice. */
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
  "execute",
] as const;
