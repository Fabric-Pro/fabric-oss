import { orchestratorApprovalProtocol } from "@repo/temporal/approval-rollout";
/**
 * Advisor chat turn admission — the one path every chat starter of the
 * orchestrator workflow takes to create a turn and start its run.
 *
 * Used by the SSE stream route (`./stream/route.ts`) and its non-stream
 * sibling (`./route.ts`). Non-chat starters (story automations, Weave,
 * project setup) start the workflow without a turn and keep the legacy
 * behaviour.
 *
 *   1. `resolveTurnOrganization` — the organization is required and resolved
 *      server-side (body, else the session's active one) with a tie to it.
 *   2. `admitChatTurn` — the durable record decides: idempotent by client
 *      key, one live turn per conversation (a conflicting turn is first
 *      reconciled against Temporal), only in the caller's own conversation.
 *   3. `startTurnWorkflow` — starts the workflow with the turn's executionId
 *      and turnId; a lost start response (the workflow already exists)
 *      attaches; a definite start failure marks the turn FAILED.
 *
 * The engine-neutral rules behind 2 and 3, and the reconcile, live in
 * `@saas/agents/lib/server/conversation-turn-admission` (the agent runtime's
 * Direct engine admits its turns through them too); this module adds the
 * Orchestrator's execution ids, token ledger, workflow start and HTTP
 * responses.
 */

import {
	abandonConversationTurnStart,
	type ConversationTurn,
	getConversationTurnForExecution,
} from "@repo/database";
import type {
	ExecutionMode,
	OrchestratorWorkflowInput,
	OrchestratorWorkflowOutput,
} from "@repo/temporal";
import { turnBudgetForExecutionMode } from "@repo/temporal/turn-budget-policy";
import {
	admitTurn,
	type CompletedTurnSettlement,
	isTerminalTurnStatus,
	isWorkflowNotFound,
	reconcileTurnWithWorkflow as reconcileWithSettlement,
	startAdmittedTurn,
	type TemporalClientLike,
} from "@saas/agents/lib/server/conversation-turn-admission";
import { parseTurnBudgetStop } from "@saas/agents/lib/turn-budget-stop";
import { v4 as uuidv4 } from "uuid";
import { assertChatWorkflowPayload } from "../chat-workflow-payload";
import { budgetContinuationSeed } from "./budget-continuation";
import { isOrchestratorOrganizationMember } from "./run-access";

export {
	isTerminalTurnStatus,
	isWorkflowNotFound,
	TurnStartAmbiguousError,
	TurnStoppedBeforeStartError,
} from "@saas/agents/lib/server/conversation-turn-admission";

/** The turn contract this starter speaks (see the workflow's turn input). */
const TURN_CONTRACT_VERSION = 1;

const CLIENT_REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * The client's per-message idempotency key, or a server-generated one when
 * an older client sent none (that client gets no idempotency). A malformed
 * key is refused rather than replaced: a retry must hit the same key.
 */
export function resolveClientRequestKey(
	raw: unknown,
): { ok: true; key: string } | { ok: false; response: Response } {
	if (raw === undefined || raw === null || raw === "") {
		return { ok: true, key: uuidv4() };
	}
	if (typeof raw !== "string" || !CLIENT_REQUEST_KEY_PATTERN.test(raw)) {
		return {
			ok: false,
			response: json(400, {
				error: "Invalid request body",
				message:
					"clientRequestKey must be 8-128 letters, digits, '-' or '_'",
			}),
		};
	}
	return { ok: true, key: raw };
}

/**
 * The organization a chat turn runs in: the one the body names, else the
 * session's active organization, and the caller must be a member of it. With
 * neither, the request fails closed (ADR-018: the organization is the only
 * tenant context).
 */
export async function resolveTurnOrganization(args: {
	userId: string;
	requestedOrganizationId: unknown;
	session: { activeOrganizationId?: string | null } | null | undefined;
}): Promise<
	{ ok: true; organizationId: string } | { ok: false; response: Response }
> {
	const candidate =
		(typeof args.requestedOrganizationId === "string" &&
		args.requestedOrganizationId.length > 0
			? args.requestedOrganizationId
			: undefined) ??
		args.session?.activeOrganizationId ??
		undefined;
	if (!candidate) {
		return {
			ok: false,
			response: json(403, {
				error: "Forbidden",
				message: "No organization is active for this session",
			}),
		};
	}
	// Membership, the same rule approve, clarify, follow-up and cancel apply
	// (one helper, ./run-access.ts): a project guest's organization tie is
	// not enough to start a chat turn they could then not answer.
	if (!(await isOrchestratorOrganizationMember(args.userId, candidate))) {
		return {
			ok: false,
			response: json(403, {
				error: "Forbidden",
				message: "You are not a member of this organization",
			}),
		};
	}
	return { ok: true, organizationId: candidate };
}

