/**
 * Agentic Loop Activities
 *
 * Activities and tools for advanced agentic patterns:
 * - Context pruning for long conversations
 * - Sub-agent delegation (run_agent)
 */

// Context Pruning
export {
	type ConversationContext,
	getContextTokenCount,
	type Message,
	needsPruning,
	type PruneContextInput,
	type PruneContextOutput,
	pruneConversationContext,
} from "./context-pruning";
// Run Agent (Sub-agent delegation)
export {
	createRunAgentTool,
	getAvailableAgents,
	type RunAgentInput,
	type RunAgentMode,
	type RunAgentOutput,
	runAgent,
} from "./run-agent";

// =============================================================================
// Direct Activity Functions (for workflow use)
// =============================================================================

/**
 * Search data sources activity - used by dynamic agent workflow
 */
export async function searchDataSources(_input: {
	query: string;
	workspaceIds: string[];
	limit?: number;
	userId: string;
	organizationId?: string;
}): Promise<{
	results: Array<{
		content: string;
		source?: string;
		score?: number;
	}>;
}> {
	// TODO: Implement semantic search across workspaces
	// This will use Qdrant to search for relevant documents
	return { results: [] };
}
