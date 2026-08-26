/**
 * AG-UI Protocol Type Definitions
 *
 * Type-safe definitions for the AG-UI protocol used for agent-to-UI communication.
 * This protocol enables real-time streaming, predictive state updates, tool calls,
 * and human-in-the-loop approvals.
 *
 * @see https://docs.copilotkit.ai/coagents/ag-ui-protocol
 */

/**
 * AG-UI Protocol Event Types
 */
export type AGUIEventType =
	| "STATE_DELTA"
	| "TOOL_CALL"
	| "TOOL_RESULT"
	| "HUMAN_IN_LOOP_REQUEST"
	| "HUMAN_IN_LOOP_RESPONSE"
	| "STREAM_CHUNK"
	| "STREAM_END"
	| "ERROR";

/**
 * Base AG-UI Event Interface
 *
 * All AG-UI protocol events extend this base interface.
 */
export interface AGUIEvent<T = any> {
	/** Event type identifier */
	type: AGUIEventType;

	/** Event payload (type-specific data) */
	payload: T;

	/** Event timestamp */
	timestamp: Date;

	/** Whether this is a predictive update (not yet confirmed) */
	predictive?: boolean;

	/** Whether this update is confirmed (final) */
	confirmed?: boolean;

	/** Optional event metadata */
	metadata?: Record<string, any>;
}

/**
 * State Delta Event
 *
 * Emitted when agent updates application state.
 * Used for predictive state updates during streaming.
 */
export interface StateDeltaEvent extends AGUIEvent {
	type: "STATE_DELTA";
	payload: {
		/** State key to update (e.g., "document", "analysis") */
		state_key: string;

		/** New value for the state */
		value: any;

		/** Whether this is a predictive update */
		predictive: boolean;

		/** Optional merge strategy for complex state */
		merge_strategy?: "replace" | "merge" | "append";
	};
}

/**
 * Tool Call Event
 *
 * Emitted when agent invokes a tool.
 */
export interface ToolCallEvent extends AGUIEvent {
	type: "TOOL_CALL";
	payload: {
		/** Unique tool call identifier */
		tool_call_id: string;

		/** Tool name being invoked */
		tool_name: string;

		/** Tool arguments */
		arguments: Record<string, any>;

		/** Optional tool call metadata */
		metadata?: {
			/** Estimated execution time in milliseconds */
			estimated_duration?: number;

			/** Tool category (e.g., "search", "analysis", "generation") */
			category?: string;
		};
	};
}

/**
 * Tool Result Event
 *
 * Emitted when tool execution completes.
 */
export interface ToolResultEvent extends AGUIEvent {
	type: "TOOL_RESULT";
	payload: {
		/** Tool call identifier (matches ToolCallEvent.tool_call_id) */
		tool_call_id: string;

		/** Tool execution result */
		result: any;

		/** Whether tool execution succeeded */
		success: boolean;

		/** Error message if execution failed */
		error?: string;

		/** Actual execution time in milliseconds */
		execution_time?: number;
	};
}

/**
 * Human-in-the-Loop Request Event
 *
 * Emitted when agent requires human approval or input.
 */
export interface HumanInLoopRequestEvent extends AGUIEvent {
	type: "HUMAN_IN_LOOP_REQUEST";
	payload: {
		/** Unique request identifier */
		request_id: string;

		/** Request type */
		request_type: "approval" | "input" | "choice";

		/** Human-readable prompt */
		prompt: string;

		/** Optional context for the request */
		context?: Record<string, any>;

		/** For "choice" type: available options */
		options?: Array<{
			value: string;
			label: string;
			description?: string;
		}>;

		/** Timeout in milliseconds (optional) */
		timeout?: number;
	};
}

/**
 * Human-in-the-Loop Response Event
 *
 * Emitted when human responds to a request.
 */
export interface HumanInLoopResponseEvent extends AGUIEvent {
	type: "HUMAN_IN_LOOP_RESPONSE";
	payload: {
		/** Request identifier (matches HumanInLoopRequestEvent.request_id) */
		request_id: string;

		/** Whether request was approved/accepted */
		approved: boolean;

		/** User's response value (for "input" or "choice" types) */
		value?: any;

		/** Optional feedback from user */
		feedback?: string;

		/** Response timestamp */
		responded_at: Date;
	};
}

