/**
 * Chat turn admission shared by every chat engine that records its turns as
 * `ConversationTurn` rows (the Orchestrator's stream routes and the agent
 * runtime's Direct engine). Engine specifics — the execution id's prefix, the
 * token ledger, how a finished workflow's output settles the turn and how the
 * workflow is started — come from the caller; the durable rules are here:
 *
 *   1. `admitTurn` — idempotent by client key, one live turn per
 *      conversation (a conflicting turn is first reconciled against
 *      Temporal), only in the caller's own conversation.
 *   2. `startAdmittedTurn` — starts the workflow under the turn's executionId;
 *      a lost start response (the workflow already exists) attaches; a
 *      definite start failure ends the turn FAILED.
 *   3. `reconcileTurnWithWorkflow` — settles a turn nobody watched to its end
 *      from what Temporal reports.
 */

import {
	abandonConversationTurnStart,
	admitConversationTurn,
	type ConversationTurn,
	type ConversationTurnBudgetAdmission,
	type ConversationTurnTerminalStatus,
	type FinalizeConversationTurnInput,
	finalizeConversationTurn,
	finalizeOrphanedConversationTurn,
	getConversationTurnForExecution,
	markConversationTurnActive,
} from "@repo/database";
import { classifyTemporalClientError } from "@repo/temporal/temporal-client-errors";
import { runningMultiAgentSibling } from "./multi-agent-admission";

/**
 * A START_PENDING turn whose workflow Temporal does not know is only an
 * orphan once its starter has had time to start it: before that, NotFound
 * just means the start has not happened yet.
 */
const ORPHAN_START_GRACE_MS = 60_000;

export type TemporalClientLike = {
	workflow: {
		getHandle: (id: string) => any;
		start: (...args: any[]) => Promise<any>;
	};
};

/**
 * Temporal NotFound: the execution does not exist. Classified across the
 * client's error cause chain (`ServiceError` wraps the gRPC status), so a
 * transport or auth failure is never mistaken for "the run is gone".
 */
