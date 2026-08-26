/**
 * Task Agent PartyKit Publisher
 *
 * Publishes real-time task agent events to PartyKit.
 * Used by the task agent workflow to stream execution updates.
 */

export interface TaskAgentEvent {
	type:
		| "agent_started"
		| "step_added"
		| "step_updated"
		| "tool_start"
		| "tool_complete"
		| "checkpoint"
		| "checkpoint_resolved"
		| "agent_thinking"
		| "agent_response"
		| "agent_completed"
		| "agent_failed"
		| "agent_cancelled";
	planId: string;
	timestamp?: number;
	data: Record<string, unknown>;
}

export interface AgentStep {
	id: string;
	name: string;
	type: "agent" | "tool" | "approval";
	status:
		| "pending"
		| "running"
		| "completed"
		| "failed"
		| "awaiting_approval";
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	error?: string;
	toolName?: string;
	toolArgs?: unknown;
	result?: unknown;
	thinking?: string;
}

/**
 * Get the PartyKit host URL for task agent room
 */
function getPartykitUrl(planId: string): string {
	const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";
	const protocol = host.startsWith("localhost") ? "http" : "https";
	return `${protocol}://${host}/parties/taskagent/${planId}`;
}

/**
 * Publish an event to PartyKit for the given plan
 * Non-blocking - errors are logged but don't throw
 */
export async function publishTaskAgentEvent(
	event: TaskAgentEvent,
): Promise<void> {
	let eventType = "unknown";
	try {
		eventType = event.type;
		const url = getPartykitUrl(event.planId);
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
				`[TaskAgentPartyKit] Failed to publish ${eventType}: ${response.status}`,
			);
		}
	} catch (error) {
		// Non-blocking - just log the error
		console.warn(
			`[TaskAgentPartyKit] Publish error for ${eventType}:`,
			error instanceof Error ? error.message : "Unknown error",
		);
	}
}

/**
 * Publish agent started event
 */
export async function publishAgentStarted(
	planId: string,
	taskId: string,
	taskTitle: string,
): Promise<void> {
	await publishTaskAgentEvent({
		type: "agent_started",
		planId,
		data: { taskId, taskTitle },
	});
}

/**
 * Publish step added event
 */
export async function publishStepAdded(
	planId: string,
	step: AgentStep,
): Promise<void> {
	await publishTaskAgentEvent({
		type: "step_added",
		planId,
		data: { step },
	});
}

/**
 * Publish step updated event
 */
export async function publishStepUpdated(
	planId: string,
	stepId: string,
	updates: Partial<AgentStep>,
): Promise<void> {
	await publishTaskAgentEvent({
		type: "step_updated",
		planId,
		data: { stepId, updates },
	});
}

/**
 * Publish tool start event
 */
export async function publishToolStart(
	planId: string,
	stepId: string,
	tool: { id: string; name: string; args?: unknown },
): Promise<void> {
	await publishTaskAgentEvent({
		type: "tool_start",
		planId,
		data: { stepId, tool },
	});
}

/**
 * Publish tool complete event
 */
export async function publishToolComplete(
	planId: string,
	stepId: string,
	tool: {
		id: string;
		name: string;
		result?: unknown;
		status: "completed" | "failed";
		durationMs?: number;
		error?: string;
	},
): Promise<void> {
	await publishTaskAgentEvent({
		type: "tool_complete",
		planId,
		data: { stepId, tool },
	});
}

/**
 * Publish checkpoint event (waiting for approval)
 */
export async function publishCheckpoint(
	planId: string,
	checkpoint: {
		stepId: string;
		tool: string;
		action: string;
		data: Record<string, unknown>;
	},
): Promise<void> {
	await publishTaskAgentEvent({
		type: "checkpoint",
		planId,
		data: { checkpoint },
	});
}

/**
 * Publish checkpoint resolved event
 */
export async function publishCheckpointResolved(
	planId: string,
	stepId: string,
	action: "approve" | "request_changes" | "cancel",
	feedback?: string,
): Promise<void> {
	await publishTaskAgentEvent({
		type: "checkpoint_resolved",
		planId,
		data: { stepId, action, feedback },
	});
}

/**
 * Publish agent thinking event (streaming partial response)
 */
export async function publishAgentThinking(
	planId: string,
	turnIndex: number,
	partialText: string,
): Promise<void> {
	await publishTaskAgentEvent({
		type: "agent_thinking",
		planId,
		data: { turnIndex, partialText },
	});
}

/**
 * Publish agent response event (turn complete)
 */
export async function publishAgentResponse(
	planId: string,
	turnIndex: number,
	response: string,
	summary: string,
	hasToolCalls: boolean,
): Promise<void> {
	await publishTaskAgentEvent({
		type: "agent_response",
		planId,
		data: { turnIndex, response, summary, hasToolCalls },
	});
}

/**
 * Publish agent completed event
 */
export async function publishAgentCompleted(
	planId: string,
	result: {
		success: boolean;
		summary?: string;
		artifacts?: Array<{ type: string; content: unknown }>;
	},
): Promise<void> {
	await publishTaskAgentEvent({
		type: "agent_completed",
		planId,
		data: { result },
	});
}

/**
 * Publish agent failed event
 */
export async function publishAgentFailed(
	planId: string,
	error: string,
	turnIndex?: number,
): Promise<void> {
	await publishTaskAgentEvent({
		type: "agent_failed",
		planId,
		data: { error, turnIndex },
	});
}

/**
 * Publish agent cancelled event
 */
export async function publishAgentCancelled(
	planId: string,
	reason?: string,
): Promise<void> {
	await publishTaskAgentEvent({
		type: "agent_cancelled",
		planId,
		data: { reason },
	});
}
