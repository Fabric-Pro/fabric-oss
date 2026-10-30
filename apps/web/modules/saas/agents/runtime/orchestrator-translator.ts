import { EventType } from "@ag-ui/client";
import {
	ORCHESTRATOR_INTERRUPT_REASON,
	ORCHESTRATOR_RUN_EVENT,
	ORCHESTRATOR_STATE_PATH,
} from "@saas/agents/lib/orchestrator-runtime-protocol";
import type { OrchestratorStreamInput } from "@saas/agents/lib/orchestrator-stream-protocol";
import type { Emit } from "./turn-translator";

type StreamEvent<Type extends OrchestratorStreamInput["type"]> = Extract<
	OrchestratorStreamInput,
	{ type: Type }
>;

/** How a turn ended, as the stream route reports it: held until the turn is saved. */
export type OrchestratorTerminal = StreamEvent<"completed" | "error">;
export type OrchestratorStepComplete = StreamEvent<"step_complete">;
type OrchestratorRouting = StreamEvent<"routing">;
type OrchestratorPlan = StreamEvent<"planning">["plan"];

/** What one response showed of the turn, for the record a finished turn saves. */
export interface OrchestratorTurnFacts {
	routing: OrchestratorRouting | null;
	plan: OrchestratorPlan | null;
	/** The answer's text since the last replacement, as the chat shows it. */
	answerText: string;
	/** Completed steps by id, in the order the chat lists them. */
	steps: Map<string, OrchestratorStepComplete>;
}

/**
 * One response's translation of an Orchestrator turn's stream-route events
 * (`execution-observer.ts`) into AG-UI (the table in
 * `orchestrator-runtime-protocol.ts`). The terminal `completed` / `error`
 * is held, not sent, so the follower can save the turn first and then
 * `finish` it. An approval or a clarification ends the run as an interrupt;
 * events after it in the same poll are dropped (the next response replays
 * the run's state).
 */
export class OrchestratorTranslator {
	private segmentId: string | null = null;
	private segments = 0;
	private readonly startedTools = new Set<string>();
	private readonly endedTools = new Set<string>();
	private interrupted = false;
	/** When the last text delta was sent (epoch ms); 0 before any. */
	lastTextAt = 0;
	terminal: OrchestratorTerminal | null = null;
	readonly facts: OrchestratorTurnFacts = {
		routing: null,
		plan: null,
		answerText: "",
		steps: new Map(),
	};

	constructor(
		private readonly run: {
			turnKey: string;
			/** Distinguishes this response's text segments from another's. */
			windowNonce: string;
			threadId: string;
			runId: string;
			emit: Emit;
			/** Interrupts this run just answered: never raised again by it. */
			decided: ReadonlySet<string>;
		},
	) {}

	/** True once the run ended as an interrupt or the turn ended. */
	get stopped(): boolean {
		return this.interrupted || this.terminal !== null;
	}

	/** Whether a text segment is open (a quiet point is one without). */
	get textOpen(): boolean {
		return this.segmentId !== null;
	}

	apply(event: OrchestratorStreamInput): void {
		if (this.stopped) {
			return;
		}
		switch (event.type) {
			case "text_start":
				this.closeText();
				return;
			case "text_delta":
				this.applyText(event.content);
				return;
			case "tool_start":
			case "tool_input":
			case "tool_result":
				this.applyTool(event);
				return;
			case "routing":
				this.facts.routing = event;
				this.replaceState(event);
				return;
			case "planning":
				this.facts.plan = event.plan;
				this.replaceState(event);
				return;
			case "phase":
			case "step_start":
			case "progress":
				this.replaceState(event);
				return;
			case "step_complete":
				this.recordStep(event);
				this.carry(event);
				return;
			case "limit_signal":
			case "context_compacted":
			case "mcp_default_tool_invoked":
			case "mcp_default_tool_failed":
			case "approval_resolved":
			case "clarifying_resolved":
				this.carry(event);
				return;
			case "approval_required":
				this.interrupt(
					event.approvalId ?? event.stepId,
					ORCHESTRATOR_INTERRUPT_REASON.approval,
					event.reason,
					event,
				);
				return;
			case "clarifying_question":
				this.interrupt(
					event.clarificationId,
					ORCHESTRATOR_INTERRUPT_REASON.clarification,
					event.question,
					event,
				);
				return;
			case "completed":
			case "error":
				this.terminal = event;
				return;
			// The follower's own events: the observer never sends these.
			case "started":
			case "start_pending":
			case "stream_timeout":
				return;
			default: {
				const unhandled: never = event;
				throw new Error(
					`Unhandled orchestrator event: ${JSON.stringify(unhandled)}`,
				);
			}
		}
	}

