import {
	type ChatGptPlanChatPreflight,
	chatGptPlanApiBillingMarker,
} from "@repo/ai/lib/chatgpt-plan/plan-spent-response";
import { maybeStripReasoning } from "@repo/api/modules/agents/procedures/conversations/update-conversation";
import {
	type ConversationMessage,
	type ConversationTurn,
	finalizeConversationTurn,
	saveConversationTurn,
} from "@repo/database";
import type {
	DirectChatToolCall,
	DirectChatWorkflowOutput,
} from "@repo/temporal";
import type { CompletedTurnSettlement } from "@saas/agents/lib/server/conversation-turn-admission";
import { toolCallToPersistedStatus } from "@saas/agents/lib/tool-call-status";
import {
	failedTurnEvent,
	partialTurnEvent,
} from "../../../../app/api/agents/fabric-ai/stream/turn-events";
import type { TurnPartial } from "./turn-translator";

/** `ConversationTurn.executionMode` of a Direct turn. */
export const DIRECT_EXECUTION_MODE = "direct";

/**
 * A message as the Direct chat saves it: the conversation message plus the
 * stream lifecycle and reasoning fields its client writes beside it.
 */
type DirectConversationMessage = ConversationMessage & {
	streamStatus?: "completed" | "error" | "cancelled";
	cancelledAt?: string;
	reasoningText?: string;
	reasoningDurationMs?: number;
};

/**
 * How a turn ended, as far as what it saves is concerned. `partial` is what
 * the turn had shown when it was watched (absent when nobody watched it).
 */
export type DirectTurnEnding =
	| { kind: "completed"; result: DirectChatWorkflowOutput }
	/** The workflow failed outright: no result, only why. */
	| { kind: "failed"; message: string; partial?: TurnPartial }
	/** Cancelled or terminated: the answer as far as it had streamed. */
	| { kind: "cancelled"; partial?: TurnPartial };

/**
 * A turn that ran on the organization's API billing (or the member's own
 * key) because the ChatGPT plans were spent: the stream route's billing
 * header, as the run's `fabric.billing` event and the answer's
 * `metadata.apiBilling`.
 */
export interface ApiBillingNotice {
	resetAt: string | null;
	personalKeyProvider?: string;
}

/** The billing notice for a turn admitted with this preflight, if any. */
export function apiBillingNotice(
	preflight: ChatGptPlanChatPreflight,
): ApiBillingNotice | null {
	const marker = chatGptPlanApiBillingMarker(preflight);
	if (!marker) {
		return null;
	}
	return {
		resetAt: marker.resetAt?.toISOString() ?? null,
		...(marker.personalKeyProvider
			? { personalKeyProvider: marker.personalKeyProvider }
			: {}),
	};
}

/** The ids a turn's two messages are saved under: stable for every retry of the save. */
export function directTurnMessageIds(turnKey: string) {
	return { user: `${turnKey}:user`, assistant: `${turnKey}:assistant` };
}

/** A turn's question, saved when the turn is admitted and again, unchanged, with its answer. */
function directQuestion(turn: ConversationTurn): ConversationMessage {
	return {
		id: directTurnMessageIds(turn.clientRequestKey).user,
		role: "user",
		content: turn.questionText ?? "",
		timestamp: turn.createdAt.toISOString(),
	};
}

/**
 * The question and the answer of one Direct turn, in the shape the Direct
 * chat's own save writes (`FabricDirectChat`'s `persistConversation`): the
 * same fields, the same fallback body for a failure with nothing streamed,
 * and the reasoning trace only where the operator allows it
 * (`maybeStripReasoning`, the persistence gate the conversation procedures
 * apply). `approvalPending` marks an answer that stopped on an approval, so
 * a reconnect can raise it again.
 */
function directTurnMessages(
	turn: ConversationTurn,
	ending: DirectTurnEnding,
	apiBilling: ApiBillingNotice | null,
): ConversationMessage[] {
	const answer = directAnswer(
		directTurnMessageIds(turn.clientRequestKey).assistant,
		ending,
		apiBilling,
	);
	return [directQuestion(turn), answer];
}

