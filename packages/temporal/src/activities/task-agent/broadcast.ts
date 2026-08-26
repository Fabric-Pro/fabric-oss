/**
 * Progress Broadcasting
 *
 * Broadcasts progress updates via PartyKit.
 */

import type { BroadcastProgressInput } from "./types";

/**
 * Broadcast progress update via PartyKit
 *
 * Never throws. This activity is pure progress telemetry, not a step in the
 * workflow's control flow — every call site awaits it bare, including the
 * failure-path broadcast in task-agent-workflow.ts (which fires from inside
 * the workflow's own catch block). If this activity rejected, that call
 * would mask the workflow's real error behind a PartyKit connectivity
 * failure. Any error, including a failure while importing the publisher
 * module itself, is caught and logged; the function always resolves. This
 * is the single approved isolation layer for PartyKit broadcasts — do not
 * add try/catch at workflow call sites as well.
 */
export async function broadcastProgress(
	input: BroadcastProgressInput,
): Promise<void> {
	let broadcastType = "unknown";

	try {
		const { planId, type, data } = input;
		broadcastType = type;

		// Import dynamically to avoid issues with workflow bundling
		const { publishTaskAgentEvent } = await import("./partykit-publisher");

		// Map the broadcast type to PartyKit event type
		const eventTypeMap: Record<string, string> = {
			agent_started: "agent_started",
			step_completed: "step_updated",
			step_added: "step_added",
			checkpoint: "checkpoint",
			checkpoint_resolved: "checkpoint_resolved",
			agent_thinking: "agent_thinking",
			agent_response: "agent_response",
			agent_completed: "agent_completed",
			agent_failed: "agent_failed",
			agent_cancelled: "agent_cancelled",
		};

		const eventType = eventTypeMap[type] || type;

		await publishTaskAgentEvent({
			type: eventType as Parameters<
				typeof publishTaskAgentEvent
			>[0]["type"],
			planId,
			data,
		});
	} catch (error) {
		console.warn(
			`[TaskAgentPartyKit] broadcastProgress failed for ${broadcastType}:`,
			error instanceof Error ? error.message : "Unknown error",
		);
	}
}
