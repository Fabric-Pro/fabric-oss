/**
 * Agent Metadata Types
 *
 * Type definitions for agent metadata endpoint responses.
 * All AG-UI-native agents should expose a `/metadata` endpoint
 * that returns metadata in this format.
 */

import type { ToolDefinition } from "@repo/agent-tools";

/**
 * AG-UI Protocol Version
 */
export type AGUIProtocolVersion = "1.0" | "1.1" | "2.0";

/**
 * Agent Capabilities
 *
 * Standard capabilities that agents can support
 */
export type AgentCapability =
	| "predictive-state-updates"
	| "human-in-the-loop"
	| "tool-calling"
	| "generative-ui"
	| "streaming"
	| "multi-turn-conversation"
	| "context-awareness"
	| "error-recovery";

/**
 * Agent Endpoint Configuration
 *
 * Standard endpoints that agents should expose
 */
export interface AgentEndpoints {
	/** Invoke endpoint for single-turn execution */
	invoke: string;

	/** Stream endpoint for streaming responses */
	stream: string;

	/** Health check endpoint */
	health: string;

	/** Metadata endpoint */
	metadata?: string;

	/** Optional: Thread management endpoint */
	threads?: string;

	/** Optional: State checkpoint endpoint */
	checkpoints?: string;
}

/**
 * Agent Metadata Response
 *
 * Standard metadata format that all AG-UI-native agents should return
 * from their `/metadata` endpoint.
 *
 * @example
 * ```json
 * {
 *   "name": "my_agent",
 *   "displayName": "My Agent",
 *   "description": "Custom agent with AG-UI support",
 *   "framework": "pydantic-ai",
 *   "language": "python",
 *   "version": "1.0.0",
 *   "supportsAGUIProtocol": true,
 *   "agUIProtocolVersion": "1.0",
 *   "tools": [...],
 *   "capabilities": ["predictive-state-updates", "tool-calling"],
 *   "endpoints": {
 *     "invoke": "/invoke",
 *     "stream": "/stream",
 *     "health": "/health"
 *   }
 * }
 * ```
 */
export interface AgentMetadataResponse {
	/** Agent name (unique identifier) */
	name: string;

	/** Display name for UI */
	displayName: string;

	/** Agent description */
	description: string;

	/** Framework identifier (e.g., "pydantic-ai", "microsoft-agent-framework", "langgraph") */
	framework: string;

	/** Programming language (e.g., "python", "typescript", "csharp") */
	language: string;

	/** Agent version */
	version: string;

	/** Whether the agent supports AG-UI protocol */
	supportsAGUIProtocol: boolean;

	/** AG-UI protocol version */
	agUIProtocolVersion: AGUIProtocolVersion;

	/** Tools available to this agent */
	tools: ToolDefinition[];

	/** Agent capabilities */
	capabilities: AgentCapability[];

	/** Agent endpoints */
	endpoints: AgentEndpoints;

	/** Optional: Additional metadata */
	metadata?: Record<string, unknown>;

	/** Optional: Tags for categorization */
	tags?: string[];

	/** Optional: Author information */
	author?: {
		name: string;
		email?: string;
		url?: string;
	};

	/** Optional: License information */
	license?: string;

	/** Optional: Repository URL */
	repository?: string;

	/** Optional: Documentation URL */
	documentation?: string;
}

/**
 * Agent Discovery Result
 *
 * Result of discovering an agent from a deployment URL
 */
export interface AgentDiscoveryResult {
	/** Agent metadata */
	metadata: AgentMetadataResponse;

	/** Deployment URL */
	deploymentUrl: string;

	/** Whether the agent is healthy */
	healthy: boolean;

	/** Response time in milliseconds */
	responseTime: number;

	/** Discovery timestamp */
	discoveredAt: Date;
}