/** Tool calls as the Direct chat saves them: each result as a string. */
function persistedToolCalls(
	toolCalls: DirectChatToolCall[] | undefined,
): ConversationMessage["toolCalls"] {
	return toolCalls?.map((toolCall) => ({
		id: toolCall.id,
		name: toolCall.name,
		args: toolCall.args,
		result:
			typeof toolCall.result === "string"
				? toolCall.result
				: JSON.stringify(toolCall.result),
		status: toolCallToPersistedStatus(toolCall.status),
	}));
}

/**
 * An answer that ended without a result, saved as the Direct chat saved what
 * it had on screen: the text, tool calls and reasoning as far as they
 * streamed (nothing streamed: the failure's fallback body).
 */
function stoppedAnswer(
	id: string,
	timestamp: string,
	partial: TurnPartial | undefined,
	ending:
		| { streamStatus: "error"; errorMessage: string }
		| { streamStatus: "cancelled" },
): DirectConversationMessage {
	const text = partial?.responseText ?? "";
	return maybeStripReasoning<DirectConversationMessage>({
		id,
		role: "assistant",
		content:
			text ||
			(ending.streamStatus === "error"
				? `Error: ${ending.errorMessage}`
				: ""),
		timestamp,
		...(partial && partial.toolCalls.length > 0
			? { toolCalls: persistedToolCalls(partial.toolCalls) }
			: {}),
		...(partial?.reasoningText !== undefined
			? { reasoningText: partial.reasoningText }
			: {}),
		streamStatus: ending.streamStatus,
		...(ending.streamStatus === "cancelled"
			? { cancelledAt: timestamp }
			: { metadata: { errorMessage: ending.errorMessage } }),
	});
}

function directAnswer(
	id: string,
	ending: DirectTurnEnding,
	billing: ApiBillingNotice | null,
): DirectConversationMessage {
	const answeredAt = new Date().toISOString();
	switch (ending.kind) {
		case "failed":
			return stoppedAnswer(id, answeredAt, ending.partial, {
				streamStatus: "error",
				errorMessage: ending.message,
			});
		case "cancelled":
			return stoppedAnswer(id, answeredAt, ending.partial, {
				streamStatus: "cancelled",
			});
		case "completed":
			return completedAnswer(id, answeredAt, ending.result, billing);
		default: {
			const unhandled: never = ending;
			throw new Error(
				`Unhandled turn ending: ${JSON.stringify(unhandled)}`,
			);
		}
	}
}

function completedAnswer(
	id: string,
	timestamp: string,
	result: DirectChatWorkflowOutput,
	billing: ApiBillingNotice | null,
): DirectConversationMessage {
	const failure = result.success ? null : failedTurnEvent(result);
	const partial = partialTurnEvent(result);
	const errorMessage = failure?.message ?? partial?.message;
	const limit = failure?.limit ?? partial?.limit;
	const pending = result.pendingConfirmation;
	const apiBilling = billing ?? result.apiBilling;
	const metadata: Record<string, unknown> = {
		...(result.usage ? { usage: result.usage } : {}),
		...(result.model ? { model: result.model } : {}),
		...(errorMessage ? { errorMessage } : {}),
		...(limit ? { limit } : {}),
		...(result.toolsFailedThisTurn
			? { toolsFailed: result.toolsFailedThisTurn }
			: {}),
		...(result.truncated ? { truncated: result.truncated } : {}),
		...(apiBilling ? { apiBilling } : {}),
		...(pending && "toolName" in pending ? { approvalPending: true } : {}),
	};
	return maybeStripReasoning<DirectConversationMessage>({
		id,
		role: "assistant",
		// A failure with nothing streamed still needs a body.
		content:
			(result.success ? result.responseText : undefined) ||
			(errorMessage
				? `Error: ${errorMessage}`
				: (pending?.message ?? "")),
		timestamp,
		toolCalls: persistedToolCalls(result.toolCalls),
		...(result.reasoningText !== undefined
			? {
					reasoningText: result.reasoningText,
					reasoningDurationMs: result.reasoningDurationMs,
				}
			: {}),
		streamStatus: result.success ? "completed" : "error",
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	});
}

/**
 * How an ending is recorded on the turn's row: a successful answer that
 * stopped on a limit (truncated, a partial error, a usage limit) is
 * LIMITED, the way an orchestrator turn that hit a limit is.
 */
