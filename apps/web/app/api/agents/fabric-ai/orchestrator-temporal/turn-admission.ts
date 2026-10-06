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
 */

import {
	abandonConversationTurnStart,
	admitConversationTurn,
	type ConversationTurn,
	finalizeConversationTurn,
	finalizeOrphanedConversationTurn,
	getConversationTurnForExecution,
	markConversationTurnActive,
} from "@repo/database";
import type {
	OrchestratorWorkflowInput,
	OrchestratorWorkflowOutput,
} from "@repo/temporal";
import { classifyTemporalClientError } from "@repo/temporal/temporal-client-errors";
import { v4 as uuidv4 } from "uuid";
import { isOrchestratorOrganizationMember } from "./run-access";

/** The turn contract this starter speaks (see the workflow's turn input). */
const TURN_CONTRACT_VERSION = 1;

/**
 * A START_PENDING turn whose workflow Temporal does not know is only an
 * orphan once its starter has had time to start it: before that, NotFound
 * just means the start has not happened yet.
 */
const ORPHAN_START_GRACE_MS = 60_000;

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
 * Temporal NotFound: the execution does not exist. Classified across the
 * client's error cause chain (`ServiceError` wraps the gRPC status), so a
 * transport or auth failure is never mistaken for "the run is gone".
 */
