/**
 * Conversation turn token ledger — the durable, authoritative per-turn token
 * allowance of an Advisor chat turn.
 *
 * A turn admitted with a budget contract (`budgetContractVersion`) carries a
 * frozen `tokenAllowance`, of which `finalizationReserveTokens` is held back
 * for the turn's finalization request. Every physical model or embedding
 * request the turn makes is one `ConversationTurnAttempt`:
 *
 *   reserve  (before the request is sent)  RESERVED, outstanding += reserved
 *   settle   (complete usage reported)     SETTLED,  measured += actual,
 *                                                     outstanding -= reserved
 *   unknown  (usage incomplete or missing) UNKNOWN,  reservation stays in
 *                                                     outstanding (final)
 *   release  (positively never sent)       RELEASED, outstanding -= reserved
 *
 * A row left RESERVED (a dead activity, an abandoned stream, a settlement
 * still in flight or one whose write failed) stays charged exactly like
 * UNKNOWN. Only one writer — the request's own middleware — ever moves an
 * attempt out of RESERVED, with one transition call; nothing ever moves it
 * out of SETTLED, UNKNOWN or RELEASED, and a second transition on the same
 * attempt changes nothing. A settlement with complete usage is correct
 * accounting whenever it commits, so none is refused for being late.
 *
 * Locking: every transition runs in one transaction that locks the turn row
 * (`SELECT … FOR UPDATE`) and then, for a settlement, the attempt row — one
 * lock order everywhere, so two transitions never wait on each other in
 * opposite orders. Cancellation (`requestConversationTurnCancel`) updates the
 * same turn row, so a reservation and a cancel serialize on it: the commit of
 * the reservation is the admission point. A cancel committed first denies the
 * reservation; a reservation committed first stays charged even if the
 * request it admitted is then aborted.
 *
 * Authorization: the API and the worker use the base `db`, which bypasses
 * RLS, so every operation checks the caller's scope (turn id, execution id,
 * user, organization, and for a reservation the generation) against the
 * parent turn row. An attempt's tenant columns are copied from that row on
 * insert, never from the caller, and a settlement must name the attempt's own
 * turn.
 */

import { chargedConversationInputTokens } from "@repo/utils/conversation-turn-charge";

import { db } from "../client";
import type {
	ConversationTurnAttemptKind,
	ConversationTurnBudgetEnforcement,
	ConversationTurnStatus,
	Prisma,
} from "../generated/client";
import {
	type ConversationTurnScope,
	conversationTurnGenerationMatches,
} from "./conversation-turns";
import { planConversationTurnReservation } from "./lib/conversation-turn-room";

/** The budget contract version this module implements. */
export const CONVERSATION_TURN_BUDGET_CONTRACT_VERSION = 1;

export type { ConversationTurnAttemptKind, ConversationTurnBudgetEnforcement };

/** The ledger's totals, converted to numbers for JSON boundaries. */
export interface ConversationTurnLedgerSnapshot {
	contractVersion: number;
	allowance: number;
	finalizationReserve: number;
	/** Settled usage. */
	measured: number;
	/** Unsettled reservations plus UNKNOWN conservative charges. */
	outstanding: number;
	/** Null until the first attempt. */
	enforcement: ConversationTurnBudgetEnforcement | null;
}

export interface ReserveConversationTurnAttemptInput {
	scope: ConversationTurnScope;
	kind: ConversationTurnAttemptKind;
	/** Estimated input tokens of the request (never a measured value). */
	inputEstimate: number;
	/**
	 * Output tokens the request asks for. Zero for an embedding. For an
	 * enforced model the reservation may lower it to fit the room left.
	 */
	requestedOutputTokens: number;
	/**
	 * The smallest output cap worth sending. A request that cannot get at
	 * least this much output room is refused. Zero for an embedding.
	 */
	minOutputTokens: number;
	/** False for a model that cannot honour an output cap (MEASURED_ONLY). */
	enforced: boolean;
	/** Diagnostic only. */
	attribution?: {
		workflowId?: string;
		runId?: string;
		activityId?: string;
		activityAttempt?: number;
		modelId?: string;
	};
}

