/**
 * Framework-agnostic agent adapter interface
 *
 * This interface enables agents written in any language (TypeScript, Python, C#)
 * and any framework (LangGraph, Microsoft Agent Framework, Cloudflare, CrewAI, etc.)
 * to communicate with the UI via AG-UI protocol.
 *
 * Key design principles:
 * 1. Language-agnostic: Agents can be written in any language
 * 2. Framework-agnostic: No framework-specific code in this interface
 * 3. Protocol-based: Communication via HTTP/WebSocket using AG-UI protocol
 * 4. CopilotKit-compatible: Works seamlessly with CopilotKit runtime
 */

import type { ToolDefinition } from "@repo/agent-tools";
import type { BaseAgentState } from "@repo/agent-types";

/**
 * Predictive state configuration for AG-UI protocol
 * Maps tool calls to state updates for real-time UI streaming
 */
export interface PredictiveStateConfig {
	/** State key to update (e.g., "document") */
	state_key: string;

	/** Tool that produces the state update (e.g., "write_document_local") */
	tool: string;

	/** Tool argument/output field to use for the state (e.g., "document") */
	tool_argument: string;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
	/** Agent identifier (e.g., "document_generator") */
	name: string;

	/** Display name for UI */
	displayName: string;

	/** Agent description */
	description: string;

	/**
	 * LLM model to use (e.g., "gpt-4o").
	 *
	 * Optional because some agent paths transmit the model out-of-band
	 * rather than baking it onto the adapter: the LangGraph CopilotKit
	 * route forwards it via the `ai_model` property and `X-AI-Model`
	 * header so the registry can be built statically. Adapters that need
	 * the model inline (microsoft, pydantic-ai) fall back to "gpt-4o".
	 */
	model?: string;

	/** Temperature for generation (0.0 - 1.0) */
	temperature: number;

	/** Health check timeout in milliseconds (default: 5000ms) */
	healthCheckTimeout?: number;

	/** Maximum tokens to generate */
	maxTokens: number;

	/** Request timeout in milliseconds */
	timeout: number;

	/** Maximum recursion/retry limit */
	recursionLimit: number;

	/** Predictive state mappings for AG-UI protocol */
	predictiveStates: PredictiveStateConfig[];

	/** Agent version (for tracking) */
	version?: string;

	/** Agent tags (for categorization) */
	tags?: string[];
}

/**
 * Agent execution context
 * Contains tenant and user information for multi-tenant agents
 */
export interface AgentContext {
	/** User ID */
	userId: string;

	/** Organization ID (optional for personal agents) */
	organizationId?: string;

	/** Additional properties (prompts, MCP endpoints, etc.) */
	properties: Record<string, any>;
}

/**
 * Agent health status
 */
export interface AgentHealthStatus {
	/** Is the agent healthy? */
	healthy: boolean;

	/** Response time in milliseconds */
	responseTime?: number;

	/** Error message if unhealthy */
	error?: string;

	/** Last health check timestamp */
	lastCheck: Date;

	/** Agent version (if available) */
	version?: string;
}

/**
 * Framework-agnostic agent adapter interface
 *
 * All agent frameworks (LangGraph, Microsoft, Cloudflare, etc.) must implement this interface.
 * This enables:
 * - Unified agent registration and discovery
 * - Language-agnostic communication (TypeScript, Python, C#)
 * - Consistent AG-UI protocol compliance
 * - Easy framework swapping without UI changes
 */
export interface AgentAdapter<_TState extends BaseAgentState = BaseAgentState> {
	/**
	 * Agent identifier (must be unique in registry)
	 */
	readonly name: string;

	/**
	 * Framework identifier
	 * Examples: "langgraph", "microsoft-agent-framework", "cloudflare", "crewai"
	 */
	readonly framework: string;

	/**
	 * Implementation language
	 * Examples: "typescript", "python", "csharp"
	 */
	readonly language: string;

	/**
	 * Agent configuration
	 */
	readonly config: AgentConfig;

	/**
	 * Available tools
	 */
	readonly tools: ToolDefinition[];

	/**
	 * Get deployment URL
	 * The agent endpoint that speaks AG-UI protocol
	 */
	getDeploymentUrl(): string;

	/**
	 * Health check
	 * Verify the agent is running and responsive
	 */
	healthCheck(): Promise<AgentHealthStatus>;

	/**
	 * Get metadata for agent discovery/registry
	 */
	getMetadata(): {
		name: string;
		framework: string;
		language: string;
		version: string;
		description: string;
		tags: string[];
		deploymentUrl: string;
		tools: string[]; // Tool names
	};

	/**
	 * Get current activity status for visual indicators
	 * Optional method - adapters can implement this for real-time status updates
	 */
	getActivityStatus?(): Promise<
		import("./ag-ui-protocol").AgentActivityIndicator
	>;
}

/**
 * Agent adapter with CopilotKit integration
 * For frameworks that have native CopilotKit support (like LangGraph)
 */
export interface CopilotKitAgentAdapter<
	TState extends BaseAgentState = BaseAgentState,
> extends AgentAdapter<TState> {
	/**
	 * Get the underlying CopilotKit-compatible agent
	 * This allows the adapter to provide framework-specific agents to CopilotKit
	 */
	getCopilotKitAgent(): any;
}