function directTurnSettlement(
	ending: DirectTurnEnding,
): CompletedTurnSettlement {
	switch (ending.kind) {
		case "completed": {
			const { result } = ending;
			if (!result.success) {
				return {
					outcome: "FAILED",
					terminalReason:
						`failed: ${result.error ?? "workflow failed"}`.slice(
							0,
							2_000,
						),
					responseText: null,
				};
			}
			const limited =
				result.truncated ||
				result.partialError ||
				result.limitSignal ||
				result.usageLimit;
			return {
				outcome: limited ? "LIMITED" : "COMPLETED",
				terminalReason: limited ? "limited" : "completed",
				responseText: result.responseText ?? null,
			};
		}
		case "failed":
			return {
				outcome: "FAILED",
				terminalReason: `failed: ${ending.message}`.slice(0, 2_000),
				responseText: null,
			};
		case "cancelled":
			return {
				outcome: "CANCELLED",
				terminalReason: "cancelled",
				responseText: ending.partial?.responseText || null,
			};
		default: {
			const unhandled: never = ending;
			throw new Error(
				`Unhandled turn ending: ${JSON.stringify(unhandled)}`,
			);
		}
	}
}

/**
 * Save a finished turn's question and answer into its conversation, under
 * ids derived from the turn's key, so a second save (another observer, a
 * reconcile) adds nothing. The question saved at admission is the same
 * message of the same turn, so it is kept where it is and the answer goes
 * right after it (`saveConversationTurn`'s slots).
 */
async function recordDirectTurn(
	turn: ConversationTurn,
	ending: DirectTurnEnding,
	apiBilling: ApiBillingNotice | null,
): Promise<void> {
	const conversationId = turn.conversationId;
	const executionId = turn.executionId;
	if (!conversationId || !executionId) {
		return;
	}
	await saveConversationTurn({
		id: conversationId,
		userId: turn.userId,
		organizationId: turn.organizationId,
		messages: directTurnMessages(turn, ending, apiBilling),
		execution: {
			id: executionId,
			mode: DIRECT_EXECUTION_MODE,
			status: ending.kind,
		},
	});
}

/**
 * Save an admitted turn's question before its workflow starts, so the
 * conversation shows it while the turn runs (a reload, a reattach) and the
 * operation-result row the workflow appends lands after it. Stamped with
 * the turn's execution under the same id as the end-of-turn save, which
 * then keeps it in place: a retried save adds nothing. A failed save is
 * logged and left to the end-of-turn save, which writes the question too.
 */
export async function recordDirectQuestion(
	turn: ConversationTurn,
): Promise<void> {
	const conversationId = turn.conversationId;
	const executionId = turn.executionId;
	if (!conversationId || !executionId) {
		return;
	}
	try {
		await saveConversationTurn({
			id: conversationId,
			userId: turn.userId,
			organizationId: turn.organizationId,
			messages: [directQuestion(turn)],
			execution: {
				id: executionId,
				mode: DIRECT_EXECUTION_MODE,
				status: "running",
			},
		});
	} catch (error) {
		console.error("[Agent Runtime] Failed to save a Direct question", {
			executionId,
			error,
		});
	}
}

/**
 * Record a turn that ended while it was watched: save it, then write its
 * terminal state. A failed save leaves the turn live, so the next connect
 * settles it again from Temporal.
 */
export async function settleDirectTurn(
	turn: ConversationTurn,
	ending: DirectTurnEnding,
	apiBilling: ApiBillingNotice | null = null,
): Promise<void> {
	const executionId = turn.executionId;
	if (!executionId) {
		return;
	}
	try {
		await recordDirectTurn(turn, ending, apiBilling);
		await finalizeConversationTurn({
			turnId: turn.id,
			executionId,
			userId: turn.userId,
			organizationId: turn.organizationId,
			...directTurnSettlement(ending),
		});
	} catch (error) {
		console.error("[Agent Runtime] Failed to settle a Direct turn", {
			executionId,
			error,
		});
	}
}

/**
 * The reconcile's settlement of a COMPLETED turn nobody watched to its end:
 * the turn is saved into its conversation first, so the reconcile's
 * finalize never ends a turn whose answer is missing.
 */
export async function settleUnwatchedDirectTurn(
	output: DirectChatWorkflowOutput | undefined,
	turn: ConversationTurn,
): Promise<CompletedTurnSettlement> {
	const ending: DirectTurnEnding = output
		? { kind: "completed", result: output }
		: { kind: "failed", message: "The turn failed" };
	await recordDirectTurn(turn, ending, null);
	return directTurnSettlement(ending);
}
