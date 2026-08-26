/**
 * Step Handler Types
 *
 * Defines interfaces for capability-based step handlers.
 * Each handler is responsible for executing steps of a specific capability type.
 */

import type {
	AgentVariable,
	ExecuteStepInput,
	ExecuteStepOutput,
} from "../../types";

/**
 * Tool call record for tracking execution.
 */
export interface ToolCallRecord {
	id: string;
	name: string;
	args: unknown;
	result: unknown;
	status: "success" | "error";
	durationMs: number;
	/** MCP App: ui:// resource URI for the interactive HTML UI (if tool has MCP App support) */
	mcpAppResourceUri?: string;
	/** MCP App: MCP config ID for proxying iframe tool calls */
	mcpAppConfigId?: string;
}

/**
 * Handler context passed to all step handlers.
 * Contains common data needed for step execution.
 */
export interface HandlerContext {
	/** Original step input */
	input: ExecuteStepInput;
	/** Variables accumulated during execution */
	variables: Record<string, AgentVariable>;
	/** Tool calls made during execution */
	toolCalls: ToolCallRecord[];
	/** Start time for duration tracking */
	startTime: number;
}

/**
 * Result of handler execution.
 */
export interface HandlerResult {
	/** Whether the handler successfully processed the step */
	handled: boolean;
	/** Output if handled successfully */
	output?: ExecuteStepOutput;
	/** Error message if handling failed */
	error?: string;
	/** Whether to fall back to another handler */
	shouldFallback?: boolean;
	/** Reason for fallback */
	fallbackReason?: string;
}

/**
 * Interface for capability-based step handlers.
 * Each handler implements execution logic for a specific capability type.
 */
export interface StepHandler {
	/** Unique identifier for the handler */
	readonly name: string;

	/** Capability types this handler can process */
	readonly capabilities: string[];

	/**
	 * Check if this handler can process the given step.
	 * @param input Step input to check
	 * @returns true if this handler can process the step
	 */
	canHandle(input: ExecuteStepInput): boolean;

	/**
	 * Execute the step.
	 * @param context Handler context with input and accumulated state
	 * @returns Handler result with output or error
	 */
	execute(context: HandlerContext): Promise<HandlerResult>;
}

/**
 * Configuration for step handler registration.
 */
export interface HandlerConfig {
	/** Priority order (lower = higher priority) */
	priority: number;
	/** Whether this handler is enabled */
	enabled: boolean;
}

/**
 * Registry entry for a step handler.
 */
export interface HandlerRegistryEntry {
	handler: StepHandler;
	config: HandlerConfig;
}

/**
 * MCP tool information for tool loading.
 */
export interface McpToolInfo {
	configId: string;
	serverName: string;
	originalName: string;
	/** MCP App: ui:// resource URI for the interactive HTML UI (if tool has MCP App support) */
	resourceUri?: string;
}

/**
 * Information about an MCP server that requires OAuth authorization.
 */
export interface AuthRequiredConfig {
	configId: string;
	serverName: string;
	displayName?: string;
}

/**
 * Loaded MCP tools with metadata.
 */
export interface LoadedMcpTools {
	tools: Record<string, unknown>;
	toolToConfig: Record<string, McpToolInfo>;
	/**
	 * MCP configs that require OAuth authorization.
	 * When this is populated, some tools may be unavailable until the user authorizes.
	 */
	authRequiredConfigs?: AuthRequiredConfig[];
}

/**
 * Execution context built from input and previous steps.
 */
export interface ExecutionContext {
	systemPrompt: string;
	stepPrompt: string;
	maxSteps: number;
	cachedToolResults: Record<string, unknown>;
	variableContext: string;
	previousStepsContext: string;
	isBulkOperation: boolean;
	estimatedItems: number;
}

/**
 * Artifact extracted from execution results.
 */
export interface ExtractedArtifact {
	id: string;
	type:
		| "document"
		| "code"
		| "data"
		| "tool_result"
		| "file"
		| "error"
		| "chart";
	name?: string;
	content?: string;
	metadata?: Record<string, unknown>;
}
