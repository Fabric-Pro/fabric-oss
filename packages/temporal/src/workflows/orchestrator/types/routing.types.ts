/**
 * Routing Types
 *
 * Defines routing decisions, delegation modes, and capability matching.
 * Used by the orchestrator to determine how to execute tasks.
 */

import type { TaskType } from "./task.types";

// =============================================================================
// Required Connection
// =============================================================================

/**
 * Represents an MCP server that needs to be connected before the task can proceed.
 * This is returned when routing detects that a tool is needed but the user
 * hasn't connected/authenticated with the MCP server yet.
 */
export interface RequiredConnection {
	/** MCP Server ID from the registry */
	serverId: string;
	/** Display name for the MCP server */
	serverName: string;
	/** Description of why this connection is needed */
	reason: string;
	/** Authentication method required */
	authType: "OAUTH2" | "API_KEY" | "NONE";
	/** URL to initiate OAuth flow (if authType is OAUTH2) */
	oauthConnectUrl?: string;
	/** Whether this is a system-provided server or custom */
	isSystemProvided: boolean;
	/** Icon URL for the server */
	iconUrl?: string;
	/** Category of the server (e.g., "Developer Tools", "Data") */
	category?: string;
	/** Tools from this server that matched the query */
	matchedTools?: string[];
	/** Confidence score of why this server is needed (0-1) */
	confidence: number;
}

// =============================================================================
// Delegation Mode
// =============================================================================

/**
 * Delegation mode for agent execution.
 * - 'complete-task': Delegate the entire task to the agent (for generalist agents)
 * - 'single-step': Only delegate individual steps (default for simple agents)
 */
export type DelegationMode = "complete-task" | "single-step";

// =============================================================================
// Routing Decision
// =============================================================================

export interface RoutingDecision {
	primaryAgent: string;
	secondaryAgents: string[];
	confidence: number;
	reasoning: string;
	riskLevel: "low" | "medium" | "high" | "critical";
	riskFactors: string[];
	suggestedStrategy: TaskType;

	// =============================================================================
	// MCP Direct Execution
	// =============================================================================

	/**
	 * Whether to use MCP tools directly instead of delegating to an agent.
	 * When true, the orchestrator will execute MCP tools directly.
	 */
	useMcpDirect?: boolean;

	/**
	 * MCP tools that matched the task requirements.
	 * Used when useMcpDirect is true to guide task planning.
	 * IMPORTANT: inputSchema is critical for the planner to know what parameters to provide.
	 */
	matchedMcpTools?: Array<{
		configId: string;
		toolName: string;
		description?: string;
		confidence: number;
		reason: string;
		/** Tool input schema - required for planner to construct correct parameters */
		inputSchema?: Record<string, unknown>;
	}>;

	/**
	 * Agents that matched the task requirements via semantic search.
	 * Used to provide matched agents to the planner without loading all agents.
	 */
	matchedAgents?: Array<{
		agentId: string;
		displayName: string;
		description: string;
		skills: string[];
		limitations?: string[];
		confidence: number;
		reason: string;
	}>;

	/**
	 * Workflows that matched the task requirements.
	 * Used when a pre-defined workflow can handle the task.
	 */
	matchedWorkflows?: Array<{
		workflowId: string;
		name: string;
		description: string;
		confidence: number;
		reason: string;
	}>;

	/**
	 * Workflow integrations that matched the task requirements.
	 * These are connected services (Slack, GitHub, Linear, etc.) that can be used
	 * directly instead of MCP servers when the integration provides the capability.
	 */
	matchedIntegrations?: Array<{
		integrationId: string;
		name: string;
		provider: string;
		description: string;
		confidence: number;
		reason: string;
		capabilities: string[];
	}>;

	/**
	 * Whether the task is read-only (no create/update/delete operations).
	 * When true, only GET/LIST tools should be used and no approval is needed.
	 */
	isReadOnly?: boolean;

	/**
	 * User's explicit intent detected from the message.
	 * Used to respect explicit capability requests from user.
	 */
	userIntent?: {
		/** User explicitly requested workspace document access */
		requestedWorkspace?: boolean;
		/** User explicitly requested workflow execution */
		requestedWorkflow?: boolean;
		/** User explicitly requested MCP tool usage */
		requestedMcpTools?: boolean;
		/** User explicitly requested agent delegation */
		requestedAgent?: string;
		/** Specific tools/workflows mentioned by name */
		mentionedCapabilities?: string[];
		/** Detected YouTube URL if present */
		youtubeUrl?: string;
		/** Whether task requires Fabric AI capabilities */
		requestedFabricAi?: boolean;
		/** Explicit request for a first-class frame/slideshow output */
		requestedFrameOutput?: "frame" | "slideshow";
	};

