import {
	type AGUIEvent,
	EventType,
	type RunFinishedInterruptOutcome,
	type TokenUsage,
} from "@ag-ui/client";
import type {
	DirectChatProgressUpdate,
	DirectChatToolCall,
	DirectChatWorkflowOutput,
} from "@repo/temporal";
import {
	buildWorkflowErrorEvent,
	doneTurnEvent,
	failedTurnEvent,
	partialTurnEvent,
	type TurnErrorEvent,
} from "../../../../app/api/agents/fabric-ai/stream/turn-events";

/** Sends one AG-UI event to the stream (a no-op once the client is gone). */
export type Emit = (event: AGUIEvent) => void;

/**
 * What one poll of a Direct turn shows, from whichever source has it: an
 * activity heartbeat, the `directChatProgress` query, or the result. Text,
 * reasoning and tool calls are cumulative; the phase is the latest.
 */
export interface TurnSnapshot {
	phase?: string;
	message?: string;
	progress?: number;
	currentActivity?: string;
	responseText?: string;
	reasoningText?: string;
	toolCalls?: DirectChatToolCall[];
}

/** The turn's progress as the client's agent state carries it (`state.progress`). */
interface DirectTurnProgress {
	phase: string;
	message: string;
	progress: number;
	currentActivity?: string;
}

/** The run's AG-UI state: reset to this when a run starts (`STATE_SNAPSHOT`). */
export interface DirectTurnState {
	executionId: string;
	progress: DirectTurnProgress | null;
}

/** An approval the turn stopped on, raised as the run's interrupt. */
export interface PendingApproval {
	id: string;
	toolName: string;
	args: Record<string, unknown>;
	draft?: unknown;
	message: string;
}

/**
 * What a turn had shown when it ended without a result (cancelled, or the
 * workflow failed): the answer, reasoning and tool calls as far as they
 * streamed, which the Direct chat saved as the stopped answer.
 */
export interface TurnPartial {
	responseText: string;
	reasoningText?: string;
	toolCalls: DirectChatToolCall[];
}

/** The `CUSTOM` event names this translator emits. */
export const FABRIC_EVENT = {
	reasoningDuration: "fabric.reasoning-duration",
	sources: "fabric.sources",
	partialError: "fabric.partial-error",
	/** A turn that asks to start a workflow, as the stream route's `confirmation_required`. */
	workflowConfirmation: "fabric.workflow-confirmation",
} as const;

/**
 * Where each field of the Direct workflow's result reaches the client.
 * Keyed by the result type, so a new field fails type-check here until it
 * is mapped; the translator's test checks every entry.
 */
export const DIRECT_RESULT_MAPPING = {
	success: "RUN_FINISHED (success or interrupt) / RUN_ERROR",
	responseText: "TEXT_MESSAGE_* (<key>:assistant)",
	reasoningText: "REASONING_* (<key>:reasoning)",
	reasoningDurationMs: `CUSTOM ${FABRIC_EVENT.reasoningDuration}`,
	toolCalls: "TOOL_CALL_START / ARGS / END / RESULT",
	pendingConfirmation: `RUN_FINISHED outcome interrupt (tool_approval); CUSTOM ${FABRIC_EVENT.workflowConfirmation} (a workflow start)`,
	error: "RUN_ERROR message",
	durationMs: "RUN_FINISHED result.durationMs",
	usage: "RUN_FINISHED usage[] and result.usage",
	model: "RUN_FINISHED result.model and usage[].provider / model",
	sources: `CUSTOM ${FABRIC_EVENT.sources}`,
	toolsFailedThisTurn: "RUN_FINISHED result.toolsFailed",
	partialError: `CUSTOM ${FABRIC_EVENT.partialError}`,
	limitSignal: "metadata.fabric.limit of RUN_ERROR or the partial error",
	usageLimit: "RUN_ERROR code AI_USAGE_LIMIT_EXCEEDED, metadata.fabric.data",
	truncated: "RUN_FINISHED result.truncated",
	apiBilling: "RUN_FINISHED result.apiBilling",
} as const satisfies Record<keyof DirectChatWorkflowOutput, string>;