/**
 * Whether the chat starters give this execution mode a turn — the same
 * function the browser uses to decide whether a message may be re-sent by
 * its key (see the shared module).
 */
export { executionModeUsesTurns } from "@saas/agents/lib/orchestrator-turn-modes";

/**
 * How long a reattach waits for a START_PENDING turn's workflow to appear
 * (its starter may still be doing pre-work), and how often it looks.
 * Mutable only so a test can shorten it.
 */
export const PENDING_ATTACH_TIMING = { waitMs: 10_000, pollMs: 500 };

/**
 * Wait, within `PENDING_ATTACH_TIMING`, for a turn's workflow to exist.
 * "absent" when it still does not; "unavailable" when Temporal cannot say.
 */
export async function waitForTurnWorkflow(args: {
	temporalClient: TemporalClientLike;
	executionId: string;
}): Promise<"exists" | "absent" | "unavailable"> {
	const deadline = Date.now() + PENDING_ATTACH_TIMING.waitMs;
	for (;;) {
		try {
			await args.temporalClient.workflow
				.getHandle(args.executionId)
				.describe();
			return "exists";
		} catch (error) {
			if (!isWorkflowNotFound(error)) {
				return "unavailable";
			}
		}
		if (Date.now() + PENDING_ATTACH_TIMING.pollMs > deadline) {
			return "absent";
		}
		await new Promise((resolve) =>
			setTimeout(resolve, PENDING_ATTACH_TIMING.pollMs),
		);
	}
}

/** 503 when Temporal cannot say whether a turn's workflow exists. */
export function turnStateUnavailableResponse(): Response {
	return new Response(
		JSON.stringify({
			error: "Temporarily unavailable",
			code: "TURN_STATE_UNAVAILABLE",
		}),
		{
			status: 503,
			headers: { "Content-Type": "application/json", "Retry-After": "2" },
		},
	);
}

/**
 * After a reattach waited for a START_PENDING turn's workflow and none
 * appeared: re-read the turn (a cancel or a finalize may have landed during
 * the wait) and reconcile it like a conflicting turn at admission. "pending"
 * while it is within the orphan grace period, "terminal" with the stored
 * row once it is (or has just been made) terminal, "unavailable" when
 * Temporal cannot say.
 */
export async function settleAbandonedTurn(args: {
	temporalClient: TemporalClientLike;
	executionId: string;
	userId: string;
	organizationId: string;
}): Promise<
	| { kind: "pending" }
	| { kind: "unavailable" }
	| { kind: "terminal"; turn: ConversationTurn }
> {
	const lookup = () =>
		getConversationTurnForExecution({
			executionId: args.executionId,
			userId: args.userId,
			organizationId: args.organizationId,
		});
	const current = await lookup();
	if (!current) {
		return { kind: "pending" };
	}
	if (isTerminalTurnStatus(current.status)) {
		return { kind: "terminal", turn: current };
	}
	const settled = await reconcileTurnWithWorkflow({
		turn: current,
		temporalClient: args.temporalClient,
	});
	if (settled === "unavailable") {
		return { kind: "unavailable" };
	}
	if (settled === "running") {
		return { kind: "pending" };
	}
	const after = await lookup();
	return after && isTerminalTurnStatus(after.status)
		? { kind: "terminal", turn: after }
		: { kind: "pending" };
}

/** 409 for a reattach to a turn whose workflow has not started yet. */
export function turnPendingResponse(executionId: string): Response {
	return new Response(
		JSON.stringify({
			error: "The turn has not started yet",
			code: "TURN_PENDING",
			executionId,
		}),
		{
			status: 409,
			headers: { "Content-Type": "application/json", "Retry-After": "2" },
		},
	);
}

function terminalForOutput(
	output: Partial<OrchestratorWorkflowOutput> | undefined,
): "COMPLETED" | "FAILED" | "LIMITED" | "CANCELLED" {
	switch (output?.status) {
		case "cancelled":
			return "CANCELLED";
		case "completed":
			return output.handoffRecommended ||
				output.budgetStop ||
				(output.limitSignals?.length ?? 0) > 0
				? "LIMITED"
				: "COMPLETED";
		default:
			return "FAILED";
	}
}

/**
 * What a COMPLETED orchestrator run writes to its turn: its outcome, answer
 * and structured budget stop, so a reconnect renders the stop without a
 * new-chat workaround.
 */
function settleCompletedOrchestratorTurn(
	output: Partial<OrchestratorWorkflowOutput> | undefined,
): CompletedTurnSettlement {
	return {
		outcome: terminalForOutput(output),
		terminalReason: `reconciled: ${output?.status ?? "completed"}`,
		responseText: output?.response ?? null,
		...(output?.budgetStop ? { budgetStop: { ...output.budgetStop } } : {}),
	};
}

