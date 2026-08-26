/**
 * Agent Request Types
 *
 * Standardized request/response types for multi-tenant agent communication.
 * All agents should use these types for consistent tenant context handling.
 */

import type { TenantContext, TenantModelConfig } from "./tenant-context";

/**
 * Base agent request with tenant context
 * All agent requests should extend this type
 */
export interface BaseAgentRequest<TInput = unknown> {
	/** The actual agent-specific input */
	input: TInput;

	/** Tenant context (resolved from API key or session) */
	tenantContext: TenantContext;

	/** Optional pre-resolved model config (if caller has already resolved) */
	modelConfig?: TenantModelConfig;

	/** Request ID for tracing */
	requestId?: string;

	/** Conversation ID for multi-turn interactions */
	conversationId?: string;
}

/**
 * Base agent response with tenant metadata
 */
export interface BaseAgentResponse<TOutput = unknown> {
	/** Agent execution result */
	result: TOutput;

	/** Request ID echoed back */
	requestId: string;

	/** Execution metadata */
	metadata: {
		/** Time taken in milliseconds */
		durationMs: number;

		/** Model used for execution */
		modelUsed: string;

		/** Provider used */
		providerUsed: string;

		/** Token usage (if available) */
		tokenUsage?: {
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
		};
	};
}

/**
 * A2A (Agent-to-Agent) protocol request with tenant context
 */
export interface A2ARequest<TInput = unknown> extends BaseAgentRequest<TInput> {
	/** A2A protocol version */
	protocolVersion: "1.0";

	/** Source agent (if called from another agent) */
	sourceAgent?: string;

	/** Capability being invoked */
	capability: string;

	/** Task configuration */
	task?: {
		id: string;
		name?: string;
		timeout?: number;
	};
}

/**
 * AG-UI protocol event with tenant context
 */
export interface AGUIEvent {
	/** Event type */
	type:
		| "TEXT_MESSAGE_START"
		| "TEXT_MESSAGE_CONTENT"
		| "TEXT_MESSAGE_END"
		| "TOOL_CALL_START"
		| "TOOL_CALL_ARGS"
		| "TOOL_CALL_END"
		| "STATE_SNAPSHOT"
		| "STATE_DELTA"
		| "MESSAGES_SNAPSHOT"
		| "RUN_STARTED"
		| "RUN_FINISHED"
		| "RUN_ERROR"
		| "CUSTOM";

	/** Event payload */
	payload: unknown;

	/** Message ID (for message events) */
	messageId?: string;

	/** Request ID for correlation */
	requestId?: string;
}

/**
 * Streaming response wrapper
 */
export interface StreamingAgentResponse {
	/** Request ID for correlation */
	requestId: string;

	/** Stream of AG-UI events */
	events: AsyncIterable<AGUIEvent>;
}

/**
 * Error response from agents
 */
export interface AgentErrorResponse {
	/** Error type */
	error:
		| "UNAUTHORIZED"
		| "FORBIDDEN"
		| "NOT_FOUND"
		| "BAD_REQUEST"
		| "INTERNAL_ERROR"
		| "MODEL_ERROR"
		| "RATE_LIMITED";

	/** Human-readable error message */
	message: string;

	/** Error details (for debugging) */
	details?: Record<string, unknown>;

	/** Request ID for correlation */
	requestId?: string;
}