export type ReserveConversationTurnAttemptResult =
	/** The turn has no ledger: send the request without a reservation. */
	| { outcome: "unledgered" }
	| {
			outcome: "reserved";
			attemptId: string;
			reservedTokens: number;
			/**
			 * The output cap the request must be sent with (enforced models),
			 * or null when the model cannot be capped.
			 */
			outputCap: number | null;
	  }
	/** The turn may not make another request (the dispatch-check reasons). */
	| {
			outcome: "denied";
			reason: "cancelled" | "scope_mismatch" | "terminal";
	  }
	/** The request does not fit what is left of the allowance. */
	| {
			outcome: "exhausted";
			snapshot: ConversationTurnLedgerSnapshot;
			/** Tokens left for this kind of request before it. */
			room: number;
			/** Tokens the smallest acceptable request would need. */
			needed: number;
	  };

interface LockedTurnRow {
	id: string;
	executionId: string | null;
	userId: string;
	organizationId: string;
	generation: number | null;
	status: ConversationTurnStatus;
	budgetContractVersion: number | null;
	tokenAllowance: number | null;
	finalizationReserveTokens: number | null;
	measuredTokens: bigint;
	outstandingTokens: bigint;
	budgetEnforcement: ConversationTurnBudgetEnforcement | null;
}

async function lockTurn(
	tx: Prisma.TransactionClient,
	turnId: string,
): Promise<LockedTurnRow | null> {
	const rows = await tx.$queryRaw<LockedTurnRow[]>`
		SELECT "id", "executionId", "userId", "organizationId", "generation",
		       "status", "budgetContractVersion", "tokenAllowance",
		       "finalizationReserveTokens", "measuredTokens", "outstandingTokens",
		       "budgetEnforcement"
		FROM "conversation_turn"
		WHERE "id" = ${turnId}
		FOR UPDATE`;
	return rows[0] ?? null;
}

/** Turn id, execution, user and organization all match the scope. */
function identityMatches(
	row: LockedTurnRow,
	scope: ConversationTurnScope,
): boolean {
	return (
		row.executionId === scope.executionId &&
		row.userId === scope.userId &&
		row.organizationId === scope.organizationId
	);
}

function isLedgered(row: LockedTurnRow): boolean {
	return (
		row.budgetContractVersion ===
			CONVERSATION_TURN_BUDGET_CONTRACT_VERSION &&
		row.tokenAllowance !== null &&
		row.finalizationReserveTokens !== null
	);
}

function snapshotOf(row: LockedTurnRow): ConversationTurnLedgerSnapshot {
	return {
		contractVersion: row.budgetContractVersion ?? 0,
		allowance: row.tokenAllowance ?? 0,
		finalizationReserve: row.finalizationReserveTokens ?? 0,
		measured: Number(row.measuredTokens),
		outstanding: Number(row.outstandingTokens),
		enforcement: row.budgetEnforcement,
	};
}