/**
 * Settle a non-terminal orchestrator turn against its workflow (see
 * `reconcileTurnWithWorkflow` in the shared admission module).
 */
export function reconcileTurnWithWorkflow(args: {
	turn: ConversationTurn;
	temporalClient: TemporalClientLike;
	now?: number;
}): Promise<"running" | "terminalized" | "unavailable"> {
	return reconcileWithSettlement({
		...args,
		settleCompleted: settleCompletedOrchestratorTurn,
	});
}

export type ChatTurnAdmission =
	/** A new turn: run the pre-work, then `startTurnWorkflow`. */
	| { kind: "created"; turn: ConversationTurn }
	/** The key already has a turn: never start a second workflow for it. */
	| { kind: "existing"; turn: ConversationTurn }
	/** The response to send instead (403 / 409 / 422 / 503). */
	| { kind: "refused"; response: Response };

/**
 * Admit a chat turn (see the file header). A conflicting live turn whose
 * workflow turns out to be gone is terminalized and admission retried once;
 * one still running is a 409 TURN_IN_PROGRESS carrying its executionId
 * (the chat refuses the new message rather than attaching to that turn);
 * a Temporal outage is a retryable 503.
 *
 * A new turn is admitted with its token ledger: the allowance of the
 * server-validated `executionMode` the run will start with, frozen on the
 * row. A retry of the same key finds the existing turn and changes nothing.
 */
export async function admitChatTurn(args: {
	userId: string;
	organizationId: string;
	conversationId: string | null;
	clientRequestKey: string;
	executionMode: string;
	/** The message the turn answers, kept on a new turn's row. */
	question: string;
	temporalClient: TemporalClientLike;
}): Promise<ChatTurnAdmission> {
	const admission = await admitTurn({
		...args,
		newExecutionId: () => `orch-${uuidv4()}`,
		budget: turnBudgetForExecutionMode(args.executionMode as ExecutionMode),
		settleCompleted: settleCompletedOrchestratorTurn,
	});
	if (admission.kind !== "refused") {
		return admission;
	}
	const { refusal } = admission;
	switch (refusal.reason) {
		case "conversation_forbidden":
			return {
				kind: "refused",
				response: json(403, {
					error: "Forbidden",
					message: "This conversation is not accessible",
				}),
			};
		case "key_reused":
			return {
				kind: "refused",
				response: json(422, {
					error: "clientRequestKey reused",
					message:
						"This request key already belongs to a message in a different conversation",
				}),
			};
		case "state_unavailable":
			return {
				kind: "refused",
				response: new Response(
					JSON.stringify({
						error: "Temporarily unavailable",
						code: "TURN_STATE_UNAVAILABLE",
						message:
							"Could not confirm the conversation's running turn. Please retry.",
					}),
					{
						status: 503,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": "2",
						},
					},
				),
			};
		case "in_progress":
			return {
				kind: "refused",
				response: json(409, {
					error: "A turn is already running in this conversation",
					code: "TURN_IN_PROGRESS",
					// Absent (and so left out of the body) when the conflicting
					// turn was settled but another took its place.
					executionId: refusal.executionId,
				}),
			};
		default: {
			const unhandled: never = refusal;
			throw new Error(
				`Unhandled turn refusal: ${JSON.stringify(unhandled)}`,
			);
		}
	}
}

/** 409 for a key whose turn was cancelled before it started. */
export function cancelledBeforeStartResponse(): Response {
	return json(409, {
		error: "This message was stopped before it started",
		code: "TURN_CANCELLED",
	});
}

/** The cancel-before-start tombstone: the only turn with no execution. */
export function isCancelledBeforeStart(turn: ConversationTurn): boolean {
	return turn.executionId === null;
}

/**
 * The client went away before the turn became ACTIVE: record the cancel
 * (source DISCONNECT_BEFORE_START) and, since no workflow will be started
 * for it, end the turn now.
 */
export async function cancelTurnBeforeStart(args: {
	turn: ConversationTurn;
	reason: string;
}): Promise<boolean> {
	const { turn } = args;
	if (!turn.executionId || !turn.startToken) {
		// Not this request's turn to end: only its start owner may.
		return false;
	}
	// Owner-only and START_PENDING-only (./conversation-turns): the workflow
	// was never started by this request, so there is nothing to cancel in
	// Temporal, and a turn already promoted is never ended here.
	return abandonConversationTurnStart({
		turnId: turn.id,
		executionId: turn.executionId,
		startToken: turn.startToken,
		cancelled: true,
		reason: args.reason,
	});
}

/**
 * Start the turn's workflow under the turn's executionId with its turnId in
 * the input, then mark the turn ACTIVE (see `startAdmittedTurn` in the
 * shared admission module for the cancel, attach and failure rules).
 */
