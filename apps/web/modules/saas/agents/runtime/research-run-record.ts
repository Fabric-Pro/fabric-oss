import {
	type ConversationMessage,
	type ConversationTurn,
	finalizeConversationTurn,
	getConversationTurnForExecution,
	getLatestConversationTurn,
	saveConversationTurn,
} from "@repo/database";
import type { DeepResearcherOutput } from "@repo/temporal";
import { researchReportMarkdown } from "@saas/agents/lib/research-report-markdown";
import {
	RESEARCH_EXECUTION_MODE,
	type ResearchRunRecord,
	researchResultView,
	researchRunResultOf,
	researchTurnMessageIds,
} from "@saas/agents/lib/research-runtime-protocol";
import type {
	CompletedTurnSettlement,
	SettleCompletedTurn,
} from "@saas/agents/lib/server/conversation-turn-admission";
import type { RuntimeCaller } from "./engine";

/**
 * How a research run ended, as far as what it saves is concerned: the
 * workflow's output, why it failed, or that it was stopped.
 */
export type ResearchRunEnding =
	| { kind: "completed"; output: DeepResearcherOutput }
	| { kind: "failed"; message: string }
	| { kind: "cancelled" };

/** A message as the research run saves it: the stream lifecycle beside it. */
type ResearchConversationMessage = ConversationMessage & {
	streamStatus: "completed" | "error" | "cancelled";
};

/** Whether a turn is a research run (and so this engine's own). */
export function isResearchTurn(
	turn: Pick<ConversationTurn, "executionMode">,
): boolean {
	return turn.executionMode === RESEARCH_EXECUTION_MODE;
}

/** The thread's latest research run, or null when it has none (or the latest is another engine's). */
export async function latestResearchTurn(
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
	threadId: string,
): Promise<ConversationTurn | null> {
	const latest = await getLatestConversationTurn({
		conversationId: threadId,
		userId: caller.userId,
		organizationId: caller.organizationId,
	});
	return latest && isResearchTurn(latest) ? latest : null;
}

function researchQuestion(turn: ConversationTurn): ConversationMessage {
	return {
		id: researchTurnMessageIds(turn.clientRequestKey).user,
		role: "user",
		content: turn.questionText ?? "",
		timestamp: turn.createdAt.toISOString(),
	};
}

/**
 * Save an admitted run's question before its workflow starts, so the
 * conversation shows it while the research runs (a reload, a reattach).
 * Stamped with the run's execution under the same id as the end-of-run save,
 * which then keeps it in place. A failed save is logged and left to the
 * end-of-run save, which writes the question too.
 */
export async function recordResearchQuestion(
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
			messages: [researchQuestion(turn)],
			execution: {
				id: executionId,
				mode: RESEARCH_EXECUTION_MODE,
				status: "running",
			},
		});
	} catch (error) {
		console.error("[Agent Runtime] Failed to save a research question", {
			executionId,
			error,
		});
	}
}

function researchAnswer(
	turn: ConversationTurn,
	executionId: string,
	ending: ResearchRunEnding,
): ResearchConversationMessage {
	const base = {
		id: researchTurnMessageIds(turn.clientRequestKey).assistant,
		role: "assistant" as const,
		timestamp: new Date().toISOString(),
	};
	switch (ending.kind) {
		case "completed": {
			const result = researchRunResultOf(ending.output);
			const record: ResearchRunRecord = {
				status: "completed",
				executionId,
				result,
			};
			return {
				...base,
				content: researchReportMarkdown(researchResultView(result)),
				streamStatus: "completed",
				metadata: { research: record },
			};
		}
		case "failed": {
			const record: ResearchRunRecord = {
				status: "failed",
				executionId,
				error: ending.message,
			};
			return {
				...base,
				content: `Research failed: ${ending.message}`,
				streamStatus: "error",
				metadata: { research: record },
			};
		}
		case "cancelled": {
			const record: ResearchRunRecord = {
				status: "cancelled",
				executionId,
			};
			return {
				...base,
				content: "Research cancelled.",
				streamStatus: "cancelled",
				metadata: { research: record },
			};
		}
		default: {
			const unhandled: never = ending;
			throw new Error(
				`Unhandled research ending: ${JSON.stringify(unhandled)}`,
			);
		}
	}
}

