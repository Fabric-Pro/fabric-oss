/**
 * Conversation turns — the server-owned record of one Advisor chat turn.
 *
 * See the `ConversationTurn` model in schema.prisma for the status machine.
 * Every transition here is a conditional UPDATE (`updateMany` with the
 * expected source status in its WHERE), so two writers racing on one turn
 * cannot overwrite each other: the one whose precondition no longer holds
 * updates zero rows and re-reads.
 *
 * Every read and write names the tenant explicitly (userId AND
 * organizationId), because the API and the worker use the base `db`, which
 * bypasses RLS; the query filter is the enforced boundary.
 */

import { randomUUID } from "node:crypto";
import { db } from "../client";
import type {
	ConversationTurn,
	ConversationTurnCancelSource,
	ConversationTurnStatus,
	Prisma,
} from "../generated/client";
import { advisoryObjectKey } from "./lib/refresh-lock-key";

/** The turn row, for callers outside this package (the chat starters). */
export type { ConversationTurn };

/**
 * Advisory-lock class for turn admission and cancel-by-key (arbitrary but
 * stable, in the `(int4, int4)` space the rest of this package uses).
 */
const CONVERSATION_TURN_ADVISORY_CLASS = 0x43547572; // "CTur"

/** Statuses a turn can still leave. */
export const CONVERSATION_TURN_NON_TERMINAL_STATUSES = [
	"START_PENDING",
	"ACTIVE",
	"CANCEL_REQUESTED",
] as const satisfies readonly ConversationTurnStatus[];

/** Statuses a turn never leaves. */
export const CONVERSATION_TURN_TERMINAL_STATUSES = [
	"COMPLETED",
	"FAILED",
	"LIMITED",
	"CANCELLED",
] as const satisfies readonly ConversationTurnStatus[];

export type ConversationTurnTerminalStatus =
	(typeof CONVERSATION_TURN_TERMINAL_STATUSES)[number];

export function isTerminalConversationTurnStatus(
	status: ConversationTurnStatus,
): status is ConversationTurnTerminalStatus {
	return (CONVERSATION_TURN_TERMINAL_STATUSES as readonly string[]).includes(
		status,
	);
}

// Both locks are taken in this order on every path — key first, then
// conversation — so an admission and a cancel-by-key can never wait on each
// other in opposite orders.
async function lockClientKey(
	tx: Prisma.TransactionClient,
	args: { userId: string; organizationId: string; clientRequestKey: string },
): Promise<void> {
	const key = advisoryObjectKey(
		`turnkey:${args.userId}:${args.organizationId}:${args.clientRequestKey}`,
	);
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CONVERSATION_TURN_ADVISORY_CLASS}::int, ${key}::int)`;
}

async function lockConversation(
	tx: Prisma.TransactionClient,
	conversationId: string,
): Promise<void> {
	const key = advisoryObjectKey(`turnconv:${conversationId}`);
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CONVERSATION_TURN_ADVISORY_CLASS}::int, ${key}::int)`;
}

async function conversationIsCallers(
	tx: Prisma.TransactionClient,
	args: { conversationId: string; userId: string; organizationId: string },
): Promise<boolean> {
	const owned = await tx.agentConversation.findFirst({
		where: {
			id: args.conversationId,
			userId: args.userId,
			organizationId: args.organizationId,
		},
		select: { id: true },
	});
	return owned !== null;
}

// ============================================================================
// Admission
// ============================================================================

export interface AdmitConversationTurnInput {
	userId: string;
	organizationId: string;
	/** The conversation the turn runs in; null/undefined for none (Nexus). */
	conversationId?: string | null;
	clientRequestKey: string;
	/** The execution id to use if a NEW turn is created. */
	executionId: string;
	executionMode: string;
}

