/**
 * Agent Memory Activities
 *
 * Temporal activities for agent memory operations.
 * Provides persistent memory capabilities for Agent Template Instances and Orchestrator.
 *
 * Memory Types (COALA Framework):
 * - Procedural: AGENTS.md, mcp.json (core instructions)
 * - Semantic: skills/*.md, knowledge/* (domain knowledge)
 * - Episodic: conversations/*.json (past conversation summaries)
 */

// Episodic Memory (Conversation Summaries)
export {
	analyzeConversation,
	type ConversationMessage,
	type EpisodeSummary,
	generateConversationTitle,
	type LoadRelevantEpisodesInput,
	type LoadRelevantEpisodesOutput,
	loadRelevantEpisodesActivity,
	type SummarizeConversationInput,
	type SummarizeConversationOutput,
	shouldSummarizeConversation,
	summarizeConversationActivity,
} from "./episodic-memory";
export {
	type ApplyMemoryEditInput,
	applyMemoryEditActivity,
	type InitializeAgentMemoryInput,
	initializeAgentMemoryActivity,
	type LoadAgentMemoryInput,
	type LoadAgentMemoryOutput,
	loadAgentMemoryActivity,
	type ProposeMemoryUpdateInput,
	proposeMemoryUpdateActivity,
} from "./memory-activities";
export {
	type AgentMemoryToolResult,
	getAgentMemoryTools,
	memoryListTool,
	memoryReadTool,
	memorySearchTool,
	memoryWriteTool,
} from "./memory-tools";