export function isWorkflowNotFound(error: unknown): boolean {
	return classifyTemporalClientError(error) === "not_found";
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

/** What a COMPLETED workflow's output writes to its turn. */
export type CompletedTurnSettlement = Pick<
	FinalizeConversationTurnInput,
	"responseText" | "budgetStop"
> & {
	outcome: ConversationTurnTerminalStatus;
	terminalReason: string;
};

/**
 * Reads a COMPLETED workflow's output (undefined when only the execution's
 * failure could be proven) into the turn's terminal state. An engine may
 * also record the turn elsewhere here (the Direct engine saves it into its
 * conversation) before the terminal write.
 */
export type SettleCompletedTurn<Output> = (
	output: Output | undefined,
	turn: ConversationTurn,
) => CompletedTurnSettlement | Promise<CompletedTurnSettlement>;

/**
 * Settle a non-terminal turn against its workflow: when the workflow has
 * closed (or never existed past the start grace period), write the turn's
 * terminal state from what Temporal reports. A Temporal error that is not
 * NotFound settles nothing and reports "unavailable" — the caller fails
 * closed rather than guessing the run is gone.
 */
export async function reconcileTurnWithWorkflow<Output>(args: {
	turn: ConversationTurn;
	temporalClient: TemporalClientLike;
	settleCompleted: SettleCompletedTurn<Output>;
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
			let output: Output | undefined;
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
				...(await args.settleCompleted(output, turn)),
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

/** Why admission refused a turn. */
export type TurnAdmissionRefusal =
	/** The named conversation is not the caller's in this organization. */
	| { reason: "conversation_forbidden" }
	/** The key already belongs to a message in a different conversation. */
	| { reason: "key_reused" }
	/** Temporal could not say whether the conversation's live turn runs. */
	| { reason: "state_unavailable" }
	/**
	 * Another turn is running in the conversation. `executionId` names it
	 * when it is known, and is absent when the conflicting turn was settled
	 * but another took its place.
	 */
	| { reason: "in_progress"; executionId?: string | null };

export type TurnAdmission =
	/** A new turn: run the pre-work, then `startAdmittedTurn`. */
	| { kind: "created"; turn: ConversationTurn }
	/** The key already has a turn: never start a second workflow for it. */
	| { kind: "existing"; turn: ConversationTurn }
	| { kind: "refused"; refusal: TurnAdmissionRefusal };

/**
 * Admit a chat turn (see the file header). A conflicting live turn whose
 * workflow turns out to be gone is terminalized and admission retried once;
 * one still running refuses the new message (`in_progress`) rather than
 * attaching to it; a Temporal outage is `state_unavailable`. A retry of the
 * same key finds the existing turn and changes nothing.
 */
export async function admitTurn<Output>(args: {
	userId: string;
	organizationId: string;
	conversationId: string | null;
	clientRequestKey: string;
	/** A fresh execution id, used only if a NEW turn is created. */
	newExecutionId: () => string;
	executionMode: string;
	/** The message the turn answers, kept on a new turn's row. */
	question: string;
	/** The token ledger a new turn is admitted with; none when omitted. */
	budget?: ConversationTurnBudgetAdmission;
	temporalClient: TemporalClientLike;
	settleCompleted: SettleCompletedTurn<Output>;
}): Promise<TurnAdmission> {
	if (args.conversationId) {
		// A multi-agent turn is live until every agent has ended, though
		// only its first agent's turn belongs to the conversation.
		const sibling = await runningMultiAgentSibling({
			userId: args.userId,
			organizationId: args.organizationId,
			conversationId: args.conversationId,
			clientRequestKey: args.clientRequestKey,
			temporalClient: args.temporalClient,
		});
		if (sibling === "unavailable") {
			return {
				kind: "refused",
				refusal: { reason: "state_unavailable" },
			};
		}
		if (sibling) {
			return {
				kind: "refused",
				refusal: {
					reason: "in_progress",
					executionId: sibling.executionId,
				},
			};
		}
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const admitted = await admitConversationTurn({
			userId: args.userId,
			organizationId: args.organizationId,
			conversationId: args.conversationId,
			clientRequestKey: args.clientRequestKey,
			executionId: args.newExecutionId(),
			executionMode: args.executionMode,
			question: args.question,
			budget: args.budget,
		});
		switch (admitted.outcome) {
			case "created":
				return { kind: "created", turn: admitted.turn };
			case "existing":
				return { kind: "existing", turn: admitted.turn };
			case "conversation_forbidden":
				return {
					kind: "refused",
					refusal: { reason: "conversation_forbidden" },
				};
			case "key_reused":
				return { kind: "refused", refusal: { reason: "key_reused" } };
			case "conflict": {
				const settled = await reconcileTurnWithWorkflow({
					turn: admitted.turn,
					temporalClient: args.temporalClient,
					settleCompleted: args.settleCompleted,
				});
				if (settled === "terminalized") {
					continue;
				}
				if (settled === "unavailable") {
					return {
						kind: "refused",
						refusal: { reason: "state_unavailable" },
					};
				}
				return {
					kind: "refused",
					refusal: {
						reason: "in_progress",
						executionId: admitted.turn.executionId,
					},
				};
			}
			default: {
				const unhandled: never = admitted;
				throw new Error(
					`Unhandled turn admission outcome: ${JSON.stringify(unhandled)}`,
				);
			}
		}
	}
	// The conflicting turn was terminalized but another took its place.
	return { kind: "refused", refusal: { reason: "in_progress" } };
}

/** Thrown by `startAdmittedTurn` for a turn that was stopped before it started. */
export class TurnStoppedBeforeStartError extends Error {
	constructor() {
		super("The turn was stopped before its workflow started");
		this.name = "TurnStoppedBeforeStartError";
	}
}

/**
 * Thrown by `startAdmittedTurn` when the start's outcome is unknown (a
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
 * Start an admitted turn's workflow under the turn's executionId, then mark
 * the turn ACTIVE. `start` starts it (any engine pre-work that can fail
 * belongs inside it, so its failure ends the turn the same way).
 *
 *   - A cancel recorded since admission: nothing is started and the turn ends
 *     CANCELLED (`TurnStoppedBeforeStartError`).
 *   - The workflow already exists (a retry whose first start's response was
 *     lost): attach to it.
 *   - An ambiguous transport error (classified across the client's cause
 *     chain): rethrown with the turn left START_PENDING.
 *   - Any other failure: the turn is marked FAILED and the error rethrown.
 */
export async function startAdmittedTurn<Handle>(args: {
	turn: ConversationTurn;
	start: (executionId: string) => Promise<Handle>;
	/** The handle of a workflow a lost start response had already started. */
	attach: (executionId: string) => Handle;
}): Promise<{ handle: Handle; attached: boolean }> {
	const { turn } = args;
	const executionId = turn.executionId;
	if (!executionId) {
		throw new TurnStoppedBeforeStartError();
	}
	const startToken = turn.startToken;
	if (!startToken) {
		// Only the request that created the turn starts it; a retry of the
		// key reattaches instead.
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

	let handle: Handle;
	let attached = false;
	try {
		handle = await args.start(executionId);
	} catch (error) {
		const kind = classifyTemporalClientError(error);
		if (kind !== "already_started") {
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
		handle = args.attach(executionId);
		attached = true;
	}
	await markConversationTurnActive({ turnId: turn.id, executionId });
	return { handle, attached };
}
