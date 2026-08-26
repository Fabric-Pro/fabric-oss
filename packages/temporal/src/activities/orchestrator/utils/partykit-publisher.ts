/**
 * PartyKit Publisher
 *
 * Utility to publish real-time orchestrator events to PartyKit.
 * Used by MCP tool handler to stream tool execution updates.
 */

import { publishExecutionEvent } from "../../../lib/redis-publisher";

export interface OrchestratorEvent {
	type:
		| "tool_start"
		| "tool_input"
		| "tool_complete"
		| "step_progress"
		| "step_complete"
		| "phase_change"
		| "heartbeat"
		| "error"
		| "completed";
	executionId: string;
	timestamp?: number;
	data: Record<string, unknown>;
}

export interface ToolCallEvent {
	id: string;
	name: string;
	serverName?: string;
	args?: unknown;
	result?: unknown;
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	error?: string;
	mcpAppResourceUri?: string;
	mcpAppConfigId?: string;
}

export interface StepProgressEvent {
	stepId: string;
	stepDescription: string;
	phase: "starting" | "loading_tools" | "executing" | "processing_results";
	toolCalls: ToolCallEvent[];
	partialResponse?: string;
	stepIndex?: number;
	totalSteps?: number;
	message?: string;
}

/**
 * Get the PartyKit host URL
 */
function getPartykitUrl(executionId: string): string {
	const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";
	// PartyKit uses /parties/<party-name>/<room-id> for HTTP requests
	const protocol = host.startsWith("localhost") ? "http" : "https";
	return `${protocol}://${host}/parties/orchestrator/${executionId}`;
}

/**
 * Publish an event to PartyKit for the given execution
 * Non-blocking - errors are logged but don't throw
 */
export async function publishOrchestratorEvent(
	event: OrchestratorEvent,
): Promise<void> {
	let eventType = "unknown";
	try {
		eventType = event.type;
		const url = getPartykitUrl(event.executionId);
		const secret = process.env.AGENT_SERVICE_SECRET || "";

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(secret ? { Authorization: `Bearer ${secret}` } : {}),
			},
			body: JSON.stringify({
				...event,
				timestamp: event.timestamp || Date.now(),
			}),
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			console.warn(
				`[PartyKit] Failed to publish ${eventType}: ${response.status}`,
			);
		}
	} catch (error) {
		// Non-blocking - just log the error
		console.warn(
			`[PartyKit] Publish error for ${eventType}:`,
			error instanceof Error ? error.message : "Unknown error",
		);
	}
}

/**
 * Publish tool start event
 */
export async function publishToolStart(
	executionId: string,
	stepId: string,
	tool: {
		id: string;
		name: string;
		serverName?: string;
		args?: unknown;
		mcpAppResourceUri?: string;
		mcpAppConfigId?: string;
	},
): Promise<void> {
	await publishExecutionEvent(executionId, {
		event: "execution.tool_start",
		data: {
			stepId,
			toolCall: {
				id: tool.id,
				name: tool.name,
				serverName: tool.serverName,
				args: tool.args,
				status: "running",
				mcpAppResourceUri: tool.mcpAppResourceUri,
				mcpAppConfigId: tool.mcpAppConfigId,
			},
		},
	}).catch(() => {});

	await publishOrchestratorEvent({
		type: "tool_start",
		executionId,
		data: {
			stepId,
			toolCall: {
				id: tool.id,
				name: tool.name,
				serverName: tool.serverName,
				args: tool.args,
				status: "running",
				mcpAppResourceUri: tool.mcpAppResourceUri,
				mcpAppConfigId: tool.mcpAppConfigId,
			},
		},
	});
}

export async function publishToolInput(
	executionId: string,
	stepId: string,
	tool: {
		id: string;
		name: string;
		serverName?: string;
		args?: unknown;
		mcpAppResourceUri?: string;
		mcpAppConfigId?: string;
	},
): Promise<void> {
	await publishExecutionEvent(executionId, {
		event: "execution.tool_input",
		data: {
			stepId,
			toolCall: {
				id: tool.id,
				name: tool.name,
				serverName: tool.serverName,
				args: tool.args,
				status: "pending",
				mcpAppResourceUri: tool.mcpAppResourceUri,
				mcpAppConfigId: tool.mcpAppConfigId,
			},
		},
	}).catch(() => {});

	await publishOrchestratorEvent({
		type: "tool_input",
		executionId,
		data: {
			stepId,
			toolCall: {
				id: tool.id,
				name: tool.name,
				serverName: tool.serverName,
				args: tool.args,
				status: "pending",
				mcpAppResourceUri: tool.mcpAppResourceUri,
				mcpAppConfigId: tool.mcpAppConfigId,
			},
		},
	});
}

/**
 * Publish tool complete event
 */
export async function publishToolComplete(
	executionId: string,
	stepId: string,
	tool: {
		id: string;
		name: string;
		serverName?: string;
		result?: unknown;
		status: "complete" | "error";
		durationMs?: number;
		error?: string;
		mcpAppResourceUri?: string;
		mcpAppConfigId?: string;
	},
): Promise<void> {
	await publishExecutionEvent(executionId, {
		event: "execution.tool_complete",
		data: {
			stepId,
			toolCall: {
				id: tool.id,
				name: tool.name,
				serverName: tool.serverName,
				result: tool.result,
				status: tool.status,
				durationMs: tool.durationMs,
				error: tool.error,
				mcpAppResourceUri: tool.mcpAppResourceUri,
				mcpAppConfigId: tool.mcpAppConfigId,
			},
		},
	}).catch(() => {});

	await publishOrchestratorEvent({
		type: "tool_complete",
		executionId,
		data: {
			stepId,
			toolCall: {
				id: tool.id,
				name: tool.name,
				serverName: tool.serverName,
				result: tool.result,
				status: tool.status,
				durationMs: tool.durationMs,
				error: tool.error,
				mcpAppResourceUri: tool.mcpAppResourceUri,
				mcpAppConfigId: tool.mcpAppConfigId,
			},
		},
	});
}

/**
 * Publish step progress with all tool calls
 */
export async function publishStepProgress(
	executionId: string,
	progress: StepProgressEvent,
): Promise<void> {
	await publishOrchestratorEvent({
		type: "step_progress",
		executionId,
		data: {
			stepId: progress.stepId,
			stepDescription: progress.stepDescription,
			phase: progress.phase,
			toolCalls: progress.toolCalls,
			partialResponse: progress.partialResponse,
			stepIndex: progress.stepIndex,
			totalSteps: progress.totalSteps,
			message: progress.message,
		},
	});
}

/**
 * Publish phase change event
 */
export async function publishPhaseChange(
	executionId: string,
	phase: string,
	message?: string,
): Promise<void> {
	await publishOrchestratorEvent({
		type: "phase_change",
		executionId,
		data: { phase, message },
	});
}

/**
 * Publish step start event - fired immediately when a step begins
 */
export async function publishStepStart(
	executionId: string,
	stepId: string,
	stepDescription: string,
	stepIndex: number,
	totalSteps: number,
): Promise<void> {
	await publishOrchestratorEvent({
		type: "step_progress",
		executionId,
		data: {
			stepId,
			stepDescription,
			phase: "starting",
			stepIndex,
			totalSteps,
			toolCalls: [],
			message: `Starting step ${stepIndex} of ${totalSteps}: ${stepDescription}`,
		},
	});
}