export type AdmitConversationTurnResult =
	/**
	 * A new START_PENDING turn; start its workflow with `turn.executionId`.
	 * Only this outcome carries `turn.startToken` — the caller now owns the
	 * startup and alone may abandon it.
	 */
	| { outcome: "created"; turn: ConversationTurn }
	/**
	 * The key already has a turn (an idempotent retry, or a cancel-before-start
	 * tombstone). Never start a second workflow: attach to `turn.executionId`,
	 * or report the turn's terminal state.
	 */
	| { outcome: "existing"; turn: ConversationTurn }
	/** Another live turn holds the conversation; reconnect to it instead. */
	| { outcome: "conflict"; turn: ConversationTurn }
	/** The key was used for a turn in a different conversation. */
	| { outcome: "key_reused"; turn: ConversationTurn }
	/** The named conversation is not the caller's in this organization. */
	| { outcome: "conversation_forbidden" };

/**
 * Admit one turn: idempotent by client key, at most one live turn per
 * conversation, and only in a conversation the caller owns in the same
 * organization.
 *
 * Runs in one transaction under a key lock and, when there is a
 * conversation, a conversation lock, so concurrent retries of one key and
 * concurrent messages in one conversation are serialized: exactly one of
 * them creates the turn. This only decides; it does not start the workflow
 * and it does not reconcile a conflicting turn against Temporal — the caller
 * does both (see the web layer's turn admission).
 */
export async function admitConversationTurn(
	args: AdmitConversationTurnInput,
): Promise<AdmitConversationTurnResult> {
	if (!args.userId || !args.organizationId || !args.clientRequestKey) {
		throw new Error(
			"admitConversationTurn requires userId, organizationId and clientRequestKey",
		);
	}
	if (!args.executionId) {
		throw new Error("admitConversationTurn requires an executionId");
	}
	const conversationId = args.conversationId || null;

	return db.$transaction(
		async (tx) => {
			await lockClientKey(tx, args);
			if (conversationId) {
				await lockConversation(tx, conversationId);
			}

			const existing = await tx.conversationTurn.findUnique({
				where: {
					userId_organizationId_clientRequestKey: {
						userId: args.userId,
						organizationId: args.organizationId,
						clientRequestKey: args.clientRequestKey,
					},
				},
			});
			if (existing) {
				// Only the request that created a turn holds its start token;
				// a retry of the key never does.
				const seen = withoutStartToken(existing);
				// A tombstone (the only row with no execution id) refuses the
				// key whatever conversation it names: the user stopped this
				// message before it started.
				if (existing.executionId === null) {
					return { outcome: "existing", turn: seen };
				}
				if ((existing.scopeConversationId ?? null) !== conversationId) {
					return { outcome: "key_reused", turn: seen };
				}
				return { outcome: "existing", turn: seen };
			}

			let generation: number | null = null;
			if (conversationId) {
				if (
					!(await conversationIsCallers(tx, {
						conversationId,
						userId: args.userId,
						organizationId: args.organizationId,
					}))
				) {
					return { outcome: "conversation_forbidden" };
				}
				const live = await tx.conversationTurn.findFirst({
					where: {
						conversationId,
						userId: args.userId,
						organizationId: args.organizationId,
						status: {
							in: [...CONVERSATION_TURN_NON_TERMINAL_STATUSES],
						},
					},
					orderBy: { createdAt: "desc" },
				});
				if (live) {
					return {
						outcome: "conflict",
						turn: withoutStartToken(live),
					};
				}
				const max = await tx.conversationTurn.aggregate({
					where: { conversationId },
					_max: { generation: true },
				});
				generation = (max._max.generation ?? 0) + 1;
			}

			const turn = await tx.conversationTurn.create({
				data: {
					userId: args.userId,
					organizationId: args.organizationId,
					conversationId,
					scopeConversationId: conversationId,
					clientRequestKey: args.clientRequestKey,
					executionId: args.executionId,
					generation,
					executionMode: args.executionMode,
					status: "START_PENDING",
					startToken: randomUUID(),
				},
			});
			return { outcome: "created", turn };
		},
		// Lookups and one insert take milliseconds; the budget is for waiting
		// on a concurrent admission of the same key or conversation.
		{ maxWait: 5_000, timeout: 10_000 },
	);
}

