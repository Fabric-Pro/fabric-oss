import type { SourceReference } from "./orchestrator";

/** Convert current and stored summary labels into panel sources. */
export function buildArtifactSources(
	currentSources: readonly string[],
	completedExecutions: readonly { sourcesUsed?: string[] }[],
): SourceReference[] {
	const sourceTypeMap: Record<string, SourceReference["type"]> = {
		workspace_rag: "workspace",
		workspace_documents: "workspace",
		project_context: "workspace",
		agent_template: "document",
		fabric_pattern: "document",
		fabric_patterns: "document",
		orchestrator_memory: "memory",
		past_executions: "memory",
		keyword_memory: "memory",
		failure_avoidance: "memory",
		semantic_memory: "memory",
		letta_memory: "memory",
		trajectory_reuse: "memory",
		similar_trajectory: "memory",
		negative_memory: "memory",
		web_research: "web",
		mcp_tool_discovery: "code",
		available_tools: "code",
		agent_capabilities: "code",
		policy_enrichment: "document",
		system_policies: "document",
		user_input: "document",
	};
	const completedSources = completedExecutions.flatMap(
		(execution) => execution.sourcesUsed || [],
	);
	const allSources = [...new Set([...currentSources, ...completedSources])];
	return allSources.map((source, index) => ({
		id: `source-${index}`,
		title: source,
		type:
			sourceTypeMap[source.toLowerCase().replace(/ /g, "_")] ||
			"document",
	}));
}