function nonNegativeInt(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

/**
 * Reserve one physical request against the turn's allowance, immediately
 * before it is sent. Runs the same status rules as the dispatch check
 * (`checkConversationTurnDispatchable`), including its START_PENDING ->
 * ACTIVE promotion, under the turn row's lock, then the admission
 * arithmetic of `planConversationTurnReservation` (lib/conversation-turn-room.ts):
 *
 *   room = allowance − measured − outstanding
 *          − finalizationReserve (unless the attempt is FINALIZATION)
 *
 * An enforced model's output cap is `min(requested, room − inputEstimate)`;
 * below `minOutputTokens` the request is refused. A model that cannot be
 * capped reserves `inputEstimate + requested` (documented as a reservation,
 * not a bound) and is still refused once less than `minOutputTokens` of room
 * is left after its input; its attempt is `enforced = false` and the turn
 * becomes MEASURED_ONLY.
 */
export async function reserveConversationTurnAttempt(
	input: ReserveConversationTurnAttemptInput,
): Promise<ReserveConversationTurnAttemptResult> {
	const { scope } = input;
	const inputEstimate = nonNegativeInt(input.inputEstimate);
	const requested = nonNegativeInt(input.requestedOutputTokens);
	const minOutput = nonNegativeInt(input.minOutputTokens);

	return db.$transaction(
		async (tx) => {
			const row = await lockTurn(tx, scope.turnId);
			if (
				!row ||
				!identityMatches(row, scope) ||
				!conversationTurnGenerationMatches(scope, row.generation)
			) {
				return { outcome: "denied", reason: "scope_mismatch" };
			}
			const ledgered = isLedgered(row);
			// A ledgered turn that has a generation must be reserved for by a
			// scope carrying that same generation: one that carries none is
			// not trusted with it.
			if (
				ledgered &&
				row.generation !== null &&
				scope.generation !== row.generation
			) {
				return { outcome: "denied", reason: "scope_mismatch" };
			}
			switch (row.status) {
				case "CANCEL_REQUESTED":
				case "CANCELLED":
					return { outcome: "denied", reason: "cancelled" };
				case "COMPLETED":
				case "FAILED":
				case "LIMITED":
					return { outcome: "denied", reason: "terminal" };
				case "START_PENDING":
					// The workflow asking is proof its start succeeded (the
					// same promotion the dispatch check makes); the row lock
					// orders it against a cancel.
					await tx.conversationTurn.update({
						where: { id: row.id },
						data: { status: "ACTIVE" },
					});
					break;
				case "ACTIVE":
					break;
			}
			if (!ledgered) {
				return { outcome: "unledgered" };
			}

			const snapshot = snapshotOf(row);
			const plan = planConversationTurnReservation({
				totals: snapshot,
				kind: input.kind,
				inputEstimate,
				requestedOutputTokens: requested,
				minOutputTokens: minOutput,
				enforced: input.enforced,
			});
			if (plan.outcome === "exhausted") {
				return {
					outcome: "exhausted",
					snapshot,
					room: plan.room,
					needed: plan.needed,
				};
			}
			const { outputCap, reservedTokens } = plan;

			const attempt = await tx.conversationTurnAttempt.create({
				data: {
					turnId: row.id,
					// Bound to the parent turn, never to the caller.
					organizationId: row.organizationId,
					userId: row.userId,
					generation: row.generation,
					kind: input.kind,
					enforced: input.enforced,
					reservedTokens,
					status: "RESERVED",
					workflowId: input.attribution?.workflowId,
					runId: input.attribution?.runId,
					activityId: input.attribution?.activityId,
					activityAttempt: input.attribution?.activityAttempt,
					modelId: input.attribution?.modelId?.slice(0, 200),
				},
				select: { id: true },
			});
			await tx.conversationTurn.update({
				where: { id: row.id },
				data: {
					outstandingTokens: { increment: BigInt(reservedTokens) },
					...(input.enforced
						? row.budgetEnforcement === null
							? { budgetEnforcement: "ENFORCED" }
							: {}
						: { budgetEnforcement: "MEASURED_ONLY" }),
				},
			});
			return {
				outcome: "reserved",
				attemptId: attempt.id,
				reservedTokens,
				outputCap,
			};
		},
		// One row lock, one insert and one update; the budget is for waiting
		// on a concurrent reservation or cancel of the same turn.
		{ maxWait: 5_000, timeout: 10_000 },
	);
}

export type ConversationTurnAttemptSettlement =
	/** Complete, authoritative usage: reconcile to it. */
	| {
			status: "SETTLED";
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens?: number | null;
	  }
	/** Sent, or possibly sent, with no complete usage: keep the charge. */
	| { status: "UNKNOWN" }
	/** Positively never sent: refund the reservation. */
	| { status: "RELEASED" };

export type SettleConversationTurnAttemptResult =
	| { outcome: "settled"; status: "SETTLED" | "UNKNOWN" | "RELEASED" }
	/** The attempt had already left RESERVED; nothing changed. */
	| { outcome: "already_settled"; status: string }
	| { outcome: "not_found" };

/**
 * Move one RESERVED attempt to its final state. Accepted whatever the turn's
 * status or generation has become since the reservation — a cancelled,
 * terminal or superseded turn is still billed for what it sent — and however
 * long after the request it arrives, but only for the attempt's own turn,
 * with the scope's identity matching that turn. Atomic (the attempt row and
 * the turn's totals move in one transaction) and idempotent: an attempt that
 * already left RESERVED is left as it is.
 */
export async function settleConversationTurnAttempt(args: {
	scope: ConversationTurnScope;
	attemptId: string;
	settlement: ConversationTurnAttemptSettlement;
}): Promise<SettleConversationTurnAttemptResult> {
	const { scope } = args;
	return db.$transaction(
		async (tx) => {
			const row = await lockTurn(tx, scope.turnId);
			if (!row || !identityMatches(row, scope)) {
				return { outcome: "not_found" };
			}
			const attempts = await tx.$queryRaw<
				Array<{ id: string; status: string; reservedTokens: number }>
			>`
				SELECT "id", "status", "reservedTokens"
				FROM "conversation_turn_attempt"
				WHERE "id" = ${args.attemptId} AND "turnId" = ${row.id}
				FOR UPDATE`;
			const attempt = attempts[0];
			if (!attempt) {
				return { outcome: "not_found" };
			}
			if (attempt.status !== "RESERVED") {
				return { outcome: "already_settled", status: attempt.status };
			}
			const settledAt = new Date();
			const { settlement } = args;
			const reserved = BigInt(attempt.reservedTokens);
			if (settlement.status === "SETTLED") {
				const inputTokens = nonNegativeInt(settlement.inputTokens);
				const outputTokens = nonNegativeInt(settlement.outputTokens);
				const cacheReadTokens =
					settlement.cacheReadTokens == null
						? null
						: nonNegativeInt(settlement.cacheReadTokens);
				await tx.conversationTurnAttempt.update({
					where: { id: attempt.id },
					data: {
						status: "SETTLED",
						inputTokens,
						cacheReadTokens,
						outputTokens,
						settledAt,
					},
				});
				await tx.conversationTurn.update({
					where: { id: row.id },
					data: {
						measuredTokens: {
							increment: BigInt(
								chargedConversationInputTokens(
									inputTokens,
									cacheReadTokens,
								) + outputTokens,
							),
						},
						outstandingTokens: { decrement: reserved },
					},
				});
			} else if (settlement.status === "RELEASED") {
				await tx.conversationTurnAttempt.update({
					where: { id: attempt.id },
					data: { status: "RELEASED", settledAt },
				});
				await tx.conversationTurn.update({
					where: { id: row.id },
					data: { outstandingTokens: { decrement: reserved } },
				});
			} else {
				// UNKNOWN: the reservation stays in `outstandingTokens`.
				await tx.conversationTurnAttempt.update({
					where: { id: attempt.id },
					data: { status: "UNKNOWN", settledAt },
				});
			}
			return { outcome: "settled", status: settlement.status };
		},
		{ maxWait: 5_000, timeout: 10_000 },
	);
}

/**
 * The ledger's totals for the caller's turn, or null when the scope does not
 * match the turn or the turn has no ledger.
 */
export async function getConversationTurnLedgerSnapshot(
	scope: ConversationTurnScope,
): Promise<ConversationTurnLedgerSnapshot | null> {
	const row = await db.conversationTurn.findFirst({
		where: {
			id: scope.turnId,
			executionId: scope.executionId,
			userId: scope.userId,
			organizationId: scope.organizationId,
		},
		select: {
			id: true,
			executionId: true,
			userId: true,
			organizationId: true,
			generation: true,
			status: true,
			budgetContractVersion: true,
			tokenAllowance: true,
			finalizationReserveTokens: true,
			measuredTokens: true,
			outstandingTokens: true,
			budgetEnforcement: true,
		},
	});
	if (!row || !isLedgered(row)) {
		return null;
	}
	return snapshotOf(row);
}