export function isWorkflowNotFound(error: unknown): boolean {
	return classifyTemporalClientError(error) === "not_found";
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

type TemporalClientLike = {
	workflow: {
		getHandle: (id: string) => any;
		start: (...args: any[]) => Promise<any>;
	};
};

function terminalForOutput(
	output: Partial<OrchestratorWorkflowOutput> | undefined,
): "COMPLETED" | "FAILED" | "LIMITED" | "CANCELLED" {
	switch (output?.status) {
		case "cancelled":
			return "CANCELLED";
		case "completed":
			return output.handoffRecommended ||
				(output.limitSignals?.length ?? 0) > 0
				? "LIMITED"
				: "COMPLETED";
		default:
			return "FAILED";
	}
}

/**
 * Settle a non-terminal turn against its workflow: when the workflow has
 * closed (or never existed past the start grace period), write the turn's
 * terminal state from what Temporal reports. A Temporal error that is not
 * NotFound settles nothing and reports "unavailable" — the caller fails
 * closed rather than guessing the run is gone.
 */
export async function reconcileTurnWithWorkflow(args: {
	turn: ConversationTurn;
	temporalClient: TemporalClientLike;
	now?: number;
}): Promise<"running" | "terminalized" | "unavailable"> {
	const { turn } = args;
	if (!turn.executionId) {
		return "terminalized";
	}
	const scope = {
		turnId: turn.id,
		executionId: turn.executionId,
		userId: turn.userId,
		organizationId: turn.organizationId,
	};
	const handle = args.temporalClient.workflow.getHandle(turn.executionId);
	let statusName: string;
	try {
		const description = await handle.describe();
		statusName = description.status.name;
	} catch (error) {
		if (!isWorkflowNotFound(error)) {
			return "unavailable";
		}
		const age = (args.now ?? Date.now()) - turn.createdAt.getTime();
		if (turn.status === "START_PENDING" && age < ORPHAN_START_GRACE_MS) {
			// Its starter may still be about to start it.
			return "running";
		}
		// A compare-and-set on the state this NotFound was read against:
		// if the starter started the workflow and promoted the turn since
		// (or anything else changed it), the observation is stale and the
		// turn is left alone.
		const orphan = await finalizeOrphanedConversationTurn({
			...scope,
			observedStatus: turn.status,
			observedUpdatedAt: turn.updatedAt,
			terminalReason: "reconciled: workflow not found",
		});
		return orphan.outcome === "finalized" ? "terminalized" : "running";
	}

	switch (statusName) {
		case "RUNNING":
		case "CONTINUED_AS_NEW":
			return "running";
		case "COMPLETED": {
			let output: Partial<OrchestratorWorkflowOutput> | undefined;
			try {
				output = await handle.result();
			} catch (error) {
				// Only a proven execution failure settles the turn. A
				// transport or auth failure fetching the result settles
				// nothing: terminal states are final, and writing FAILED now
				// would destroy the answer Temporal still holds.
				if (classifyTemporalClientError(error) !== "execution_failed") {
					return "unavailable";
				}
				output = undefined;
			}
			await finalizeConversationTurn({
				...scope,
				outcome: terminalForOutput(output),
				terminalReason: `reconciled: ${output?.status ?? "completed"}`,
				responseText: output?.response ?? null,
			});
			return "terminalized";
		}
		case "CANCELLED":
			await finalizeConversationTurn({
				...scope,
				outcome: "CANCELLED",
				terminalReason: "reconciled: workflow cancelled",
			});
			return "terminalized";
		default:
			// FAILED, TERMINATED, TIMED_OUT.
			await finalizeConversationTurn({
				...scope,
				outcome: "FAILED",
				terminalReason: `reconciled: workflow ${statusName.toLowerCase()}`,
			});
			return "terminalized";
	}
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
 */
export async function admitChatTurn(args: {
	userId: string;
	organizationId: string;
	conversationId: string | null;
	clientRequestKey: string;
	executionMode: string;
	temporalClient: TemporalClientLike;
}): Promise<ChatTurnAdmission> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const admitted = await admitConversationTurn({
			userId: args.userId,
			organizationId: args.organizationId,
			conversationId: args.conversationId,
			clientRequestKey: args.clientRequestKey,
			executionId: `orch-${uuidv4()}`,
			executionMode: args.executionMode,
		});
		switch (admitted.outcome) {
			case "created":
				return { kind: "created", turn: admitted.turn };
			case "existing":
				return { kind: "existing", turn: admitted.turn };
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
			case "conflict": {
				const settled = await reconcileTurnWithWorkflow({
					turn: admitted.turn,
					temporalClient: args.temporalClient,
				});
				if (settled === "terminalized") {
					continue;
				}
				if (settled === "unavailable") {
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
				}
				return {
					kind: "refused",
					response: json(409, {
						error: "A turn is already running in this conversation",
						code: "TURN_IN_PROGRESS",
						executionId: admitted.turn.executionId,
					}),
				};
			}
		}
	}
	// The conflicting turn was terminalized but another took its place.
	return {
		kind: "refused",
		response: json(409, {
			error: "A turn is already running in this conversation",
			code: "TURN_IN_PROGRESS",
		}),
	};
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

/** Thrown by `startTurnWorkflow` for a turn that was stopped before it started. */
export class TurnStoppedBeforeStartError extends Error {
	constructor() {
		super("The turn was stopped before its workflow started");
		this.name = "TurnStoppedBeforeStartError";
	}
}

/**
 * Thrown by `startTurnWorkflow` when the start's outcome is unknown (a
 * transport-level failure: Temporal may have started the workflow and only
 * the response was lost). The turn stays START_PENDING. Not a failure: the
 * caller tells the client to retry the same message key, and that retry's
 * reattach either finds the workflow or reconciles the turn.
 */
export class TurnStartAmbiguousError extends Error {
	readonly executionId: string;
	constructor(executionId: string, cause: unknown) {
		super("The run's start could not be confirmed; retry to reconnect", {
			cause,
		});
		this.name = "TurnStartAmbiguousError";
		this.executionId = executionId;
	}
}

/**
 * Start the turn's workflow under the turn's executionId with its turnId in
 * the input, then mark the turn ACTIVE.
 *
 *   - A cancel recorded since admission: nothing is started and the turn ends
 *     CANCELLED (`TurnStoppedBeforeStartError`).
 *   - The workflow already exists (a retry whose first start's response was
 *     lost): attach to it.
 *   - An ambiguous transport error (classified across the client's cause
 *     chain): rethrown with the turn left START_PENDING.
 *   - Any other failure: the turn is marked FAILED and the error rethrown.
 */
export async function startTurnWorkflow(args: {
	temporalClient: TemporalClientLike;
	turn: ConversationTurn;
	workflowInput: OrchestratorWorkflowInput;
	/** Correlation memo; `userId`/`organizationId` are what owner checks read. */
	memo: Record<string, unknown>;
}): Promise<{ handle: unknown; attached: boolean }> {
	const { turn } = args;
	const executionId = turn.executionId;
	if (!executionId) {
		throw new TurnStoppedBeforeStartError();
	}
	const startToken = turn.startToken;
	if (!startToken) {
		// Only the request that created the turn starts it; a retry of the
		// key reattaches instead (see the stream route).
		throw new Error("Only the turn's start owner may start its workflow");
	}
	const current = await getConversationTurnForExecution({
		executionId,
		userId: turn.userId,
		organizationId: turn.organizationId,
	});
	if (
		current &&
		current.status !== "START_PENDING" &&
		current.status !== "ACTIVE"
	) {
		await abandonConversationTurnStart({
			turnId: turn.id,
			executionId,
			startToken,
			cancelled: false,
			reason: "stopped before start",
		});
		throw new TurnStoppedBeforeStartError();
	}

	const workflowInput: OrchestratorWorkflowInput = {
		...args.workflowInput,
		executionId,
		turnId: turn.id,
		turnContractVersion: TURN_CONTRACT_VERSION,
	};
	let handle: unknown;
	let attached = false;
	try {
		handle = await args.temporalClient.workflow.start(
			"orchestratorExecutionWorkflow",
			{
				// The value of `ORCHESTRATOR_TASK_QUEUE` in @repo/temporal, as
				// a literal (as the stream route always had it) so this module
				// imports only types from that package.
				taskQueue: "fabric-orchestrator",
				workflowId: executionId,
				args: [workflowInput],
				// Absolute wall-clock ceiling. Every activity in this workflow
				// already bounds itself (`startToCloseTimeout` +
				// `heartbeatTimeout`) and every human-in-the-loop `condition()`
				// wait is bounded too, so no single step can hang — but without
				// this the RUN as a whole had no ceiling, and a wedged one
				// stayed RUNNING with nothing to reclaim it. An hour is far
				// above a normal run (the stream itself caps at 11 minutes and
				// reattaches on resume) and far below "forever". A run that
				// exceeds it surfaces as TIMED_OUT, which the stream's poll loop
				// renders as an error.
				workflowExecutionTimeout: "1 hour",
				// One turn, one execution: a delayed second start (a retry
				// racing the first) must find the first execution — even one
				// that already closed — rather than start another.
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				memo: { ...args.memo, turnId: turn.id },
			},
		);
	} catch (error) {
		const kind = classifyTemporalClientError(error);
		if (kind === "already_started") {
			handle = args.temporalClient.workflow.getHandle(executionId);
			attached = true;
		} else {
			// Only a transient failure is ambiguous (the start may have applied
			// and only its response was lost): it keeps the turn START_PENDING
			// for the retry (same key) or a reconcile to settle. Every other
			// classification — including a plain NOT_FOUND refusal — is a
			// definite answer from Temporal and ends the turn.
			if (kind !== "transient") {
				await abandonConversationTurnStart({
					turnId: turn.id,
					executionId,
					startToken,
					cancelled: false,
					reason: `start failed: ${error instanceof Error ? error.message : String(error)}`.slice(
						0,
						2_000,
					),
				});
				throw error;
			}
			throw new TurnStartAmbiguousError(executionId, error);
		}
	}
	await markConversationTurnActive({ turnId: turn.id, executionId });
	return { handle, attached };
}

/** A status the turn never leaves (mirrors the database's terminal set). */
export function isTerminalTurnStatus(
	status: ConversationTurn["status"],
): boolean {
	return (
		status === "COMPLETED" ||
		status === "FAILED" ||
		status === "LIMITED" ||
		status === "CANCELLED"
	);
}

/**
 * Start a chat run that has no turn (a planner mode; see
 * `executionModeUsesTurns`): the legacy start, with a fresh execution id.
 */
export async function startLegacyChatWorkflow(args: {
	temporalClient: TemporalClientLike;
	executionId: string;
	workflowInput: OrchestratorWorkflowInput;
	memo: Record<string, unknown>;
}): Promise<unknown> {
	return args.temporalClient.workflow.start("orchestratorExecutionWorkflow", {
		taskQueue: "fabric-orchestrator",
		workflowId: args.executionId,
		args: [{ ...args.workflowInput, executionId: args.executionId }],
		// Same ceiling as a turn's run (see startTurnWorkflow).
		workflowExecutionTimeout: "1 hour",
		memo: args.memo,
	});
}

/** The domain status a stored terminal turn reports to the client. */
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
