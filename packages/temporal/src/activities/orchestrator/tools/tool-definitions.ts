/**
 * Tool Definitions for LLM Context
 *
 * These are the meta-tool definitions that get loaded into LLM context.
 * They enable token-efficient discovery of tools, agents, workflows, and integrations.
 *
 * Token savings: ~500 tokens vs 77K+ for all tool definitions.
 */

// =============================================================================
// Tool Search Tool Definition
// =============================================================================

/**
 * The tool definition for searching MCP tools.
 * This is ~500 tokens vs 77K+ for all tool definitions.
 */
export const toolSearchToolDefinition = {
	name: "search_available_tools",
	description: `Search for MCP tools and capabilities that can help with a task.
Use this BEFORE attempting to use any tool you're unsure about.
Returns matching tools with confidence scores and brief descriptions.
Only the most relevant tools will be loaded into context.

Examples:
- "create a card on kanban board" → returns Fizzy card creation tools
- "search the web for information" → returns Firecrawl search tools
- "send a Slack message" → returns Slack messaging tools`,
	parameters: {
		type: "object" as const,
		properties: {
			query: {
				type: "string" as const,
				description:
					"Natural language description of what you need to do",
			},
			category: {
				type: "string" as const,
				enum: [
					"project_management",
					"communication",
					"development",
					"documentation",
					"data",
					"automation",
					"search",
					"file",
				],
				description: "Optional category to narrow search",
			},
			limit: {
				type: "number" as const,
				default: 5,
				description: "Maximum number of tools to return (default: 5)",
			},
		},
		required: ["query"],
	},
};

// =============================================================================
// Agent Search Tool Definition
// =============================================================================

/**
 * Agent search tool definition for LLM context.
 */
export const agentSearchToolDefinition = {
	name: "search_available_agents",
	description: `Search for AI agents that can help with a task.
Use this to find specialized agents for complex tasks.
Returns matching agents with their capabilities and limitations.

Examples:
- "generate a PRD document" → returns document-generator agent
- "break down features" → returns story-breakdown agent
- "browse the web and execute code" → returns CUGA agent (but notes its limitations)`,
	parameters: {
		type: "object" as const,
		properties: {
			query: {
				type: "string" as const,
				description: "Natural language description of what you need",
			},
			limit: {
				type: "number" as const,
				default: 3,
				description: "Maximum number of agents to return (default: 3)",
			},
		},
		required: ["query"],
	},
};

// =============================================================================
// Workflow Search Tool Definition
// =============================================================================

/**
 * Workflow search tool definition for LLM context.
 */
export const workflowSearchToolDefinition = {
	name: "search_available_workflows",
	description: `Search for available workflows that can be triggered.
Use this to find pre-built workflows for automation tasks.
Returns matching workflows with their trigger type and status.

Examples:
- "generate daily report" → returns report generation workflow
- "sync data to slack" → returns slack notification workflow`,
	inputSchema: {
		type: "object" as const,
		properties: {
			query: {
				type: "string" as const,
				description:
					"Natural language description of what you want to automate",
			},
			limit: {
				type: "number" as const,
				default: 5,
				description:
					"Maximum number of workflows to return (default: 5)",
			},
		},
		required: ["query"],
	},
};

// =============================================================================
// Integration Search Tool Definition
// =============================================================================

/**
 * Integration search tool definition for LLM context.
 */
export const integrationSearchToolDefinition = {
	name: "search_available_integrations",
	description: `Search for connected service integrations that can be used for tasks.
Use this to find configured integrations like Slack, GitHub, Linear, etc.
Returns matching integrations with their capabilities.

Examples:
- "send a message to slack" → returns Slack integration
- "create a github issue" → returns GitHub integration
- "send an email" → returns Resend integration
- "search the web" → returns Perplexity integration`,
	inputSchema: {
		type: "object" as const,
		properties: {
			query: {
				type: "string" as const,
				description:
					"Natural language description of what you want to do",
			},
			provider: {
				type: "string" as const,
				enum: [
					"SLACK",
					"GITHUB",
					"LINEAR",
					"RESEND",
					"PERPLEXITY",
					"FIRECRAWL",
					"FAL",
					"CUSTOM_WEBHOOK",
				],
				description: "Optional: filter by specific provider",
			},
			limit: {
				type: "number" as const,
				default: 5,
				description:
					"Maximum number of integrations to return (default: 5)",
			},
		},
		required: ["query"],
	},
};

import { requestApprovalToolDefinition } from "./approval-tool";

/**
 * Get all orchestrator tool definitions.
 * These are the meta-tools that help discover other tools/agents/workflows/integrations.
 */
export function getOrchestratorToolDefinitions() {
	return [
		toolSearchToolDefinition,
		agentSearchToolDefinition,
		workflowSearchToolDefinition,
		integrationSearchToolDefinition,
	];
}

/**
 * Get all orchestrator tool definitions INCLUDING the request_approval tool.
 * Use this when building the full tool list for the orchestrator.
 */
export function getAllOrchestratorToolDefinitions() {
	return [...getOrchestratorToolDefinitions(), requestApprovalToolDefinition];
}