	/**
	 * Fabric AI capability for content processing (YouTube, audio, web scraping).
	 * When present, the orchestrator should use Fabric AI activities directly.
	 */
	fabricAiCapability?: {
		/** Type of Fabric AI capability: youtube_transcript, scrape_url, audio_transcribe */
		type:
			| "youtube_transcript"
			| "scrape_url"
			| "audio_transcribe"
			| "pattern";
		/** URL to process (YouTube, web page, audio file) */
		url: string;
		/** Fabric pattern to apply (e.g., "summarize", "extract_wisdom") */
		pattern?: string;
	};

	/**
	 * User's prioritized capabilities.
	 * When present, the planner should strongly prefer using these tools/servers/agents.
	 */
	prioritizedCapabilities?: {
		/** Names of prioritized MCP servers */
		mcpServers?: string[];
		/** Names of prioritized tools */
		tools?: string[];
		/** Names of prioritized agents */
		agents?: string[];
	};

	// =============================================================================
	// Generalist Agent Delegation
	// =============================================================================

	/**
	 * Whether the primary agent is a generalist with autonomous execution capabilities.
	 * When true, the orchestrator should delegate the entire task rather than
	 * decomposing it into steps.
	 */
	isGeneralistAgent?: boolean;

	/**
	 * How to delegate to this agent.
	 * - 'complete-task': Pass the full task, let the agent handle decomposition
	 * - 'single-step': Orchestrator decomposes, agent executes individual steps
	 */
	delegationMode?: DelegationMode;

	/**
	 * Agent capabilities detected from agent card.
	 */
	agentCapabilities?: {
		autonomousExecution?: boolean;
		taskDecomposition?: boolean;
		contextPreservation?: boolean;
		codeExecution?: boolean;
		browserAutomation?: boolean;
		memoryEnabled?: boolean;
		multiTenancyAware?: boolean;
		maxAutonomyLevel?: "step" | "subtask" | "task" | "session";
		/** Whether agent can use MCP tools directly */
		hasMcpAccess?: boolean;
		/** List of MCP tools the agent can access (if hasMcpAccess is true) */
		mcpToolAccess?: string[];
	};

	// =============================================================================
	// Required Connections (Dynamic MCP Connection Discovery)
	// =============================================================================

	/**
	 * MCP servers that need to be connected before the task can proceed.
	 * Returned when routing detects that a tool is needed but the user hasn't
	 * connected/authenticated with the MCP server yet.
	 *
	 * The frontend should display these as connection prompts and guide the user
	 * through OAuth or API key authentication before retrying the task.
	 */
	requiredConnections?: RequiredConnection[];

	/**
	 * Workflow integrations that need to be configured before the task can proceed.
	 * These are system integrations (GitHub, Slack, etc.) that were matched
	 * but don't have credentials configured.
	 */
	missingIntegrations?: MissingIntegration[];

	/**
	 * Whether the task is blocked waiting for required connections.
	 * When true, the workflow should not proceed with planning/execution
	 * and instead return the requiredConnections to the frontend.
	 */
	blockedOnConnections?: boolean;

	/**
	 * Structured selector telemetry for observability and replay benchmarking.
	 * Persisted with routingDecision so historical executions can be analyzed.
	 */
	selectorTelemetry?: {
		toolSearch: {
			strategy?: string;
			durationMs: number;
			totalToolsSearched: number;
			semanticSearchUsed: boolean;
			explicitServerUsed?: boolean;
			keywordShortcutUsed?: boolean;
			matchedServers?: string[];
			topResults: Array<{
				toolName: string;
				serverName: string;
				confidence: number;
			}>;
		};
		agentSearch: {
			durationMs: number;
			totalAgentsSearched: number;
			topResults: Array<{
				agentId: string;
				confidence: number;
			}>;
		};
		integrationSearch: {
			searched: boolean;
			reason: string;
			durationMs: number;
			totalIntegrationsSearched?: number;
			topResults: Array<{
				name: string;
				provider: string;
				confidence: number;
			}>;
		};
		finalSelection: {
			primaryAgent: string;
			useMcpDirect: boolean;
			highConfidenceToolCount: number;
			matchedToolCount: number;
			matchedIntegrationCount: number;
		};
	};
}

// =============================================================================
// Missing Integration
// =============================================================================

/**
 * Represents a workflow integration that needs to be configured.
 * This is returned when routing detects that an integration was matched
 * but the user hasn't configured credentials for it yet.
 */
export interface MissingIntegration {
	/** Provider type (GITHUB, SLACK, etc.) */
	provider: string;
	/** Display name */
	name: string;
	/** Why this integration is needed */
	reason: string;
	/** Authentication type for this integration */
	authType: "OAUTH" | "API_KEY";
	/** Capabilities this integration provides */
	capabilities: string[];
	/** Confidence score */
	confidence: number;
}
