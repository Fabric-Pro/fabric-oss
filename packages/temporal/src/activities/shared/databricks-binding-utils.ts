/**
 * Databricks binding merge + tool-naming helpers, plus the agent-executor's
 * search runner.
 *
 * DELIBERATELY free of static Databricks imports: this module must not
 * statically import `@repo/integrations/databricks-vector-search` (or
 * anything else that transitively pulls in `@repo/databricks`'s CJS/tsx
 * interop workaround), so call sites that keep the Databricks client OUT of
 * their static import graph — agent-executor.ts — can still import from here
 * statically. The search runner below reaches the client via dynamic
 * `import()` only, inside the call.
 */

import { logger } from "@repo/logs";

export interface AgentDatabricksBinding {
	integrationId: string;
	schema: string;
	indexNames: string[];
}

/**
 * Merge agent-level and project-level Databricks bindings into one binding
 * per integration: group by `integrationId`, union `indexNames` (deduped,
 * first-seen order). The union is NOT pre-truncated —
 * `queryDatabricksVectorIndexes` caps at MAX_QUERY_INDEXES itself and
 * reports the overflow in `skippedIndexes`, so callers/users still see what
 * was not searched.
 *
 * Use this at EVERY tool-exposure site before building tool names. Without
 * it, two bindings produce two identically-named `search_databricks_indexes`
 * entries and later ones silently overwrite earlier ones in a keyed record,
 * making some bound indexes unreachable with no warning.
 */
export function mergeDatabricksBindings(
	bindings: AgentDatabricksBinding[],
): AgentDatabricksBinding[] {
	const byIntegration = new Map<
		string,
		{ schemas: string[]; indexNames: string[] }
	>();
	for (const binding of bindings) {
		let entry = byIntegration.get(binding.integrationId);
		if (!entry) {
			entry = { schemas: [], indexNames: [] };
			byIntegration.set(binding.integrationId, entry);
		}
		if (binding.schema && !entry.schemas.includes(binding.schema)) {
			entry.schemas.push(binding.schema);
		}
		for (const indexName of binding.indexNames) {
			if (!entry.indexNames.includes(indexName)) {
				entry.indexNames.push(indexName);
			}
		}
	}
	return [...byIntegration.entries()]
		.filter(([, entry]) => entry.indexNames.length > 0)
		.map(([integrationId, entry]) => ({
			integrationId,
			schema: entry.schemas.join(", ") || "unknown",
			indexNames: entry.indexNames,
		}));
}

/**
 * Deterministic tool name for the Nth merged binding — the suffix rule that
 * sites 1/2 already used, extracted so site 3 (agent-executor) applies the
 * SAME rule instead of pushing a hardcoded unsuffixed name per binding.
 */
export function databricksKnowledgeToolName(index: number): string {
	return index === 0
		? "search_databricks_indexes"
		: `search_databricks_indexes_${index + 1}`;
}

export interface DatabricksBindingSearchResult {
	chunks: Array<{
		indexName: string;
		id: string;
		content: string;
		score: number;
	}>;
	failures: string[];
	skippedIndexes: string[];
	summary: string;
}

/**
 * Run one `search_databricks_indexes` tool call for a merged binding — the
 * agent-executor's tool `execute` body, extracted so it is testable.
 *
 * Null credentials are a GRACEFUL empty result, never a thrown error: a
 * project-scoped guest (accepted ProjectMember, no org Member row) correctly
 * resolves no credentials, and the required UX is a silent no-op — the same
 * message/shape `executeDatabricksKnowledgeSearch` in databricks-knowledge.ts
 * returns for this case — not a visible tool error in their chat.
 */
export async function executeDatabricksBindingSearch(
	binding: Pick<AgentDatabricksBinding, "integrationId" | "indexNames">,
	args: Record<string, unknown>,
	tenant: { userId: string; organizationId?: string },
): Promise<DatabricksBindingSearchResult> {
	const [
		{ queryDatabricksVectorIndexes, MAX_QUERY_INDEXES },
		{ fetchCredentialsByIdInTenant },
	] = await Promise.all([
		import("@repo/integrations/databricks-vector-search"),
		import("@repo/database"),
	]);
	const credentials = await fetchCredentialsByIdInTenant(
		binding.integrationId,
		tenant.userId,
		tenant.organizationId,
	);
	if (!credentials) {
		logger.warn(
			"[AgentExecutor] Databricks credentials unavailable — returning empty result",
			{ integrationId: binding.integrationId },
		);
		return {
			chunks: [],
			failures: [],
			skippedIndexes: [],
			summary:
				"Databricks integration not found or credentials unavailable",
		};
	}

	const { chunks, failures, skippedIndexes } =
		await queryDatabricksVectorIndexes(credentials, {
			indexNames: binding.indexNames,
			query: String(args.query ?? ""),
			numResults:
				typeof args.num_results === "number"
					? Math.max(1, Math.min(50, Math.floor(args.num_results)))
					: undefined,
		});
	if (failures.length > 0) {
		logger.warn(
			"[AgentExecutor] Databricks vector search partial failure",
			{
				failures,
			},
		);
	}
	if (skippedIndexes.length > 0) {
		logger.warn(
			"[AgentExecutor] Databricks vector search skipped indexes beyond the query limit",
			{ skippedIndexes, limit: MAX_QUERY_INDEXES },
		);
	}
	let summary =
		chunks.length === 0
			? "No matching content found in the Databricks knowledge base."
			: chunks
					.map(
						(c) =>
							`[${c.indexName} #${c.id}] (score ${c.score.toFixed(3)}) ${c.content}`,
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
	return { chunks, failures, skippedIndexes, summary };
}
