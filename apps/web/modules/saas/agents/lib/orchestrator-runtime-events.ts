import {
	type AGUIEvent,
	contentToText,
	EventType,
	type Message,
} from "@ag-ui/client";
import {
	type ChatGptPlanApiBilling,
	parseChatGptPlanApiBilling,
} from "./chatgpt-plan-api-billing";
import {
	ORCHESTRATOR_RUN_EVENT,
	ORCHESTRATOR_STATE_PATH,
	orchestratorTurnMessageIds,
} from "./orchestrator-runtime-protocol";
import {
	type OrchestratorStreamEvent,
	orchestratorStreamEventSchema,
} from "./orchestrator-stream-protocol";

/**
 * The agent runtime's AG-UI events for an Orchestrator turn read back as the
 * stream route's events (the table in `orchestrator-runtime-protocol.ts`),
 * so one reducer (`applyOrchestratorStreamEvent`) renders both transports.
 * What the stream route carried outside its events, or what only the runtime
 * has, comes back as its own signal.
 */
export type OrchestratorRuntimeSignal =
	| { kind: "event"; event: OrchestratorStreamEvent }
	/** A run opened (RUN_STARTED) under this run id. */
	| { kind: "run-started"; runId: string }
	/** A connect's thread so far. */
	| { kind: "snapshot"; messages: Message[] }
	| { kind: "billing"; apiBilling: ChatGptPlanApiBilling }
	/** The response's window ended; the turn did not. */
	| { kind: "reconnect" }
	| { kind: "heartbeat" }
	/** The run stopped on an approval or a question; its event came first. */
	| { kind: "interrupted" }
	/** The turn ended; its `completed` or `error` event came first. */
	| { kind: "ended" }
	/** A follow-up reached the running turn. */
	| { kind: "follow-up" }
	/** The interrupt a resume answered was no longer pending. */
	| { kind: "stale" }
	/**
	 * The run was refused before or instead of following a turn: its code,
	 * message, and the refusal's body (an HTTP status when it was the stream
	 * route's refusal).
	 */
	| {
			kind: "refused";
			code: string | undefined;
			message: string;
			status: number | undefined;
			body: Record<string, unknown>;
	  };

