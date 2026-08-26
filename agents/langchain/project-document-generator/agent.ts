/**
 * Project Document Generator Agent with AG-UI Protocol Support
 *
 * LangGraph agent for generating project documents with RAG context and predictive state updates.
 *
 * Features:
 * - RAG context integration for informed document generation
 * - Project context awareness (tech stack, features)
 * - Real-time streaming via AG-UI protocol
 * - Error handling and recovery with retry logic
 * - Support for custom prompts from Prompt Library
 * - Server-side Teams search tool (multi-node graph)
 *
 * Architecture:
 * - state/       - LangGraph state annotations
 * - prompts/     - System prompt generation
 * - nodes/       - LangGraph node functions (chat_node, tool_node)
 * - utils/       - Helper utilities and constants
 *
 * Graph: START → chat_node → shouldContinue → {
 *   "tools": tool_node → chat_node (loop for search_teams_messages)
 *   "__end__": END (write_document_local handled inline or final response)
 * }
 *
 * @module project-document-generator
 */

import { START, StateGraph } from "@langchain/langgraph";

// State
import { type AgentState, AgentStateAnnotation } from "./state";

export type { AgentState } from "./state";

// Nodes
import { chatNode, toolNode } from "./nodes";
import { countToolRoundsSinceLastHuman, MAX_TOOL_ITERATIONS } from "./utils";

// ============================================================================
// Routing Function
// ============================================================================

/**
 * Determine whether to route to tool_node or end the graph.
 *
 * Routes to "tools" when the last message has tool_calls that are NOT
 * write_document_local (which is handled inline by chat_node).
 * Routes to "__end__" for write_document_local, confirm_changes,
 * CopilotKit frontend actions, or no tool calls.
 *
 * CopilotKit frontend actions (e.g., select_meetings, fetchMeetingNotes)
 * are handled client-side via the AG-UI protocol — routing them to tool_node
 * would cause an infinite loop since tool_node has no implementation for them.
 */
export function shouldContinue(state: AgentState): "tool_node" | "__end__" {
	const lastMessage = state.messages[state.messages.length - 1];

	if (lastMessage) {
		// Defensively access tool_calls - different providers may use different field names
		const msg = lastMessage as any;
		const toolCalls: Array<{
			name?: string;
			function?: { name?: string };
		}> = msg.tool_calls || msg.toolCalls || [];

		if (Array.isArray(toolCalls) && toolCalls.length > 0) {
			// Collect CopilotKit frontend action names — these are handled
			// by CopilotKit on the client, not by our tool_node
			const copilotKitActionNames = new Set(
				((state as any).copilotkit?.actions || []).map(
					(a: { name?: string }) => a.name,
				),
			);

			// write_document_local and confirm_changes are handled inline by chat_node.
			// CopilotKit actions are handled client-side via AG-UI protocol.
			// ask_clarifying_question is a synthesized client-side HITL action (the
			// model emits a `clarifying-question` block which chat_node turns into the
			// tool call) — like confirm_changes it must end the run so CopilotKit
			// renders the card and waits; routing it to tool_node (which has no
			// implementation for it) caused a chat_node↔tool_node loop that stacked
			// duplicate cards.
			// Only route to tool_node for server-side tools (e.g., search_teams_messages)
			const hasServerSideToolCalls = toolCalls.some((tc) => {
				const name = tc.name || tc.function?.name || "";
				return (
					name !== "write_document_local" &&
					name !== "confirm_changes" &&
					name !== "ask_clarifying_question" &&
					!copilotKitActionNames.has(name)
				);
			});
			if (hasServerSideToolCalls) {
				// Count tool-call rounds after the last human message to prevent infinite loops.
				// Each round = one AI message with tool_calls followed by tool result messages.
				const toolRounds = countToolRoundsSinceLastHuman(
					state.messages,
				);

				// Strictly greater-than: at exactly MAX_TOOL_ITERATIONS the
				// final budgeted round must still reach tool_node so its
				// results return to chat_node, which then sees the budget
				// spent and finalizes with inline-only tools (finalizeMode in
				// nodes/chat-node.ts). Ending at >= here would strand that
				// last tool call unexecuted and skip the finalize path
				// entirely. This backstop only fires if a finalize-mode model
				// emits a server-side call anyway (e.g. a hallucinated name).
				if (toolRounds > MAX_TOOL_ITERATIONS) {
					console.warn(
						`[shouldContinue] Tool iteration limit reached (${toolRounds}/${MAX_TOOL_ITERATIONS}), forcing __end__`,
					);
					return "__end__";
				}

				return "tool_node";
			}
		}
	}

	return "__end__";
}

// ============================================================================
// Graph Definition
// ============================================================================

/**
 * Create the project document generator workflow graph
 *
 * Multi-node graph with tool execution loop:
 *
 * START
 *   └─> chat_node
 *        └─> shouldContinue
 *             ├─> "tools" → tool_node → chat_node (loop)
 *             └─> "__end__" → END
 */
export const projectDocumentGeneratorGraph = new StateGraph(
	AgentStateAnnotation,
)
	.addNode("chat_node", chatNode)
	.addNode("tool_node", toolNode)
	.addEdge(START, "chat_node")
	.addConditionalEdges("chat_node", shouldContinue)
	.addEdge("tool_node", "chat_node")
	.compile();

// ============================================================================
// Graph Metadata for LangGraph CLI
// ============================================================================

/**
 * Graph metadata for LangGraph discovery and CLI tools
 */
export const graphMetadata = {
	name: "project_document_generator",
	description:
		"AI-powered project document generator with RAG context, project awareness, and predictive state updates",
	version: "1.1.0",
	capabilities: [
		"document-generation",
		"document-editing",
		"rag-context",
		"project-context",
		"predictive-updates",
		"streaming",
		"ag-ui-protocol",
		"a2a-protocol",
	],
	protocols: ["a2a", "ag-ui"],
	supportsPredictiveUpdates: true,
};

// ============================================================================
// Exports for Testing
// ============================================================================

export { AgentStateAnnotation };

// Re-export nodes for testing
export { chatNode } from "./nodes";

// Re-export prompts for customization
export { buildSystemPrompt, getPredictStateConfig } from "./prompts";
// Re-export utilities for external use
export {
	calculateRetryDelay,
	DEFAULT_RECURSION_LIMIT,
	getAgentModel,
	isJsonParseError,
	MAX_JSON_RETRIES,
	MAX_RETRIES,
	MAX_TOOL_ITERATIONS,
	sleep,
} from "./utils";
