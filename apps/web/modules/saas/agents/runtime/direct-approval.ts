import { EventType } from "@ag-ui/client";
import {
	type ConversationMessage,
	type ConversationTurn,
	getConversationTurnByClientKey,
	getLatestConversationTurn,
} from "@repo/database";
import type { DirectChatWorkflowOutput } from "@repo/temporal";
import {
	ChatRunAccessError,
	getAuthorizedChatRun,
} from "@saas/agents/lib/server/chat-run-control";
import {
	DIRECT_EXECUTION_MODE,
	directTurnMessageIds,
} from "./direct-turn-record";
import type { RunStream, RuntimeCaller } from "./engine";
import { approvalInterrupt, type PendingApproval } from "./turn-translator";

/**
 * Approvals on the runtime. A Direct turn that stops on a tool's
 * `requiresConfirmation` ends its run as an AG-UI interrupt with id
 * `<turnKey>:approval`. The interrupt is pending while that turn is still
 * the thread's latest and no answer is recorded; the answer is the turn
 * keyed `<interruptId>:resume` (a run for an approval, a CANCELLED tombstone
 * for a decline), so each interrupt is answered at most once.
 */
const APPROVAL_SUFFIX = ":approval";
export const RESUME_SUFFIX = ":resume";

/** The turn statuses a turn that stopped on an approval ends with. */
const ANSWERED_STATUSES: ReadonlySet<ConversationTurn["status"]> = new Set([
	"COMPLETED",
	"LIMITED",
]);

/** The thread's latest Direct turn, or null when it has none (or the latest is another engine's). */
export async function latestDirectTurn(
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
	threadId: string,
): Promise<ConversationTurn | null> {
	const latest = await getLatestConversationTurn({
		conversationId: threadId,
		userId: caller.userId,
		organizationId: caller.organizationId,
	});
	return latest?.executionMode === DIRECT_EXECUTION_MODE ? latest : null;
}

/** A turn by its client key, when it is a Direct turn of this thread. */
export async function directTurnByKey(
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
	threadId: string,
	clientRequestKey: string,
): Promise<ConversationTurn | null> {
	const turn = await getConversationTurnByClientKey({
		clientRequestKey,
		userId: caller.userId,
		organizationId: caller.organizationId,
	});
	return turn?.conversationId === threadId &&
		turn.executionMode === DIRECT_EXECUTION_MODE
		? turn
		: null;
}

/**
 * The approval a finished turn stopped on, while it is still unanswered:
 * the turn is still the thread's latest, and no answer to it is recorded.
 */
export async function unansweredApproval(
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
	turn: ConversationTurn,
	result: DirectChatWorkflowOutput,
): Promise<PendingApproval | null> {
	const pending = result.pendingConfirmation;
	if (!pending || !("toolName" in pending) || !turn.conversationId) {
		return null;
	}
	const id = `${turn.clientRequestKey}${APPROVAL_SUFFIX}`;
	const [latest, answered] = await Promise.all([
		latestDirectTurn(caller, turn.conversationId),
		getConversationTurnByClientKey({
			clientRequestKey: `${id}${RESUME_SUFFIX}`,
			userId: caller.userId,
			organizationId: caller.organizationId,
		}),
	]);
	if (latest?.id !== turn.id || answered) {
		return null;
	}
	return {
		id,
		toolName: pending.toolName,
		args: pending.args,
		draft: pending.draft,
		message: pending.message,
	};
}

/**
 * The result of a finished Direct turn, read from Temporal with the
 * control routes' authorization; null when it is not finished or not the
 * caller's to observe.
 */
async function finishedDirectResult(
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
	turn: ConversationTurn,
): Promise<DirectChatWorkflowOutput | null> {
	if (!turn.executionId || !ANSWERED_STATUSES.has(turn.status)) {
		return null;
	}
	try {
		const { handle, description } = await getAuthorizedChatRun({
			executionId: turn.executionId,
			userId: caller.userId,
			engine: "direct",
			action: "observe",
			expectedOrganizationId: caller.organizationId,
		});
		if (description.status.name !== "COMPLETED") {
			return null;
		}
		const result: DirectChatWorkflowOutput = await handle.result();
		return result;
	} catch (error) {
		if (error instanceof ChatRunAccessError) {
			return null;
		}
		throw error;
	}
}

/**
 * The approval an interrupt id names, while it is pending: the interrupted
 * turn is in this thread, finished on the approval, and still unanswered.
 * The approval comes from the turn's workflow result, never the client.
 */
export async function pendingApprovalFor(
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
	threadId: string,
	interruptId: string,
): Promise<PendingApproval | null> {
	if (!interruptId.endsWith(APPROVAL_SUFFIX)) {
		return null;
	}
	const interrupted = await directTurnByKey(
		caller,
		threadId,
		interruptId.slice(0, -APPROVAL_SUFFIX.length),
	);
	if (!interrupted) {
		return null;
	}
	const result = await finishedDirectResult(caller, interrupted);
	return result ? unansweredApproval(caller, interrupted, result) : null;
}

/**
 * After a reconnect's snapshot: when the thread's last answer stopped on an
 * approval nobody answered yet, raise its interrupt again (the run's
 * boundary only; the answer itself is in the snapshot).
 */
export async function raiseUnansweredApproval(
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
	latest: ConversationTurn,
	lastSaved: ConversationMessage | undefined,
	stream: RunStream,
): Promise<void> {
	const threadId = latest.conversationId;
	if (
		!threadId ||
		lastSaved?.id !==
			directTurnMessageIds(latest.clientRequestKey).assistant ||
		lastSaved.metadata?.approvalPending !== true
	) {
		return;
	}
	const result = await finishedDirectResult(caller, latest);
	const approval = result
		? await unansweredApproval(caller, latest, result)
		: null;
	if (!result || !approval) {
		return;
	}
	const runId = latest.clientRequestKey;
	stream.emit({ type: EventType.RUN_STARTED, threadId, runId });
	stream.emit({
		type: EventType.RUN_FINISHED,
		threadId,
		runId,
		outcome: approvalInterrupt(approval, result),
	});
}