/** The state path a STATE_DELTA replaces, back to its stream-route event. */
const EVENT_BY_PATH = new Map<string, keyof typeof ORCHESTRATOR_STATE_PATH>([
	[ORCHESTRATOR_STATE_PATH.phase, "phase"],
	[ORCHESTRATOR_STATE_PATH.routing, "routing"],
	[ORCHESTRATOR_STATE_PATH.planning, "planning"],
	[ORCHESTRATOR_STATE_PATH.step_start, "step_start"],
	[ORCHESTRATOR_STATE_PATH.progress, "progress"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fabricOf(event: { metadata?: unknown }): Record<string, unknown> {
	const metadata = isRecord(event.metadata) ? event.metadata : {};
	return isRecord(metadata.fabric) ? metadata.fabric : {};
}

/** A stream-route event, validated; anything else is dropped (and logged). */
function eventOf(value: unknown): OrchestratorRuntimeSignal[] {
	const parsed = orchestratorStreamEventSchema.safeParse(value);
	if (!parsed.success) {
		console.warn("[OrchestratorRuntime] Unreadable event", parsed.error);
		return [];
	}
	return [{ kind: "event", event: parsed.data }];
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The stream-route events (and signals) one AG-UI event of a run carries. */
export function readOrchestratorRuntimeEvent(
	event: AGUIEvent,
): OrchestratorRuntimeSignal[] {
	switch (event.type) {
		case EventType.RUN_STARTED:
			return [{ kind: "run-started", runId: event.runId }];
		case EventType.MESSAGES_SNAPSHOT:
			return [{ kind: "snapshot", messages: event.messages }];
		case EventType.TEXT_MESSAGE_START:
			// A new segment: the next text replaces the answer's.
			return eventOf({ type: "text_start" });
		case EventType.TEXT_MESSAGE_CONTENT:
			return eventOf({ type: "text_delta", content: event.delta });
		case EventType.TOOL_CALL_START:
			return eventOf({
				...fabricOf(event),
				type: "tool_start",
				toolCallId: event.toolCallId,
			});
		case EventType.TOOL_CALL_ARGS:
			return eventOf({
				...fabricOf(event),
				type: "tool_input",
				toolCallId: event.toolCallId,
				args: parseJson(event.delta),
			});
		case EventType.TOOL_CALL_RESULT:
			return eventOf({
				...fabricOf(event),
				type: "tool_result",
				toolCallId: event.toolCallId,
				result: parseJson(contentToText(event.content)),
			});
		case EventType.STATE_DELTA:
			return event.delta.flatMap((operation: unknown) => {
				if (
					!isRecord(operation) ||
					typeof operation.path !== "string"
				) {
					return [];
				}
				const type = EVENT_BY_PATH.get(operation.path);
				return type && isRecord(operation.value)
					? eventOf({ ...operation.value, type })
					: [];
			});
		case EventType.CUSTOM:
			return readCustom(event.name, event.value);
		case EventType.RUN_FINISHED:
			return readRunFinished(event);
		case EventType.RUN_ERROR:
			return readRunError(event);
		default:
			// The text and tool boundaries, the state snapshot and the
			// rest of AG-UI carry nothing the stream route had.
			return [];
	}
}

function readCustom(name: string, value: unknown): OrchestratorRuntimeSignal[] {
	switch (name) {
		case ORCHESTRATOR_RUN_EVENT.execution: {
			const execution = isRecord(value) ? value : {};
			return eventOf({
				type: "started",
				executionId: execution.executionId,
				workflowId: execution.executionId,
				resumed: execution.resumed === true,
				turnId: execution.turnId,
				turnGeneration: execution.turnGeneration,
			});
		}
		case ORCHESTRATOR_RUN_EVENT.billing: {
			const apiBilling = parseChatGptPlanApiBilling(value);
			return apiBilling ? [{ kind: "billing", apiBilling }] : [];
		}
		case ORCHESTRATOR_RUN_EVENT.reconnect:
			return [{ kind: "reconnect" }];
		case ORCHESTRATOR_RUN_EVENT.heartbeat:
			return [{ kind: "heartbeat" }];
		case ORCHESTRATOR_RUN_EVENT.event:
			return eventOf(value);
		case ORCHESTRATOR_RUN_EVENT.followUp:
			return [{ kind: "follow-up" }];
		case ORCHESTRATOR_RUN_EVENT.interruptStale:
			return [{ kind: "stale" }];
		default:
			return [];
	}
}

function readRunFinished(
	event: Extract<AGUIEvent, { type: EventType.RUN_FINISHED }>,
): OrchestratorRuntimeSignal[] {
	const outcome = event.outcome;
	if (outcome?.type === "interrupt") {
		const interrupt = outcome.interrupts[0];
		return interrupt
			? [...eventOf(fabricOf(interrupt)), { kind: "interrupted" }]
			: [];
	}
	const result = isRecord(event.result) ? event.result : {};
	const cancelled = outcome?.type === "cancelled";
	return [
		...eventOf({
			// A run stopped before its turn started has no result.
			...(cancelled
				? {
						status: "cancelled",
						response: "",
						toolCalls: [],
						stepResults: [],
					}
				: {}),
			...result,
			type: "completed",
		}),
		{ kind: "ended" },
	];
}

/**
 * A turn's answer as the runtime saved it (a connect's snapshot), as the
 * terminal event it ended with: found by the turn's key, or by the
 * execution every saved message of the turn is stamped with.
 */
export function savedOrchestratorAnswerEvent(
	messages: Message[],
	turn: { turnKey: string | null; executionId: string | null },
): OrchestratorStreamEvent | null {
	const answerId = turn.turnKey
		? orchestratorTurnMessageIds(turn.turnKey).assistant
		: null;
	const saved = messages.find((message) => {
		if (message.role !== "assistant") {
			return false;
		}
		if (message.id === answerId) {
			return true;
		}
		const metadata = fabricOf(message).metadata;
		return (
			turn.executionId !== null &&
			isRecord(metadata) &&
			metadata.executionId === turn.executionId
		);
	});
	if (!saved) {
		return null;
	}
	const content = typeof saved.content === "string" ? saved.content : "";
	switch (fabricOf(saved).streamStatus) {
		case "cancelled":
			return {
				type: "completed",
				status: "cancelled",
				response: content,
			};
		case "error":
			return { type: "error", message: content || "Execution failed." };
		default:
			return {
				type: "completed",
				status: "completed",
				response: content,
			};
	}
}

function readRunError(
	event: Extract<AGUIEvent, { type: EventType.RUN_ERROR }>,
): OrchestratorRuntimeSignal[] {
	const fabric = fabricOf(event);
	// A turn that failed carries its whole `error` event; a refused run
	// carries the refusal's body, which is never an event.
	if (fabric.type === "error") {
		return [...eventOf(fabric), { kind: "ended" }];
	}
	return [
		{
			kind: "refused",
			code: event.code,
			message: event.message,
			status:
				typeof fabric.status === "number" ? fabric.status : undefined,
			body: fabric,
		},
	];
}