/**
 * START_PENDING -> ACTIVE, after the workflow start returned (or the
 * workflow's first dispatch check proved it running). False when the turn
 * already left START_PENDING — a cancel recorded meanwhile is never
 * overwritten.
 */
export async function markConversationTurnActive(args: {
	turnId: string;
	executionId: string;
}): Promise<boolean> {
	const { count } = await db.conversationTurn.updateMany({
		where: {
			id: args.turnId,
			executionId: args.executionId,
			status: "START_PENDING",
		},
		data: { status: "ACTIVE" },
	});
	return count === 1;
}

/**
 * The workflow start definitely failed: START_PENDING -> FAILED, or
 * CANCEL_REQUESTED -> CANCELLED when a cancel was recorded first. False when
 * the turn was already terminal (or ACTIVE: a running workflow proves the
 * start did not fail).
 */
export async function markConversationTurnStartFailed(args: {
	turnId: string;
	executionId: string;
	/** The start owner's token (from the `created` admission). */
	startToken: string;
	reason: string;
}): Promise<boolean> {
	return abandonConversationTurnStart({ ...args, cancelled: false });
}

/**
 * The start owner gives up on starting its turn: START_PENDING -> FAILED,
 * or -> CANCELLED (source DISCONNECT_BEFORE_START) when `cancelled` (its
 * client went away); a cancel the user recorded first (CANCEL_REQUESTED)
 * ends CANCELLED either way. Conditioned on the start token, so only the
 * request that created the turn can do it — a duplicate request for the
 * same key cannot end a turn another request is starting — and on the
 * status, so a turn already ACTIVE (its workflow is running) is never ended
 * here. False when nothing changed.
 */
export async function abandonConversationTurnStart(args: {
	turnId: string;
	executionId: string;
	startToken: string;
	cancelled: boolean;
	reason: string;
}): Promise<boolean> {
	if (!args.startToken) {
		return false;
	}
	const terminalAt = new Date();
	const owned = {
		id: args.turnId,
		executionId: args.executionId,
		startToken: args.startToken,
	};
	const abandoned = await db.conversationTurn.updateMany({
		where: { ...owned, status: "START_PENDING" },
		data: args.cancelled
			? {
					status: "CANCELLED",
					terminalAt,
					terminalReason: args.reason,
					cancelRequestedAt: terminalAt,
					cancelSource: "DISCONNECT_BEFORE_START",
				}
			: { status: "FAILED", terminalAt, terminalReason: args.reason },
	});
	if (abandoned.count === 1) {
		return true;
	}
	const cancelled = await db.conversationTurn.updateMany({
		where: { ...owned, status: "CANCEL_REQUESTED" },
		data: { status: "CANCELLED", terminalAt, terminalReason: args.reason },
	});
	return cancelled.count === 1;
}

/**
 * The turn as returned to anyone but its start owner: the start token is a
 * capability, never handed to a retry, a conflict or a cancel.
 */
function withoutStartToken(turn: ConversationTurn): ConversationTurn {
	return { ...turn, startToken: null };
}

// ============================================================================
// Cancellation
// ============================================================================

export interface RequestConversationTurnCancelInput {
	userId: string;
	organizationId: string;
	source: ConversationTurnCancelSource;
	requestedByUserId?: string;
	/** Cancel the turn with this execution id… */
	executionId?: string;
	/** …or the turn (or future turn) with this client key. */
	clientRequestKey?: string;
	/** For a key cancel: the conversation the client believes it is in. */
	conversationId?: string | null;
}

export type RequestConversationTurnCancelResult =
	/** CANCEL_REQUESTED was written now. Cancel `turn.executionId` in Temporal. */
	| { outcome: "recorded"; turn: ConversationTurn }
	/** A cancel was already recorded; the turn has not ended yet. */
	| { outcome: "already_requested"; turn: ConversationTurn }
	/** The turn had already ended (its status says how). Nothing changed. */
	| { outcome: "already_terminal"; turn: ConversationTurn }
	/** No turn had the key yet: a CANCELLED tombstone now refuses it. */
	| { outcome: "tombstoned"; turn: ConversationTurn }
	/** No turn with that execution id belongs to this user and organization. */
	| { outcome: "not_found" }
	/** The key's turn is in a different conversation than the one named. */
	| { outcome: "scope_mismatch" }
	/** A tombstone would name a conversation that is not the caller's. */
	| { outcome: "conversation_forbidden" };