/**
 * Save a finished run's question and answer into its conversation, under
 * ids derived from the run's key, so a second save (another observer, a
 * reconcile) adds nothing.
 */
async function recordResearchRun(
	turn: ConversationTurn,
	ending: ResearchRunEnding,
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
		messages: [
			researchQuestion(turn),
			researchAnswer(turn, executionId, ending),
		],
		execution: {
			id: executionId,
			mode: RESEARCH_EXECUTION_MODE,
			status: ending.kind,
		},
	});
}

/** How an ending is recorded on the turn's row. */
function researchRunSettlement(
	ending: ResearchRunEnding,
): CompletedTurnSettlement {
	switch (ending.kind) {
		case "completed":
			return {
				outcome: "COMPLETED",
				terminalReason: "research: completed",
			};
		case "failed":
			return { outcome: "FAILED", terminalReason: "research: failed" };
		case "cancelled":
			return {
				outcome: "CANCELLED",
				terminalReason: "research: cancelled",
			};
		default: {
			const unhandled: never = ending;
			throw new Error(
				`Unhandled research ending: ${JSON.stringify(unhandled)}`,
			);
		}
	}
}

/**
 * Record a run that ended: save it, then write its terminal state. A failed
 * save leaves the turn live, so the next connect settles it again from
 * Temporal.
 */
export async function settleResearchRun(
	turn: ConversationTurn,
	ending: ResearchRunEnding,
): Promise<void> {
	const executionId = turn.executionId;
	if (!executionId) {
		return;
	}
	try {
		await recordResearchRun(turn, ending);
		await finalizeConversationTurn({
			turnId: turn.id,
			executionId,
			userId: turn.userId,
			organizationId: turn.organizationId,
			...researchRunSettlement(ending),
		});
	} catch (error) {
		console.error("[Agent Runtime] Failed to settle a research run", {
			executionId,
			error,
		});
	}
}

/**
 * How a COMPLETED workflow's output ended the run. The workflow catches a
 * cancellation and completes with `failed`, so a run stopped by its person
 * (`turnNow` reads CANCEL_REQUESTED) that did not complete counts as
 * cancelled.
 */
export function researchEndingOf(
	output: DeepResearcherOutput,
	turnNow: Pick<ConversationTurn, "status"> | null,
): ResearchRunEnding {
	if (
		output.status === "cancelled" ||
		(output.status !== "completed" &&
			turnNow?.status === "CANCEL_REQUESTED")
	) {
		return { kind: "cancelled" };
	}
	if (output.status === "completed") {
		return { kind: "completed", output };
	}
	return { kind: "failed", message: output.error ?? "Research failed" };
}

/** The turn as it is now, read again by its execution. */
export function currentResearchTurn(
	turn: ConversationTurn,
): Promise<ConversationTurn | null> {
	const executionId = turn.executionId;
	if (!executionId) {
		return Promise.resolve(null);
	}
	return getConversationTurnForExecution({
		executionId,
		userId: turn.userId,
		organizationId: turn.organizationId,
	});
}

/**
 * The reconcile's settlement of a COMPLETED run nobody watched to its end:
 * the run is saved into its conversation first, so the reconcile's finalize
 * never ends a run whose answer is missing.
 */
export const settleUnwatchedResearchRun: SettleCompletedTurn<
	DeepResearcherOutput
> = async (output, turn) => {
	const ending: ResearchRunEnding = output
		? researchEndingOf(output, await currentResearchTurn(turn))
		: { kind: "failed", message: "The research failed" };
	await recordResearchRun(turn, ending);
	return researchRunSettlement(ending);
};
