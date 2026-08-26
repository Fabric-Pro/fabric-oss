/**
 * Agent Type Metadata Configuration
 *
 * Centralized configuration for agent types with descriptions, icons, and use cases.
 * This makes it easy to add new agent types without modifying UI components.
 */

import type { AgentFramework } from "@repo/database/prisma/generated/client";

export interface AgentTypeMetadata {
	framework: AgentFramework;
	name: string;
	displayName: string;
	description: string;
	bestFor: string[];
	icon: string;
	emoji: string;
	category: "System" | "Custom";
	features: string[];
	limitations?: string[];
	documentationUrl?: string;
}

/**
 * Agent Type Metadata Registry
 *
 * Add new agent types here to make them available in the UI.
 */
const AGENT_TYPE_METADATA: Record<string, AgentTypeMetadata> = {
	ORCHESTRATOR: {
		framework: "ORCHESTRATOR",
		name: "orchestrator",
		displayName: "Orchestrator Agent",
		description:
			"Hub-and-spoke orchestrator that intelligently routes tasks to specialized agents via A2A protocol with multi-agent coordination and result consolidation.",
		bestFor: [
			"Complex multi-step tasks requiring coordination",
			"Tasks that need multiple specialized agents",
			"Workflows with dynamic agent selection",
			"Enterprise-grade multi-agent systems",
		],
		icon: "brain",
		emoji: "🎯",
		category: "System",
		features: [
			"Dynamic agent routing via A2A protocol",
			"Multi-agent coordination",
			"Result consolidation",
			"MCP tool integration",
			"Human-in-the-loop approval",
		],
		documentationUrl: "/docs/agents/orchestrator",
	},
	LANGGRAPH: {
		framework: "LANGGRAPH",
		name: "langgraph",
		displayName: "LangGraph Agent",
		description:
			"Custom agent built with LangGraph framework. Provides full control over agent logic, state management, and tool execution with graph-based workflows.",
		bestFor: [
			"Specialized domain-specific tasks",
			"Custom workflow logic",
			"Advanced state management",
			"Graph-based reasoning",
		],
		icon: "workflow",
		emoji: "🤖",
		category: "Custom",
		features: [
			"Graph-based workflow definition",
			"Custom state management",
			"Flexible tool integration",
			"Streaming support",
			"Checkpointing and persistence",
		],
		documentationUrl: "/docs/agents/langgraph",
	},
	MICROSOFT: {
		framework: "MICROSOFT",
		name: "microsoft",
		displayName: "Microsoft Agent",
		description:
			"Agent built with Microsoft's agent framework (Semantic Kernel or AutoGen). Integrates with Azure AI services and Microsoft ecosystem.",
		bestFor: [
			"Azure AI integration",
			"Microsoft ecosystem workflows",
			"Enterprise Microsoft environments",
		],
		icon: "microsoft",
		emoji: "🔷",
		category: "Custom",
		features: [
			"Azure AI integration",
			"Semantic Kernel support",
			"AutoGen framework support",
			"Microsoft Graph integration",
		],
		documentationUrl: "/docs/agents/microsoft",
	},
	PYDANTIC_AI: {
		framework: "PYDANTIC_AI",
		name: "pydantic-ai",
		displayName: "Pydantic AI Agent",
		description:
			"Type-safe Python agent built with Pydantic AI. Provides strong typing, validation, and structured outputs.",
		bestFor: [
			"Type-safe Python workflows",
			"Structured data extraction",
			"Validation-heavy tasks",
		],
		icon: "python",
		emoji: "🐍",
		category: "Custom",
		features: [
			"Strong typing with Pydantic",
			"Automatic validation",
			"Structured outputs",
			"Python ecosystem integration",
		],
		documentationUrl: "/docs/agents/pydantic-ai",
	},
	CUSTOM: {
		framework: "CUSTOM",
		name: "custom",
		displayName: "Custom Agent",
		description:
			"Fully custom agent implementation. Bring your own framework, logic, and tools. Supports any programming language via A2A protocol.",
		bestFor: [
			"Unique requirements not covered by other frameworks",
			"Legacy system integration",
			"Polyglot agent systems",
		],
		icon: "code",
		emoji: "⚙️",
		category: "Custom",
		features: [
			"Framework-agnostic",
			"Language-agnostic via A2A",
			"Full customization",
			"Legacy integration",
		],
		documentationUrl: "/docs/agents/custom",
	},
};

/**
 * Get all system agent types
 */
export function getSystemAgentTypes(): AgentTypeMetadata[] {
	return Object.values(AGENT_TYPE_METADATA).filter(
		(meta) => meta.category === "System",
	);
}

/**
 * Get all custom agent types
 */
export function getCustomAgentTypes(): AgentTypeMetadata[] {
	return Object.values(AGENT_TYPE_METADATA).filter(
		(meta) => meta.category === "Custom",
	);
}