/**
 * Every phase the Direct workflow reports, each carried as the run's
 * `state.progress` (STATE_DELTA); a new phase fails type-check here.
 */
export const DIRECT_PROGRESS_PHASES = {
	initializing: "state.progress",
	collecting_tools: "state.progress",
	generating_memory: "state.progress",
	retrieving_rag: "state.progress",
	generating_suggestions: "state.progress",
	executing_ai: "state.progress",
	completed: "state.progress",
	failed: "state.progress",
} as const satisfies Record<
	DirectChatProgressUpdate["phase"],
	"state.progress"
>;

interface ToolProgress {
	ended: boolean;
	resultSent: boolean;
}

/** `metadata.fabric` of an error event: what the Direct stream's error event carried beyond its message. */
function errorDetail(event: Pick<TurnErrorEvent, "limit" | "data">) {
	return {
		...(event.limit ? { limit: event.limit } : {}),
		...(event.data ? { data: event.data } : {}),
	};
}

/**
 * Turns the Direct workflow's cumulative snapshots into AG-UI deltas, the
 * way the stream route diffs them into its own events. Message ids derive
 * from the turn's key (`<key>:assistant`, `<key>:reasoning`), so a replay of
 * the same turn produces the same ids and the saved conversation uses them
 * too.
 */
export class TurnTranslator {
	readonly textMessageId: string;
	private readonly reasoningMessageId: string;
	private textSent = 0;
	private reasoningSent = 0;
	private textOpen = false;
	private reasoningOpen = false;
	private phase: string | undefined;
	private readonly tools = new Map<string, ToolProgress>();
	/** The answer as far as it has been seen, kept for a turn that stops early. */
	responseText = "";
	private reasoningText: string | undefined;
	/** Each tool call as last seen, in the order the turn made them. */
	private readonly toolCallsSeen = new Map<string, DirectChatToolCall>();

	constructor(
		turnKey: string,
		private readonly emit: Emit,
	) {
		this.textMessageId = `${turnKey}:assistant`;
		this.reasoningMessageId = `${turnKey}:reasoning`;
	}

	/** The state a run starts from: no progress yet. */
	static initialState(executionId: string): DirectTurnState {
		return { executionId, progress: null };
	}

	/** What the turn has shown so far, for a turn that ends without a result. */
	partial(): TurnPartial {
		return {
			responseText: this.responseText,
			...(this.reasoningText !== undefined
				? { reasoningText: this.reasoningText }
				: {}),
			toolCalls: [...this.toolCallsSeen.values()],
		};
	}

	apply(snapshot: TurnSnapshot): void {
		this.applyProgress(snapshot);
		this.applyReasoning(snapshot.reasoningText);
		for (const toolCall of snapshot.toolCalls ?? []) {
			this.applyToolCall(toolCall);
		}
		this.applyText(snapshot.responseText);
	}