async function applyCancel(
	client: Prisma.TransactionClient | typeof db,
	turn: ConversationTurn,
	args: RequestConversationTurnCancelInput,
): Promise<RequestConversationTurnCancelResult> {
	const { count } = await client.conversationTurn.updateMany({
		where: {
			id: turn.id,
			userId: args.userId,
			organizationId: args.organizationId,
			status: { in: ["START_PENDING", "ACTIVE"] },
		},
		data: {
			status: "CANCEL_REQUESTED",
			cancelRequestedAt: new Date(),
			cancelRequestedByUserId: args.requestedByUserId ?? args.userId,
			cancelSource: args.source,
		},
	});
	const current = withoutStartToken(
		await client.conversationTurn.findUniqueOrThrow({
			where: { id: turn.id },
		}),
	);
	if (count === 1) {
		return { outcome: "recorded", turn: current };
	}
	if (current.status === "CANCEL_REQUESTED") {
		return { outcome: "already_requested", turn: current };
	}
	return { outcome: "already_terminal", turn: current };
}

/**
 * Durably record that the user asked to stop a turn — BEFORE anyone asks
 * Temporal to cancel it, so a Temporal outage cannot lose the request:
 * every dispatch check that reads the record after this commits refuses.
 * A request whose check committed just before it may still start (one per
 * in-flight call); Temporal's cancel aborts that one (see turn-dispatch.ts
 * in @repo/temporal).
 *
 * By key, with no turn yet, it writes a tombstone so the creation that
 * arrives later is refused and starts nothing. Idempotent.
 */
export async function requestConversationTurnCancel(
	args: RequestConversationTurnCancelInput,
): Promise<RequestConversationTurnCancelResult> {
	if (!args.userId || !args.organizationId) {
		throw new Error(
			"requestConversationTurnCancel requires userId and organizationId",
		);
	}

	if (args.executionId) {
		const turn = await db.conversationTurn.findFirst({
			where: {
				executionId: args.executionId,
				userId: args.userId,
				organizationId: args.organizationId,
			},
		});
		if (!turn) {
			return { outcome: "not_found" };
		}
		return applyCancel(db, turn, args);
	}

	const clientRequestKey = args.clientRequestKey;
	if (!clientRequestKey) {
		throw new Error(
			"requestConversationTurnCancel requires an executionId or a clientRequestKey",
		);
	}
	const conversationId = args.conversationId || null;

	return db.$transaction(
		async (tx) => {
			await lockClientKey(tx, {
				userId: args.userId,
				organizationId: args.organizationId,
				clientRequestKey,
			});
			const existing = await tx.conversationTurn.findUnique({
				where: {
					userId_organizationId_clientRequestKey: {
						userId: args.userId,
						organizationId: args.organizationId,
						clientRequestKey,
					},
				},
			});
			if (existing) {
				if (
					conversationId &&
					(existing.scopeConversationId ?? null) !== conversationId
				) {
					return { outcome: "scope_mismatch" };
				}
				return applyCancel(tx, existing, args);
			}

			if (
				conversationId &&
				!(await conversationIsCallers(tx, {
					conversationId,
					userId: args.userId,
					organizationId: args.organizationId,
				}))
			) {
				return { outcome: "conversation_forbidden" };
			}
			const now = new Date();
			const tombstone = await tx.conversationTurn.create({
				data: {
					userId: args.userId,
					organizationId: args.organizationId,
					conversationId,
					scopeConversationId: conversationId,
					clientRequestKey,
					executionId: null,
					generation: null,
					status: "CANCELLED",
					cancelRequestedAt: now,
					cancelRequestedByUserId:
						args.requestedByUserId ?? args.userId,
					cancelSource: "CANCELLED_BEFORE_START",
					terminalAt: now,
					terminalReason: "cancelled before start",
				},
			});
			return {
				outcome: "tombstoned",
				turn: withoutStartToken(tombstone),
			};
		},
		{ maxWait: 5_000, timeout: 10_000 },
	);
}

