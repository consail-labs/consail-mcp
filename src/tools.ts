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
        "Find resources the caller can already see, newest first. An empty query lists them. kinds null searches every kind. limit is 1 to 20. An API client only sees granted datasets, catalogs that own those datasets, granted pipelines, and actions. Charts, dashboards, workflows, and runs are not returned to an API client.",
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
        "Fetch one resource. detail full is schema metadata for an API client and does not include row samples. source must be stored. An ungranted ref is not found.",
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
        "Look up app pages, workflow guides, docs, and formats. This does not read tenant data.",
      inputSchema: z.object({
        topic: z.enum(["page", "workflow", "doc", "format"]),
        key: z.string().nullable().default(null),
        query: z.string().nullable().default(null),
      }),
    },
    async (input) => callAssistantTool(client, "knowledge", knowledgeBody(input))
  );
}

/** Tools registered for every live identity. Core still enforces access. */
export const PHASE_A_TOOLS = [
  "status",
  "env_list",
  "search",
  "get_resource",
  "knowledge",
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
  "pipeline_run",
  "run_get",
  "sql_query",
  "query",
  "raw_sql",
  "delete",
  "execute",
] as const;
