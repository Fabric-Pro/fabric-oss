import { db, fetchCredentialsByIdInTenant } from "@repo/database";
import {
	type DatabricksVectorSearchChunk,
	MAX_QUERY_INDEXES,
	queryDatabricksVectorIndexes,
} from "@repo/integrations/databricks-vector-search";
import { Context } from "@temporalio/activity";

// Ticks a Temporal activity heartbeat while `fn` is in flight, so a search
// that spans multiple OAuth/index round-trips isn't cancelled by the 30s
// heartbeatTimeout on its proxy (packages/temporal/src/workflows/orchestrator/phases/iterative-execution.ts)
// even though the 5-minute startToClose would otherwise allow it to finish.
// No-ops outside an activity context (e.g. unit tests calling this directly).
const HEARTBEAT_INTERVAL_MS = 10_000;

async function withActivityHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
	let context: ReturnType<typeof Context.current> | undefined;
	try {
		context = Context.current();
	} catch {
		context = undefined;
	}

	if (!context) {
		return fn();
	}

	const interval = setInterval(() => {
		context?.heartbeat();
	}, HEARTBEAT_INTERVAL_MS);
	interval.unref?.();

	try {
		return await fn();
	} finally {
		clearInterval(interval);
	}
}

// Binding merge/naming helpers live in the dependency-free
// `databricks-binding-utils` module so call sites that keep the Databricks
// client out of their static import graph (agent-executor.ts) can import
// them without dragging this module's static
// `@repo/integrations/databricks-vector-search` import along. Re-exported
// here for the sites that already need the heavy module anyway.
export {
	type AgentDatabricksBinding,
	databricksKnowledgeToolName,
	mergeDatabricksBindings,
} from "./databricks-binding-utils";

import type { AgentDatabricksBinding } from "./databricks-binding-utils";

export interface LoadAgentDatabricksBindingsInput {
	instanceId: string;
	userId: string;
	organizationId?: string;
}

export interface DatabricksKnowledgeToolDefinition {
	name: "search_databricks_indexes";
	description: string;
	inputSchema: {
		type: "object";
		required: ["query"];
		properties: {
			query: {
				type: "string";
				description: string;
			};
			num_results: {
				type: "number";
				minimum: 1;
				maximum: 50;
				description: string;
			};
		};
	};
}

export interface ExecuteDatabricksKnowledgeSearchArgs {
	query?: unknown;
	num_results?: unknown;
}

export interface ExecuteDatabricksKnowledgeSearchTenant {
	userId: string;
	organizationId?: string;
}

export interface DatabricksKnowledgeSearchResult {
	summary: string;
	chunks: DatabricksVectorSearchChunk[];
	failures: string[];
	skippedIndexes: string[];
}

/**
 * Loads Databricks knowledge bindings through the owning agent instance.
 * The configuration rows have no tenant columns, so the instance query is the
 * authorization boundary and must remain XOR-scoped.
 */
export async function loadAgentDatabricksBindings(
	input: LoadAgentDatabricksBindingsInput,
): Promise<AgentDatabricksBinding[]> {
	const instance = await db.agentTemplateInstance.findFirst({
		where: {
			id: input.instanceId,
			...(input.organizationId
				? { organizationId: input.organizationId }
				: { userId: input.userId, organizationId: null }),
		},
		include: {
			integrationConfigurations: {
				where: { isEnabled: true },
			},
		},
	});

	if (!instance) {
		return [];
	}

	return instance.integrationConfigurations.flatMap((configuration) => {
		if (
			configuration.integrationType.toUpperCase() !==
			"DATABRICKS_VECTOR_SEARCH"
		) {
			return [];
		}

		const resources = configuration.allowedResources as {
			schema?: unknown;
			indexes?: unknown;
		} | null;
		const indexNames = Array.isArray(resources?.indexes)
			? resources.indexes.filter(
					(indexName): indexName is string =>
						typeof indexName === "string" && indexName.length > 0,
				)
			: [];
		if (indexNames.length === 0) {
			return [];
		}

		return [
			{
				integrationId: configuration.integrationId,
				schema:
					typeof resources?.schema === "string"
						? resources.schema
						: "unknown",
				indexNames,
			},
		];
	});
}

