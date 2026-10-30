import { type AGUIEvent, EventType, type Interrupt } from "@ag-ui/client";
import {
	MULTI_AGENT_RUN_EVENT,
	type MultiAgentRecordAgent,
	type MultiAgentTurnRecord,
	multiAgentRecordAgentSchema,
	multiAgentTurnRecordSchema,
} from "./multi-agent-runtime-protocol";
import { readOrchestratorRuntimeEvent } from "./orchestrator-runtime-events";
import { ORCHESTRATOR_RUN_EVENT } from "./orchestrator-runtime-protocol";
import {
	type OrchestratorStreamEvent,
	orchestratorStreamEventSchema,
} from "./orchestrator-stream-protocol";

/**
 * A multi-agent run's AG-UI events (`multi-agent-runtime-protocol.ts`) read
 * back for the chat: run-level signals, and each agent's own events as the
 * stream route's events (the single-turn reader, `readOrchestratorRuntimeEvent`,
 * applied to the agent's events once their attribution is removed).
 */
export type MultiAgentSignal =
	| { kind: "run-started"; runId: string }
	| { kind: "execution"; executionId: string }
	| {
			kind: "agent-started";
			memberKey: string;
			index: number;
			agentId: string;
			name: string;
			vendor?: string;
	  }
	| { kind: "agent-event"; memberKey: string; event: OrchestratorStreamEvent }
	| {
			kind: "agent-ended";
			memberKey: string;
			status: "complete" | "error" | "cancelled";
			answer?: string;
			error?: string;
			/** The tool calls its `completed` event carried (some arrive only there). */
			toolCalls?: CompletedToolCall[];
			/** Its failure's code and data (`AI_USAGE_LIMIT_EXCEEDED` and its limits). */
			code?: string;
			data?: unknown;
	  }
	| { kind: "agent-waiting"; memberKey: string; interrupts: Interrupt[] }
	| { kind: "agent-resolved"; memberKey: string }
	| { kind: "ended"; record: MultiAgentTurnRecord | null }
	| { kind: "interrupted" }
	| { kind: "reconnect" }
	| { kind: "stale" }
	| {
			kind: "refused";
			code: string | undefined;
			message: string;
			/** The refusal's body (a usage-limit refusal carries its limits). */
			body?: Record<string, unknown>;
	  };

/** A tool call as an agent's `completed` event carries it. */
export type CompletedToolCall = NonNullable<
	Extract<OrchestratorStreamEvent, { type: "completed" }>["toolCalls"]
>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fabricOf(metadata: unknown): Record<string, unknown> {
	return isRecord(metadata) && isRecord(metadata.fabric)
		? metadata.fabric
		: {};
}

/** The agent an event is attributed to (its member key), if any. */
function subagentOf(event: AGUIEvent): string | undefined {
	return "subagentRunId" in event && typeof event.subagentRunId === "string"
		? event.subagentRunId
		: undefined;
}

/** An agent's event without its attribution: as a single turn's run sends it. */
function unscoped(event: AGUIEvent, memberKey: string): AGUIEvent {
	const prefix = `${memberKey}:`;
	const strip = (id: string) =>
		id.startsWith(prefix) ? id.slice(prefix.length) : id;
	if (
		event.type === EventType.TOOL_CALL_START ||
		event.type === EventType.TOOL_CALL_ARGS ||
		event.type === EventType.TOOL_CALL_END ||
		event.type === EventType.TOOL_CALL_RESULT
	) {
		return { ...event, toolCallId: strip(event.toolCallId) };
	}
	if (event.type === EventType.STATE_DELTA) {
		return {
			...event,
			delta: event.delta.map((operation) => ({
				...operation,
				path: operation.path.replace(/^\/agents\/\d+/, ""),
			})),
		};
	}
	return event;
}

/** An agent's end, from a `SUBAGENT_FINISHED` result (its `completed` event or saved record). */
function endOf(
	memberKey: string,
	result: unknown,
): Extract<MultiAgentSignal, { kind: "agent-ended" }> {
	const value = isRecord(result) ? result : {};
	const recorded = multiAgentRecordAgentSchema.safeParse(value.recorded);
	if (recorded.success) {
		return recordedEnd(memberKey, recorded.data);
	}
	const completed = orchestratorStreamEventSchema.safeParse({
		...value,
		type: "completed",
	});
	return {
		kind: "agent-ended",
		memberKey,
		status: value.status === "cancelled" ? "cancelled" : "complete",
		answer: typeof value.response === "string" ? value.response : undefined,
		toolCalls:
			completed.success && completed.data.type === "completed"
				? completed.data.toolCalls
				: undefined,
	};
}

