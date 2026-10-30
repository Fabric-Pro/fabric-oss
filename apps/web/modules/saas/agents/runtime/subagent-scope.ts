import { type AGUIEvent, EventType, type Interrupt } from "@ag-ui/client";
import {
	multiAgentStatePath,
	multiAgentToolCallId,
} from "@saas/agents/lib/multi-agent-runtime-protocol";

/**
 * One agent's Orchestrator events as an AG-UI subagent of a multi-agent run
 * (`multi-agent-runtime-protocol.ts`): attributed by `subagentRunId` (the
 * agent's member key), tool-call ids made unique across the run's agents,
 * and state paths moved under the agent's index. Text message ids are
 * already unique: each agent's translator derives them from its own key.
 */
export interface SubagentScope {
	index: number;
	memberKey: string;
}

/** An agent's event, attributed to it. Run-level events are the follower's to map. */
export function scopeSubagentEvent(
	event: AGUIEvent,
	scope: SubagentScope,
): AGUIEvent {
	const subagentRunId = scope.memberKey;
	const toolCallId = (id: string) =>
		multiAgentToolCallId(scope.memberKey, id);
	if (
		event.type === EventType.TEXT_MESSAGE_START ||
		event.type === EventType.TEXT_MESSAGE_CONTENT ||
		event.type === EventType.TEXT_MESSAGE_END ||
		event.type === EventType.CUSTOM
	) {
		return { ...event, subagentRunId };
	}
	if (
		event.type === EventType.TOOL_CALL_START ||
		event.type === EventType.TOOL_CALL_ARGS ||
		event.type === EventType.TOOL_CALL_END
	) {
		return {
			...event,
			toolCallId: toolCallId(event.toolCallId),
			subagentRunId,
		};
	}
	if (event.type === EventType.TOOL_CALL_RESULT) {
		return {
			...event,
			messageId: toolCallId(event.messageId),
			toolCallId: toolCallId(event.toolCallId),
			subagentRunId,
		};
	}
	if (event.type === EventType.STATE_DELTA) {
		return {
			...event,
			delta: event.delta.map((operation) => ({
				...operation,
				path: multiAgentStatePath(scope.index, operation.path),
			})),
			subagentRunId,
		};
	}
	return event;
}

/** An agent's interrupt as the run raises it: its id unique across the run's agents. */
export function scopeSubagentInterrupt(
	interrupt: Interrupt,
	scope: SubagentScope,
): Interrupt {
	return {
		...interrupt,
		id: multiAgentToolCallId(scope.memberKey, interrupt.id),
		subagentRunId: scope.memberKey,
	};
}