export function buildDatabricksKnowledgeToolDefinition(
	binding: AgentDatabricksBinding,
): DatabricksKnowledgeToolDefinition {
	return {
		name: "search_databricks_indexes",
		description: `Search the team's Databricks vector knowledge base (schema ${binding.schema}; indexes: ${binding.indexNames.join(", ")}). Use for questions about the indexed corpus; returns relevant text chunks with similarity scores.`,
		inputSchema: {
			type: "object",
			required: ["query"],
			properties: {
				query: {
					type: "string",
					description: "Natural-language search query",
				},
				num_results: {
					type: "number",
					minimum: 1,
					maximum: 50,
					description: "Max chunks to return (default 8)",
				},
			},
		},
	};
}

export async function executeDatabricksKnowledgeSearch(
	binding: Pick<AgentDatabricksBinding, "integrationId" | "indexNames">,
	args: ExecuteDatabricksKnowledgeSearchArgs,
	tenant: ExecuteDatabricksKnowledgeSearchTenant,
): Promise<DatabricksKnowledgeSearchResult> {
	const { chunks, failures, skippedIndexes, credentials } =
		await withActivityHeartbeat(async () => {
			const credentials = await fetchCredentialsByIdInTenant(
				binding.integrationId,
				tenant.userId,
				tenant.organizationId,
			);
			if (!credentials) {
				return {
					credentials: null,
					chunks: [],
					failures: [],
					skippedIndexes: [],
				};
			}

			const result = await queryDatabricksVectorIndexes(credentials, {
				indexNames: binding.indexNames,
				query: String(args.query ?? ""),
				numResults:
					typeof args.num_results === "number"
						? Math.max(
								1,
								Math.min(50, Math.floor(args.num_results)),
							)
						: undefined,
			});
			return { credentials, ...result };
		});

	if (!credentials) {
		return {
			summary:
				"Databricks integration not found or credentials unavailable",
			chunks: [],
			failures: [],
			skippedIndexes: [],
		};
	}

	let summary =
		chunks.length === 0
			? "No matching content found in the Databricks knowledge base."
			: chunks
					.map(
						(chunk) =>
							`[${chunk.indexName} #${chunk.id}] (score ${chunk.score.toFixed(3)}) ${chunk.content}`,
					)
					.join("\n\n");
	const queriedCount =
		new Set(binding.indexNames).size - skippedIndexes.length;
	if (failures.length > 0) {
		summary += `\n\n⚠ ${failures.length} of ${queriedCount} indexes unavailable: ${failures.join("; ")}`;
	}
	if (skippedIndexes.length > 0) {
		summary += `\n\n⚠ ${skippedIndexes.length} selected index(es) beyond the ${MAX_QUERY_INDEXES}-index limit were not searched: ${skippedIndexes.join(", ")}`;
	}

	return { summary, chunks, failures, skippedIndexes };
}

export interface DatabricksKnowledgeSearchToolResult {
	response: string;
	chunkCount?: number;
	failures?: string[];
	skippedIndexes?: string[];
	error?: string;
}

/**
 * Tool-facing wrapper around {@link executeDatabricksKnowledgeSearch} that
 * never throws. `queryDatabricksVectorIndexes` throws when every selected
 * index fails, which — left uncaught inside the AI SDK tool `execute` —
 * surfaces as a `tool-error` stream part; the direct-chat stream loop only
 * handles `tool-result`, so the recorded tool call is stuck "running" and
 * the UI spinner never resolves. Catch here and return a structured failure
 * in the same shape as other built-in tools (e.g. project_rag_query).
 */
export async function executeDatabricksKnowledgeSearchSafe(
	binding: Pick<AgentDatabricksBinding, "integrationId" | "indexNames">,
	args: ExecuteDatabricksKnowledgeSearchArgs,
	tenant: ExecuteDatabricksKnowledgeSearchTenant,
): Promise<DatabricksKnowledgeSearchToolResult> {
	try {
		const result = await executeDatabricksKnowledgeSearch(
			binding,
			args,
			tenant,
		);
		return {
			response: result.summary,
			chunkCount: result.chunks.length,
			failures: result.failures,
			skippedIndexes: result.skippedIndexes,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			error: message,
			response: `Databricks knowledge search failed: ${message}`,
		};
	}
}

export interface ExecuteDatabricksKnowledgeSearchActivityInput {
	binding: Pick<AgentDatabricksBinding, "integrationId" | "indexNames">;
	args: ExecuteDatabricksKnowledgeSearchArgs;
	userId: string;
	organizationId?: string;
}

export async function executeDatabricksKnowledgeSearchActivity(
	input: ExecuteDatabricksKnowledgeSearchActivityInput,
): Promise<DatabricksKnowledgeSearchResult> {
	return executeDatabricksKnowledgeSearch(input.binding, input.args, {
		userId: input.userId,
		organizationId: input.organizationId,
	});
}