// ============================================================================
// Terminal state
// ============================================================================

export interface FinalizeConversationTurnInput {
	turnId: string;
	executionId: string;
	userId: string;
	organizationId: string;
	/** How the run itself ended. A recorded cancel overrides it. */
	outcome: ConversationTurnTerminalStatus;
	terminalReason?: string;
	/** The answer, or the partial text a cancelled run produced. */
	responseText?: string | null;
	limitSignalSummary?: Prisma.InputJsonValue;
}

export type FinalizeConversationTurnResult =
	| { outcome: "finalized"; status: ConversationTurnTerminalStatus }
	| { outcome: "already_terminal"; status: ConversationTurnStatus }
	| { outcome: "not_found" };

/**
 * Write a turn's terminal state. Ordering rule: if a cancel was recorded
 * before this write, the turn ends CANCELLED (keeping `responseText` as its
 * partial result); otherwise the first terminal write wins and later ones
 * change nothing.
 */
export async function finalizeConversationTurn(
	args: FinalizeConversationTurnInput,
): Promise<FinalizeConversationTurnResult> {
	const where = {
		id: args.turnId,
		executionId: args.executionId,
		userId: args.userId,
		organizationId: args.organizationId,
	};
	const shared = {
		terminalReason: args.terminalReason ?? null,
		responseText: args.responseText ?? null,
		...(args.limitSignalSummary !== undefined
			? { limitSignalSummary: args.limitSignalSummary }
			: {}),
	};

	// Two passes at most: a cancel recorded between the two UPDATEs below
	// makes the second match nothing, and the re-read sends it back to the
	// first.
	for (let pass = 0; pass < 2; pass++) {
		const terminalAt = new Date();
		const cancelled = await db.conversationTurn.updateMany({
			where: { ...where, status: "CANCEL_REQUESTED" },
			data: {
				...shared,
				status: "CANCELLED",
				terminalAt,
				terminalReason: args.terminalReason ?? "cancelled",
			},
		});
		if (cancelled.count === 1) {
			return { outcome: "finalized", status: "CANCELLED" };
		}

		const ended = await db.conversationTurn.updateMany({
			where: { ...where, status: { in: ["START_PENDING", "ACTIVE"] } },
			data: {
				...shared,
				status: args.outcome,
				terminalAt,
				// A native Temporal cancel nobody recorded first still ends
				// the turn as a cancellation, attributed to the workflow.
				...(args.outcome === "CANCELLED"
					? {
							cancelRequestedAt: terminalAt,
							cancelSource: "WORKFLOW_CANCELLED" as const,
						}
					: {}),
			},
		});
		if (ended.count === 1) {
			return { outcome: "finalized", status: args.outcome };
		}

		const row = await db.conversationTurn.findFirst({
			where,
			select: { status: true },
		});
		if (!row) {
			return { outcome: "not_found" };
		}
		if (row.status !== "CANCEL_REQUESTED") {
			return { outcome: "already_terminal", status: row.status };
		}
	}
	// Unreachable in practice: CANCEL_REQUESTED only ever moves to CANCELLED.
	const row = await db.conversationTurn.findFirst({
		where,
		select: { status: true },
	});
	return row
		? { outcome: "already_terminal", status: row.status }
		: { outcome: "not_found" };
}

/**
 * Terminalize a turn whose workflow Temporal reported missing — but only if
 * the turn is still exactly as the caller observed it (status and
 * `updatedAt`). A starter that promoted the turn to ACTIVE (or anyone who
 * otherwise changed it) after that observation makes this a no-op
 * ("changed"): a NotFound read before the start must never end a turn whose
 * workflow is now running. An observed CANCEL_REQUESTED ends CANCELLED;
 * START_PENDING or ACTIVE ends FAILED.
 */