/**
 * Stream Chunk Event
 *
 * Emitted during streaming responses from LLM.
 */
export interface StreamChunkEvent extends AGUIEvent {
	type: "STREAM_CHUNK";
	payload: {
		/** Chunk content */
		content: string;

		/** Whether this is the first chunk */
		is_first?: boolean;

		/** Cumulative token count */
		token_count?: number;
	};
}

/**
 * Stream End Event
 *
 * Emitted when streaming completes.
 */
export interface StreamEndEvent extends AGUIEvent {
	type: "STREAM_END";
	payload: {
		/** Final complete content */
		final_content: string;

		/** Total tokens used */
		total_tokens?: number;

		/** Finish reason */
		finish_reason?: "stop" | "length" | "tool_calls" | "error";
	};
}

/**
 * Error Event
 *
 * Emitted when an error occurs during agent execution.
 */
export interface ErrorEvent extends AGUIEvent {
	type: "ERROR";
	payload: {
		/** Error code */
		code: string;

		/** Error message */
		message: string;

		/** Error details */
		details?: Record<string, any>;

		/** Whether error is recoverable */
		recoverable?: boolean;

		/** Stack trace (for debugging) */
		stack?: string;
	};
}

/**
 * Agent Activity Status
 *
 * Represents the current activity state of an agent.
 * Used for visual indicators in the UI.
 */
export type AgentActivityStatus =
	| "idle"
	| "thinking"
	| "executing"
	| "waiting_approval"
	| "streaming"
	| "error";

/**
 * Agent Activity Indicator
 *
 * Provides real-time status information for visual indicators.
 */
export interface AgentActivityIndicator {
	/** Agent identifier */
	agentName: string;

	/** Current activity status */
	status: AgentActivityStatus;

	/** Currently executing tool (if status is "executing") */
	currentTool?: string;

	/** Progress percentage (0-100, if available) */
	progress?: number;

	/** Current stage description */
	stage?: string;

	/** Last update timestamp */
	lastUpdate: Date;

	/** Additional metadata */
	metadata?: {
		/** Estimated time remaining in milliseconds */
		estimatedTimeRemaining?: number;

		/** Number of completed steps */
		completedSteps?: number;

		/** Total number of steps */
		totalSteps?: number;
	};
}

/**
 * Type guard for AG-UI events
 */
export function isAGUIEvent(obj: any): obj is AGUIEvent {
	return (
		obj &&
		typeof obj === "object" &&
		"type" in obj &&
		"payload" in obj &&
		"timestamp" in obj
	);
}

/**
 * Type guard for State Delta events
 */
export function isStateDeltaEvent(event: AGUIEvent): event is StateDeltaEvent {
	return event.type === "STATE_DELTA";
}

/**
 * Type guard for Tool Call events
 */
export function isToolCallEvent(event: AGUIEvent): event is ToolCallEvent {
	return event.type === "TOOL_CALL";
}

/**
 * Type guard for Tool Result events
 */
export function isToolResultEvent(event: AGUIEvent): event is ToolResultEvent {
	return event.type === "TOOL_RESULT";
}

/**
 * Type guard for Human-in-the-Loop Request events
 */
export function isHumanInLoopRequestEvent(
	event: AGUIEvent,
): event is HumanInLoopRequestEvent {
	return event.type === "HUMAN_IN_LOOP_REQUEST";
}

/**
 * Type guard for Human-in-the-Loop Response events
 */
export function isHumanInLoopResponseEvent(
	event: AGUIEvent,
): event is HumanInLoopResponseEvent {
	return event.type === "HUMAN_IN_LOOP_RESPONSE";
}

/**
 * Type guard for Stream Chunk events
 */
export function isStreamChunkEvent(
	event: AGUIEvent,
): event is StreamChunkEvent {
	return event.type === "STREAM_CHUNK";
}

/**
 * Type guard for Stream End events
 */
export function isStreamEndEvent(event: AGUIEvent): event is StreamEndEvent {
	return event.type === "STREAM_END";
}

/**
 * Type guard for Error events
 */
export function isErrorEvent(event: AGUIEvent): event is ErrorEvent {
	return event.type === "ERROR";
}