	/** The held terminal event, after the turn is saved. */
	finish(terminal: OrchestratorTerminal): void {
		this.close();
		const { threadId, runId, emit } = this.run;
		if (terminal.type === "error") {
			// The whole `error` event, so the client tells a turn that failed
			// from a run that was refused (whose metadata is the refusal's body).
			emit({
				type: EventType.RUN_ERROR,
				message:
					terminal.message ??
					terminal.error ??
					"Workflow execution failed",
				...(terminal.code ? { code: terminal.code } : {}),
				metadata: { fabric: terminal },
			});
			return;
		}
		const { type: _completed, ...result } = terminal;
		emit({
			type: EventType.RUN_FINISHED,
			threadId,
			runId,
			result,
			outcome:
				terminal.status === "cancelled"
					? { type: "cancelled" }
					: { type: "success" },
		});
	}

	/** Close whatever is open, so the response can end. */
	close(): void {
		this.closeText();
		for (const toolCallId of this.startedTools) {
			this.endTool(toolCallId);
		}
	}

	private applyText(content: string): void {
		if (!content) {
			return;
		}
		if (this.segmentId === null) {
			// A new segment replaces the answer's text (the stream route's
			// `text_start` rule): opened after an iteration start, and by the
			// first text of every response, which may follow a gap.
			this.segments += 1;
			this.segmentId = `${this.run.turnKey}:text:${this.segments}:${this.run.windowNonce}`;
			this.facts.answerText = "";
			this.run.emit({
				type: EventType.TEXT_MESSAGE_START,
				messageId: this.segmentId,
				role: "assistant",
			});
		}
		this.facts.answerText += content;
		this.lastTextAt = Date.now();
		this.run.emit({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: this.segmentId,
			delta: content,
		});
	}

	private closeText(): void {
		if (this.segmentId === null) {
			return;
		}
		this.run.emit({
			type: EventType.TEXT_MESSAGE_END,
			messageId: this.segmentId,
		});
		this.segmentId = null;
	}

	private applyTool(
		event: StreamEvent<"tool_start" | "tool_input" | "tool_result">,
	): void {
		const toolCallId = event.toolCallId;
		if (!toolCallId) {
			this.carry(event);
			return;
		}
		const emit = this.run.emit;
		switch (event.type) {
			case "tool_start": {
				const { type: _start, ...fabric } = event;
				this.startedTools.add(toolCallId);
				emit({
					type: EventType.TOOL_CALL_START,
					toolCallId,
					toolCallName: event.toolName ?? event.name ?? "tool",
					...(this.segmentId
						? { parentMessageId: this.segmentId }
						: {}),
					metadata: { fabric },
				});
				return;
			}
			case "tool_input": {
				const { type: _input, args, ...fabric } = event;
				// The whole arguments each time they change: a replacement,
				// not a chunk to append (the stream route's `tool_input`).
				emit({
					type: EventType.TOOL_CALL_ARGS,
					toolCallId,
					delta: JSON.stringify(args ?? null),
					metadata: { fabric },
				});
				return;
			}
			case "tool_result": {
				const { type: _result, result, ...fabric } = event;
				this.endTool(toolCallId);
				emit({
					type: EventType.TOOL_CALL_RESULT,
					messageId: `${toolCallId}:result`,
					toolCallId,
					role: "tool",
					content: JSON.stringify(result ?? null),
					metadata: { fabric },
				});
				return;
			}
			default: {
				const unhandled: never = event;
				throw new Error(
					`Unhandled tool event: ${JSON.stringify(unhandled)}`,
				);
			}
		}
	}

	private endTool(toolCallId: string): void {
		if (
			!this.startedTools.has(toolCallId) ||
			this.endedTools.has(toolCallId)
		) {
			return;
		}
		this.endedTools.add(toolCallId);
		this.run.emit({ type: EventType.TOOL_CALL_END, toolCallId });
	}

	private replaceState(
		event: StreamEvent<
			"phase" | "routing" | "planning" | "step_start" | "progress"
		>,
	): void {
		const { type, ...value } = event;
		this.run.emit({
			type: EventType.STATE_DELTA,
			delta: [
				{ op: "replace", path: ORCHESTRATOR_STATE_PATH[type], value },
			],
		});
	}

	private recordStep(event: OrchestratorStepComplete): void {
		const steps = this.facts.steps;
		steps.delete(event.stepId);
		steps.set(event.stepId, event);
		const plan = this.facts.plan;
		if (plan) {
			this.facts.plan = {
				...plan,
				steps: plan.steps.map((step) =>
					step.id === event.stepId
						? { ...step, status: event.status ?? "complete" }
						: step,
				),
			};
		}
	}

	/** An event with no AG-UI counterpart, carried whole. */
	private carry(event: OrchestratorStreamInput): void {
		this.run.emit({
			type: EventType.CUSTOM,
			name: ORCHESTRATOR_RUN_EVENT.event,
			value: event,
		});
	}

	private interrupt(
		id: string,
		reason: string,
		message: string,
		event: StreamEvent<"approval_required" | "clarifying_question">,
	): void {
		if (this.run.decided.has(id)) {
			return;
		}
		this.close();
		this.interrupted = true;
		this.run.emit({
			type: EventType.RUN_FINISHED,
			threadId: this.run.threadId,
			runId: this.run.runId,
			outcome: {
				type: "interrupt",
				interrupts: [
					{ id, reason, message, metadata: { fabric: event } },
				],
			},
		});
	}
}