export async function finalizeOrphanedConversationTurn(args: {
	turnId: string;
	executionId: string;
	userId: string;
	organizationId: string;
	observedStatus: ConversationTurnStatus;
	observedUpdatedAt: Date;
	terminalReason: string;
}): Promise<
	| { outcome: "finalized"; status: "FAILED" | "CANCELLED" }
	| { outcome: "changed" }
> {
	if (isTerminalConversationTurnStatus(args.observedStatus)) {
		return { outcome: "changed" };
	}
	const status =
		args.observedStatus === "CANCEL_REQUESTED" ? "CANCELLED" : "FAILED";
	const { count } = await db.conversationTurn.updateMany({
		where: {
			id: args.turnId,
			executionId: args.executionId,
			userId: args.userId,
			organizationId: args.organizationId,
			status: args.observedStatus,
			updatedAt: args.observedUpdatedAt,
		},
		data: {
			status,
			terminalAt: new Date(),
			terminalReason: args.terminalReason,
		},
	});
	return count === 1
		? { outcome: "finalized", status }
		: { outcome: "changed" };
}

// ============================================================================
// Dispatch check
// ============================================================================

export interface ConversationTurnScope {
	turnId: string;
	executionId: string;
	userId: string;
	organizationId: string;
}

export type ConversationTurnDispatchVerdict =
	| { ok: true }
	| { ok: false; reason: "cancelled" | "scope_mismatch" | "terminal" };

/**
 * May this turn make another model request? Read immediately before each
 * one. The turn must exist, match the execution, user and organization the
 * workflow carries, and be ACTIVE. A plain read, not a lock held across the
 * request: a cancel that commits after this read does not stop the request
 * it approved (Temporal's cancel aborts that one).
 *
 * A START_PENDING turn is promoted to ACTIVE here: the workflow asking is
 * proof its start succeeded, and the starter's own ACTIVE write can land
 * after the workflow's first request.
 */
export async function checkConversationTurnDispatchable(
	scope: ConversationTurnScope,
): Promise<ConversationTurnDispatchVerdict> {
	for (let pass = 0; pass < 2; pass++) {
		const turn = await db.conversationTurn.findUnique({
			where: { id: scope.turnId },
			select: {
				executionId: true,
				userId: true,
				organizationId: true,
				status: true,
			},
		});
		if (
			!turn ||
			turn.executionId !== scope.executionId ||
			turn.userId !== scope.userId ||
			turn.organizationId !== scope.organizationId
		) {
			return { ok: false, reason: "scope_mismatch" };
		}
		switch (turn.status) {
			case "ACTIVE":
				return { ok: true };
			case "CANCEL_REQUESTED":
			case "CANCELLED":
				return { ok: false, reason: "cancelled" };
			case "COMPLETED":
			case "FAILED":
			case "LIMITED":
				return { ok: false, reason: "terminal" };
			case "START_PENDING": {
				if (
					await markConversationTurnActive({
						turnId: scope.turnId,
						executionId: scope.executionId,
					})
				) {
					return { ok: true };
				}
				// Lost a race (a cancel, or the starter's own promotion):
				// re-read and judge the new status.
				continue;
			}
		}
	}
	return { ok: false, reason: "cancelled" };
}

// ============================================================================
// Reads
// ============================================================================

/** The caller's turn for an execution id, or null. */
export async function getConversationTurnForExecution(args: {
	executionId: string;
	userId: string;
	organizationId: string;
}): Promise<ConversationTurn | null> {
	return db.conversationTurn.findFirst({
		where: {
			executionId: args.executionId,
			userId: args.userId,
			organizationId: args.organizationId,
		},
	});
}

/** Any turn for an execution id, for owner checks that must fail closed. */
export async function getConversationTurnOwnerForExecution(
	executionId: string,
): Promise<{ userId: string; organizationId: string } | null> {
	return db.conversationTurn.findUnique({
		where: { executionId },
		select: { userId: true, organizationId: true },
	});
}
