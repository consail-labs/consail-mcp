import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ClientIdentity, ConsailClient } from "./client.js";
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

const resourceKinds = [
  "dataset",
  "catalog",
  "pipeline",
  "workflow",
  "chart",
  "dashboard",
  "run",
  "workflow_run",
  "action",
] as const;

type ToolPayload = {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

function searchBody(input: {
  query?: string;
  kinds?: string[] | null;
  limit?: number;
  offset?: number | null;
}) {
  return {
    query: input.query ?? "",
    kinds: input.kinds ?? null,
    limit: input.limit ?? 20,
    offset: input.offset ?? null,
  };
}

function resourceBody(input: {
  ref?: { kind?: string; id?: string };
  detail?: string;
  source?: string;
}) {
  return {
    ref: { kind: input.ref?.kind ?? "", id: input.ref?.id ?? "" },
    detail: input.detail ?? "metadata",
    source: input.source ?? "stored",
  };
}

function knowledgeBody(input: { topic?: string; key?: string | null; query?: string | null }) {
  return {
    topic: input.topic ?? "",
    key: input.key ?? null,
    query: input.query ?? null,
  };
}

async function callAssistantTool(
  client: ConsailClient,
  name: "search" | "get_resource" | "knowledge",
  args: unknown
): Promise<ToolPayload> {
  try {
    const result = await client.postJson<ToolPayload>(
      `/api/v1/assistant/tools/${name}/call`,
      args
    );
    if (!result || !Array.isArray(result.content)) {
      return errResult(new Error("tool result missing content"));
    }
    return result;
  } catch (err) {
    return errResult(err);
  }
}

/**
 * status and env_list stay local connectivity tools.
 * search, get_resource, and knowledge replace the old resource tools.
 * workflow_validate posts the existing validate route and does not save.
 * pipeline_run posts the existing run route. It does not create or edit the pipeline.
 * Core enforces grants. This server does not keep the old names.
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
        const me = await client.getJson<{ client?: ClientIdentity; user?: { id: string } }>(
          identity.principal === "user" ? "/api/v1/auth/me" : "/api/v1/auth/client"
        );
        const envs = await client.getJson<EnvItem[]>("/api/v1/environments");
        const list = Array.isArray(envs) ? envs : [];
        const env = list.find((e) => e.id === identity.environment_id) ?? list[0] ?? null;
        const stats = identity.environment_id
          ? await client.getJson<EnvStats>(`/api/v1/environments/${identity.environment_id}/stats`)
          : null;
        return okJson(
          identity.principal === "user"
            ? { user: me.user, environment: env, stats }
            : { client: me.client, environment: env, stats }
        );
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

  server.registerTool(
    "search",
    {
      description:
        "Find resources the caller can already see, newest first. An empty query lists them. kinds null searches every kind. limit is 1 to 20. A signed-in user has no grant list; search is how that session discovers pipelines, workflows, charts, dashboards, and runs. An API client sees granted datasets, catalogs that own those datasets, granted pipelines, actions, workflows whose pipeline refs are all in pipeline_read, charts and dashboards whose datasets are all in dataset_read, and runs it started of pipelines it is granted (run_read or pipeline_run). Workflow runs are not returned.",
      inputSchema: z.object({
        query: z.string().default(""),
        kinds: z.array(z.enum(resourceKinds)).nullable().default(null),
        limit: z.number().int().min(1).max(20).default(20),
        offset: z.number().int().nullable().default(null),
      }),
    },
    async (input) => callAssistantTool(client, "search", searchBody(input))
  );

  server.registerTool(
    "get_resource",
    {
      description:
        "Fetch one resource the caller can already see. detail full is schema metadata for an API client and does not include row samples. source must be stored. An ungranted ref is not found. For an API client, a workflow is not found when any pipeline ref is outside pipeline_read, a chart or dashboard is not found unless every dataset is in dataset_read, and a run is not found unless that client started it and its pipeline is granted.",
      inputSchema: z.object({
        ref: z.object({
          kind: z.enum(resourceKinds),
          id: z.string().min(1),
        }),
        detail: z.enum(["metadata", "full"]).default("metadata"),
        source: z.enum(["stored", "editor"]).default("stored"),
      }),
    },
    async (input) => callAssistantTool(client, "get_resource", resourceBody(input))
  );

  server.registerTool(
    "knowledge",
    {
      description:
        "Look up app pages, workflow guides, docs, and formats. This is general product context and does not read tenant data.",
      inputSchema: z.object({
        topic: z.enum(["page", "workflow", "doc", "format"]),
        key: z.string().nullable().default(null),
        query: z.string().nullable().default(null),
      }),
    },
    async (input) => callAssistantTool(client, "knowledge", knowledgeBody(input))
  );

  server.registerTool(
    "workflow_validate",
    {
      description:
        "Validate workflow YAML. Does not save it. For an API client every pipeline ref must be in pipeline_read. Unknown and ungranted refs are not found.",
      inputSchema: z.object({ yaml: z.string().min(1) }),
    },
    async ({ yaml }) => {
      try {
        const result = await client.postJson("/api/v1/workflows/validate", { yaml });
        return okJson(result);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "pipeline_run",
    {
      description:
        "Start a run of one pipeline. Does not create or edit the pipeline and does not return secrets. For an API client the pipeline must be in pipeline_run. Unknown and ungranted pipelines are not found. A pipeline granted only for read is forbidden. params are that pipeline's declared string, number, or boolean parameters.",
      inputSchema: z.object({
        id: z.string().min(1),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
      }),
    },
    async ({ id, params }) => {
      try {
        const body = params ? { params } : {};
        const result = await client.postJson(
          `/api/v1/pipelines/${encodeURIComponent(id)}/run`,
          body
        );
        return okJson(result);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "query_check",
    {
      description:
        "Run one read-only SQL query and report whether it succeeds. Returns column names, types, and the row count. Does not return cell values and does not turn a question into SQL. For an API client every dataset id must be in dataset_read. The environment must allow the query explorer.",
      inputSchema: z.object({
        sql: z.string().min(1),
        dataset_ids: z.array(z.string().min(1)).min(1),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
      }),
    },
    async ({ sql, dataset_ids, params }) => {
      try {
        const body: { sql: string; dataset_ids: string[]; max_rows: number; params?: Record<string, string | number | boolean> } = {
          sql,
          dataset_ids,
          max_rows: 1,
        };
        if (params) body.params = params;
        const result = await client.postJson("/api/v1/query", body);
        return okJson(queryCheckView(result));
      } catch (err) {
        return errResult(err);
      }
    }
  );
}

/** Column names and a count. Cell values from POST /api/v1/query stay here. */
function queryCheckView(payload: unknown): { ok: true; columns: { name: string; type: string }[]; row_count: number; truncated: boolean } {
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const columns = Array.isArray(body.columns)
    ? body.columns.map((col) => {
        const item = col && typeof col === "object" ? (col as Record<string, unknown>) : {};
        return {
          name: typeof item.name === "string" ? item.name : "",
          type: typeof item.type === "string" ? item.type : "",
        };
      })
    : [];
  return {
    ok: true,
    columns,
    row_count: typeof body.total_rows === "number" ? body.total_rows : 0,
    truncated: body.truncated === true,
  };
}

/** Tools registered for every live identity. Core still enforces access. */
export const PHASE_A_TOOLS = [
  "status",
  "env_list",
  "search",
  "get_resource",
  "knowledge",
  "workflow_validate",
  "pipeline_run",
  "query_check",
] as const;

/** Tools that must never exist in this slice. */
export const FORBIDDEN_TOOLS = [
  "ask",
  "catalog_list",
  "dataset_list",
  "dataset_get",
  "dataset_preview",
  "action_list",
  "pipeline_get",
  "pipeline_validate",
  "secret_get",
  "secret_create",
  "secret_delete",
  "api_key_create",
  "api_key_delete",
  "run_get",
  "sql_query",
  "query",
  "raw_sql",
  "delete",
  "execute",
] as const;