function recordedEnd(
	memberKey: string,
	agent: MultiAgentRecordAgent,
): Extract<MultiAgentSignal, { kind: "agent-ended" }> {
	return {
		kind: "agent-ended",
		memberKey,
		status: agent.status === "running" ? "error" : agent.status,
		answer: agent.answer,
		error: agent.error,
	};
}

function readAgentEvent(
	event: AGUIEvent,
	memberKey: string,
): MultiAgentSignal[] {
	if (event.type === EventType.SUBAGENT_STARTED) {
		const fabric = fabricOf(event.metadata);
		return [
			{
				kind: "agent-started",
				memberKey,
				index: typeof fabric.index === "number" ? fabric.index : 0,
				agentId:
					typeof fabric.agentId === "string" ? fabric.agentId : "",
				name: event.name,
				vendor:
					typeof fabric.vendor === "string"
						? fabric.vendor
						: undefined,
			},
		];
	}
	if (event.type === EventType.SUBAGENT_FINISHED) {
		return event.outcome?.type === "suspended"
			? []
			: [endOf(memberKey, event.result)];
	}
	if (event.type === EventType.SUBAGENT_ERROR) {
		const fabric = fabricOf(event.metadata);
		const recorded = multiAgentRecordAgentSchema.safeParse(fabric.recorded);
		return [
			recorded.success
				? recordedEnd(memberKey, recorded.data)
				: {
						kind: "agent-ended",
						memberKey,
						status: "error",
						error: event.message,
						code: event.code,
						data: fabric.data,
					},
		];
	}
	if (
		event.type === EventType.CUSTOM &&
		event.name === MULTI_AGENT_RUN_EVENT.interrupt
	) {
		const value = isRecord(event.value) ? event.value : {};
		const interrupts = Array.isArray(value.interrupts)
			? value.interrupts.filter(
					(interrupt): interrupt is Interrupt =>
						isRecord(interrupt) &&
						typeof interrupt.id === "string" &&
						typeof interrupt.reason === "string",
				)
			: [];
		return [{ kind: "agent-waiting", memberKey, interrupts }];
	}
	return readOrchestratorRuntimeEvent(unscoped(event, memberKey)).flatMap(
		(signal): MultiAgentSignal[] =>
			signal.kind === "event"
				? [{ kind: "agent-event", memberKey, event: signal.event }]
				: [],
	);
}

function readRunEvent(event: AGUIEvent): MultiAgentSignal[] {
	switch (event.type) {
		case EventType.RUN_STARTED:
			return [{ kind: "run-started", runId: event.runId }];
		case EventType.RUN_FINISHED: {
			if (event.outcome?.type === "interrupt") {
				return [{ kind: "interrupted" }];
			}
			const result = isRecord(event.result) ? event.result : {};
			const record = multiAgentTurnRecordSchema.safeParse(
				result.multiAgent,
			);
			return [
				{ kind: "ended", record: record.success ? record.data : null },
			];
		}
		case EventType.RUN_ERROR:
			return [
				{
					kind: "refused",
					code: event.code,
					message: event.message,
					body: fabricOf(event.metadata),
				},
			];
		case EventType.CUSTOM:
			return readRunCustom(event.name, event.value);
		default:
			return [];
	}
}

function readRunCustom(name: string, value: unknown): MultiAgentSignal[] {
	const record = isRecord(value) ? value : {};
	if (name === ORCHESTRATOR_RUN_EVENT.execution) {
		return typeof record.executionId === "string"
			? [{ kind: "execution", executionId: record.executionId }]
			: [];
	}
	if (name === ORCHESTRATOR_RUN_EVENT.reconnect) {
		return [{ kind: "reconnect" }];
	}
	if (name === ORCHESTRATOR_RUN_EVENT.interruptStale) {
		return [{ kind: "stale" }];
	}
	if (
		name === MULTI_AGENT_RUN_EVENT.resolved &&
		typeof record.subagentRunId === "string"
	) {
		return [{ kind: "agent-resolved", memberKey: record.subagentRunId }];
	}
	return [];
}

/** What one AG-UI event of a multi-agent run says. */
export function readMultiAgentRuntimeEvent(
	event: AGUIEvent,
): MultiAgentSignal[] {
	const memberKey = subagentOf(event);
	return memberKey ? readAgentEvent(event, memberKey) : readRunEvent(event);
}