	/**
	 * The turn's result, then its terminal event. A failed turn still settles
	 * its tool calls (the activity closes any it abandoned) but sends none of
	 * its text, as the stream route does. `approval`, when the turn stopped on
	 * one that is still unanswered, ends the run as an interrupt.
	 */
	finish(args: {
		threadId: string;
		runId: string;
		result: DirectChatWorkflowOutput;
		approval: PendingApproval | null;
	}): void {
		const { threadId, runId, result } = args;
		if (!result.success) {
			for (const toolCall of result.toolCalls ?? []) {
				this.applyToolCall(toolCall);
			}
			this.close();
			const failed = failedTurnEvent(result);
			this.emit({
				type: EventType.RUN_ERROR,
				message: failed.message,
				...(failed.code ? { code: failed.code } : {}),
				metadata: { fabric: errorDetail(failed) },
			});
			return;
		}
		this.apply(result);
		if (result.reasoningDurationMs !== undefined) {
			this.emit({
				type: EventType.CUSTOM,
				name: FABRIC_EVENT.reasoningDuration,
				value: {
					messageId: this.reasoningMessageId,
					durationMs: result.reasoningDurationMs,
				},
			});
		}
		if (result.sources && result.sources.length > 0) {
			this.emit({
				type: EventType.CUSTOM,
				name: FABRIC_EVENT.sources,
				value: {
					messageId: this.textMessageId,
					sources: result.sources,
				},
			});
		}
		const pending = result.pendingConfirmation;
		if (pending && "workflowId" in pending) {
			this.emit({
				type: EventType.CUSTOM,
				name: FABRIC_EVENT.workflowConfirmation,
				value: {
					messageId: this.textMessageId,
					workflowId: pending.workflowId,
					workflowName: pending.workflowName,
					description: pending.description,
					message: pending.message,
				},
			});
		}
		const partial = partialTurnEvent(result);
		if (partial) {
			this.emit({
				type: EventType.CUSTOM,
				name: FABRIC_EVENT.partialError,
				value: {
					messageId: this.textMessageId,
					message: partial.message,
					...(partial.code ? { code: partial.code } : {}),
					...errorDetail(partial),
				},
			});
		}
		this.close();

		const { type: _done, ...done } = doneTurnEvent(result);
		const usage = tokenUsageOf(result);
		this.emit({
			type: EventType.RUN_FINISHED,
			threadId,
			runId,
			result: done,
			...(usage ? { usage: [usage] } : {}),
			outcome: args.approval
				? approvalInterrupt(args.approval, result)
				: { type: "success" },
		});
	}

	/** A workflow that failed outright (its result is the failure). */
	fail(failure: unknown): void {
		this.close();
		const event = buildWorkflowErrorEvent(failure);
		this.emit({
			type: EventType.RUN_ERROR,
			message: event.message,
			...("code" in event ? { code: event.code } : {}),
			...("data" in event
				? { metadata: { fabric: { data: event.data } } }
				: {}),
		});
	}

	/** A workflow that was cancelled or terminated. */
	cancel(threadId: string, runId: string): void {
		this.close();
		this.emit({
			type: EventType.RUN_FINISHED,
			threadId,
			runId,
			outcome: { type: "cancelled" },
		});
	}

	/** Close whatever is open, so the terminal event is valid. */
	close(): void {
		this.closeReasoning();
		for (const [toolCallId, progress] of this.tools) {
			if (!progress.ended) {
				progress.ended = true;
				this.emit({ type: EventType.TOOL_CALL_END, toolCallId });
			}
		}
		if (this.textOpen) {
			this.textOpen = false;
			this.emit({
				type: EventType.TEXT_MESSAGE_END,
				messageId: this.textMessageId,
			});
		}
	}

	/** A phase change, as the stream route's `progress` event: the client's `state.progress`. */
	private applyProgress(snapshot: TurnSnapshot): void {
		if (!snapshot.phase || snapshot.phase === this.phase) {
			return;
		}
		this.phase = snapshot.phase;
		const progress: DirectTurnProgress = {
			phase: snapshot.phase,
			message: snapshot.message || "Processing...",
			progress: snapshot.progress || 0,
			...(snapshot.currentActivity
				? { currentActivity: snapshot.currentActivity }
				: {}),
		};
		this.emit({
			type: EventType.STATE_DELTA,
			delta: [{ op: "add", path: "/progress", value: progress }],
		});
	}

	private applyReasoning(text: string | undefined): void {
		if (!text || text.length <= this.reasoningSent) {
			return;
		}
		this.reasoningText = text;
		if (!this.reasoningOpen && this.reasoningSent === 0) {
			this.reasoningOpen = true;
			this.emit({
				type: EventType.REASONING_START,
				messageId: this.reasoningMessageId,
			});
			this.emit({
				type: EventType.REASONING_MESSAGE_START,
				messageId: this.reasoningMessageId,
				role: "reasoning",
			});
		}
		if (!this.reasoningOpen) {
			return;
		}
		this.emit({
			type: EventType.REASONING_MESSAGE_CONTENT,
			messageId: this.reasoningMessageId,
			delta: text.slice(this.reasoningSent),
		});
		this.reasoningSent = text.length;
	}