export function startTurnWorkflow(args: {
	temporalClient: TemporalClientLike;
	turn: ConversationTurn;
	workflowInput: OrchestratorWorkflowInput;
	continueFromTurnId?: string;
	/** Correlation memo; `userId`/`organizationId` are what owner checks read. */
	memo: Record<string, unknown>;
}): Promise<{ handle: unknown; attached: boolean }> {
	const { turn } = args;
	return startAdmittedTurn<unknown>({
		turn,
		attach: (executionId) =>
			args.temporalClient.workflow.getHandle(executionId),
		start: async (executionId) => {
			const protocol = orchestratorApprovalProtocol();
			const workflowInput: OrchestratorWorkflowInput = {
				...args.workflowInput,
				...protocol,
				executionId,
				toolLoadingMode:
					process.env.ADVISOR_TOOL_LOADING === "call_tool"
						? "call_tool"
						: undefined,
				historyRetention:
					process.env.ADVISOR_HISTORY_RETENTION === "bounded"
						? "bounded"
						: undefined,
				turnId: turn.id,
				turnContractVersion: TURN_CONTRACT_VERSION,
				...(turn.tokenAllowance != null
					? { turnTokenAllowance: turn.tokenAllowance }
					: {}),
				// The ledger fences reservations on it (under the workflow's
				// `orch-turn-budget-v1` marker); null for a turn with no conversation.
				turnGeneration: turn.generation,
			};
			if (args.continueFromTurnId) {
				if (!turn.conversationId) {
					throw new Error("Continuation requires a conversation");
				}
				const seed = await budgetContinuationSeed({
					turnId: args.continueFromTurnId,
					conversationId: turn.conversationId,
					userId: turn.userId,
					organizationId: turn.organizationId,
					successorTurnId: turn.id,
				});
				workflowInput.history = [
					...(workflowInput.history ?? []),
					seed,
				];
				assertChatWorkflowPayload(
					workflowInput,
					"orchestrator budget continuation",
				);
			}
			return args.temporalClient.workflow.start(
				"orchestratorExecutionWorkflow",
				{
					// The value of `ORCHESTRATOR_TASK_QUEUE` in @repo/temporal, as
					// a literal (as the stream route always had it) so this module
					// imports only types from that package.
					taskQueue: "fabric-orchestrator",
					workflowId: executionId,
					args: [workflowInput],
					// Under orch-main-round-budget-v1, a cancellation scope bounds
					// Advisor chat work to 45 minutes from the start event. After
					// cancellation settles (at most the current activity's remaining
					// start-to-close, up to 5 minutes in the loop), synthesis runs
					// outside that scope: two calls × 5 minutes × 3 attempts = 30
					// minutes, plus 6 seconds of retry delays. Finalization is
					// 1 minute × 5 attempts + 15 seconds of retry delays. About 40
					// minutes total leaves ~35 of the remaining 75 for queueing and
					// completion. Service outages can still prevent a durable write.

					workflowExecutionTimeout: "2 hours",
					// One turn, one execution: a delayed second start (a retry
					// racing the first) must find the first execution — even one
					// that already closed — rather than start another.
					workflowIdReusePolicy: "REJECT_DUPLICATE",
					memo: { ...args.memo, ...protocol, turnId: turn.id },
				},
			);
		},
	});
}

/**
 * Start a chat run that has no turn (Weave; see `executionModeUsesTurns`):
 * the legacy start, with a fresh execution id.
 */
export async function startLegacyChatWorkflow(args: {
	temporalClient: TemporalClientLike;
	executionId: string;
	workflowInput: OrchestratorWorkflowInput;
	memo: Record<string, unknown>;
}): Promise<unknown> {
	const protocol = orchestratorApprovalProtocol();
	return args.temporalClient.workflow.start("orchestratorExecutionWorkflow", {
		taskQueue: "fabric-orchestrator",
		workflowId: args.executionId,
		args: [
			{
				...args.workflowInput,
				...protocol,
				executionId: args.executionId,
			},
		],
		// Same ceiling as a turn's run (see startTurnWorkflow).
		workflowExecutionTimeout: "2 hours",
		memo: { ...args.memo, ...protocol },
	});
}

/** The domain status a stored terminal turn reports to the client. */
/**
 * The turn row's structured token-allowance stop, validated for the stream:
 * the same payload the live `completed` event carries (counts as plain
 * numbers), or undefined when the row has none or it is malformed.
 */
export function turnBudgetStopForStream(
	value: unknown,
): OrchestratorWorkflowOutput["budgetStop"] {
	return parseTurnBudgetStop(value);
}

export function resultStatusForTurn(
	status: ConversationTurn["status"],
): "completed" | "failed" | "cancelled" {
	switch (status) {
		case "CANCELLED":
		case "CANCEL_REQUESTED":
			return "cancelled";
		case "FAILED":
			return "failed";
		default:
			return "completed";
	}
}