	private closeReasoning(): void {
		if (!this.reasoningOpen) {
			return;
		}
		this.reasoningOpen = false;
		this.emit({
			type: EventType.REASONING_MESSAGE_END,
			messageId: this.reasoningMessageId,
		});
		this.emit({
			type: EventType.REASONING_END,
			messageId: this.reasoningMessageId,
		});
	}

	/** The assistant message opens on the first text or tool call, so tools attach to it. */
	private openText(): void {
		this.closeReasoning();
		if (!this.textOpen) {
			this.textOpen = true;
			this.emit({
				type: EventType.TEXT_MESSAGE_START,
				messageId: this.textMessageId,
				role: "assistant",
			});
		}
	}

	private applyText(text: string | undefined): void {
		if (!text || text.length <= this.textSent) {
			return;
		}
		this.openText();
		this.emit({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: this.textMessageId,
			delta: text.slice(this.textSent),
		});
		this.textSent = text.length;
		this.responseText = text;
	}

	private applyToolCall(toolCall: DirectChatToolCall): void {
		this.toolCallsSeen.set(toolCall.id, toolCall);
		let progress = this.tools.get(toolCall.id);
		if (!progress) {
			this.openText();
			progress = { ended: false, resultSent: false };
			this.tools.set(toolCall.id, progress);
			this.emit({
				type: EventType.TOOL_CALL_START,
				toolCallId: toolCall.id,
				toolCallName: toolCall.name,
				parentMessageId: this.textMessageId,
				metadata: {
					fabric: {
						serverName: toolCall.serverName,
						mcpAppResourceUri: toolCall.mcpAppResourceUri,
						mcpAppConfigId: toolCall.mcpAppConfigId,
					},
				},
			});
		}
		// AG-UI streams arguments; Fabric reports them whole once the call runs.
		if (!progress.ended && toolCall.status !== "pending") {
			progress.ended = true;
			this.emit({
				type: EventType.TOOL_CALL_ARGS,
				toolCallId: toolCall.id,
				delta: JSON.stringify(toolCall.args ?? {}),
			});
			this.emit({
				type: EventType.TOOL_CALL_END,
				toolCallId: toolCall.id,
			});
		}
		if (
			!progress.resultSent &&
			(toolCall.status === "complete" || toolCall.status === "error")
		) {
			progress.resultSent = true;
			this.emit({
				type: EventType.TOOL_CALL_RESULT,
				messageId: `${toolCall.id}:result`,
				toolCallId: toolCall.id,
				role: "tool",
				content: JSON.stringify(toolCall.result ?? null),
				metadata: {
					fabric: { status: toolCall.status, error: toolCall.error },
				},
			});
		}
	}
}

/**
 * A run that stopped on an approval: AG-UI's interrupt outcome, with the
 * tool and the exact arguments it would run with, and the tool call that
 * asked. The client answers it by resuming the thread; the call that then
 * runs is the one the server recorded, never one the client sends.
 */
export function approvalInterrupt(
	approval: PendingApproval,
	result: Pick<DirectChatWorkflowOutput, "toolCalls">,
): RunFinishedInterruptOutcome {
	return {
		type: "interrupt",
		interrupts: [
			{
				id: approval.id,
				reason: "tool_approval",
				message: approval.message,
				toolCallId: result.toolCalls?.find(
					(toolCall) => toolCall.name === approval.toolName,
				)?.id,
				metadata: {
					toolName: approval.toolName,
					args: approval.args,
					draft: approval.draft,
				},
			},
		],
	};
}

/** The turn's token usage in AG-UI's shape, named by the model that answered. */
function tokenUsageOf(result: DirectChatWorkflowOutput): TokenUsage | null {
	if (!result.usage) {
		return null;
	}
	return {
		...(result.model?.provider ? { provider: result.model.provider } : {}),
		...(result.model?.id ? { model: result.model.id } : {}),
		...result.usage,
	};
}
