/**
 * Member proposal branches: classification, settlement, confirmations, the
 * rehome refusal and the branch's merge sync, on the database side (Fizzy
 * #2738 spec §4.3 "Classification", "Branch settled", "Rehome"; §4.4
 * "Settled"; §6.6; §6.7; Decisions 11, 14).
 *
 * Lock order (spec §4.7): every writer here that touches more than the
 * branch row locks the branch first, then its proposals by id, through
 * `withBranchLockOrder`, and runs `transitionPullRequest` only after both
 * are held. The pure planners (`planBranchClassification`,
 * `planBranchCancellation`) decide; the writers apply what they decide.
 */
import { db, Prisma } from "../client";
import type {
	ProjectInstructionProposalBranch,
	ProjectInstructionPullRequestState,
} from "../generated/client";
import { type RecordAuditInput, recordAuditTx } from "./audit-log";
import {
	currentAppend,
	currentWithdrawal,
	type EvidenceOp,
	isEstablished,
	type OpOutcome,
} from "./instruction-proposal-branch-evidence";
import {
	type BranchMembership,
	type BranchPullRequestObservation,
	branchObservationJson,
	isLegalBranchMove,
	membershipStatusOf,
	parseBranchDestination,
	rehomableProposals,
	transitionBranch,
	withBranchLockOrder,
} from "./instruction-proposal-branches";
import {
	establishedCurrentRevertSql,
	type MergeSyncTuple,
	type PullRequestFailure,
	transitionPullRequest,
} from "./instruction-proposal-pull-requests";

type BranchRow = ProjectInstructionProposalBranch;
type ProposalState = ProjectInstructionPullRequestState;

const HOUR_MS = 60 * 60 * 1000;
const RECONCILED = "project.instructions.pull_request_reconciled";

const asInputJson = (value: unknown) =>
	value as unknown as Prisma.InputJsonValue;

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
	const [row] = await tx.$queryRaw<
		Array<{ now: Date }>
	>`SELECT (now() AT TIME ZONE 'UTC') AS "now"`;
	return row?.now ?? new Date();
}

function branchResource(branch: Pick<BranchRow, "id" | "number">) {
	return {
		type: "project_instruction_proposal_branch",
		id: branch.id,
		name: `#${branch.number}`,
	};
}

function readBranch(
	tx: Prisma.TransactionClient,
	branchId: string,
	organizationId: string,
): Promise<BranchRow | null> {
	return tx.projectInstructionProposalBranch.findFirst({
		where: { id: branchId, organizationId },
	});
}

/** A proposal on the branch as the settlement writers lock and read it. */
type LockedBranchProposal = {
	id: string;
	version: number;
	projectId: string;
	state: ProposalState;
	attempt: number;
	assignment: number;
	sequence: number | null;
	pullRequestOperationId: string | null;
	withdrawRequestedAt: Date | null;
	status: string;
	proposalStatus: string | null;
	failure: unknown;
	nextAttemptAt: Date | null;
};

/**
 * Every non-terminal proposal on the branch, locked by id (§4.7 step 3).
 * With `revertCanceled` (classification only), also every CANCELED proposal
 * on the branch whose current withdrawal is an established revert
 * (`establishedCurrentRevertSql`), in the same id-ordered lock: the only
 * terminal proposals classification may move (spec Decision 14).
 */
async function lockBranchProposals(
	tx: Prisma.TransactionClient,
	branchId: string,
	organizationId: string,
	options: { revertCanceled?: true } = {},
): Promise<LockedBranchProposal[]> {
	const states =
		options.revertCanceled === true
			? Prisma.sql`(s."pullRequestState" IN ('QUEUED', 'OPENING', 'OPEN', 'CLOSE_REQUESTED', 'BLOCKED')
				OR (s."pullRequestState" = 'CANCELED' AND ${establishedCurrentRevertSql()}))`
			: Prisma.sql`s."pullRequestState" IN ('QUEUED', 'OPENING', 'OPEN', 'CLOSE_REQUESTED', 'BLOCKED')`;
	const rows = await tx.$queryRaw<
		Array<{
			id: string;
			version: number;
			projectId: string;
			state: ProposalState;
			attempt: number;
			assignment: number;
			sequence: number | null;
			pullRequestOperationId: string | null;
			withdrawRequestedAt: Date | null;
			status: string;
			proposalStatus: string | null;
			failure: unknown;
			nextAttemptAt: Date | null;
		}>
	>`
		SELECT s."id", s."version", s."projectId", s."pullRequestState"::text AS "state",
			s."pullRequestAttempt" AS "attempt", s."proposalAssignment" AS "assignment",
			s."proposalBranchSequence" AS "sequence", s."pullRequestOperationId",
			s."withdrawRequestedAt", s."status"::text AS "status",
			s."proposalStatus"::text AS "proposalStatus",
			s."pullRequestFailure" AS "failure",
			s."pullRequestNextAttemptAt" AS "nextAttemptAt"
		FROM "project_instruction_snapshot" s
		WHERE s."proposalBranchId" = ${branchId} AND s."organizationId" = ${organizationId}
			AND ${states}
		ORDER BY s."id" FOR UPDATE`;
	return rows.map((r) => ({
		...r,
		attempt: Number(r.attempt),
		assignment: Number(r.assignment),
		sequence: r.sequence === null ? null : Number(r.sequence),
		version: Number(r.version),
	}));
}

/** The branch's journal with each operation's membership (spec §4.1). */
export type ClassificationOp = EvidenceOp & {
	snapshotId: string;
	membership: string | null;
};

async function readClassificationOps(
	tx: Prisma.TransactionClient,
	branchId: string,
	organizationId: string,
): Promise<ClassificationOp[]> {
	const ops = await tx.projectInstructionProposalBranchOperation.findMany({
		where: { organizationId, branchId },
		select: {
			id: true,
			snapshotId: true,
			kind: true,
			executionSeq: true,
			assignment: true,
			branchId: true,
			outcome: true,
			membership: true,
		},
	});
	return ops.map((op) => ({ ...op, outcome: op.outcome as OpOutcome }));
}

// ---------------------------------------------------------------------------
// Classification (spec §6.6, Decision 14)
// ---------------------------------------------------------------------------

/**
 * What classification reads of one proposal on the branch: a non-terminal
 * one, or a CANCELED one whose current withdrawal is an established revert.
 */
export type ClassificationProposal = {
	snapshotId: string;
	state: ProposalState;
	assignment: number;
	withdrawRequestedAt: Date | null;
};

/**
 * One proposal's classified outcome:
 * - `outcome`: its append was included; it takes the pull request's outcome;
 * - `unverified`: its append was not proved included (or its current append
 *   or withdrawal is `unknown`, §4.3 "Terminal branch, unresolved push"); it
 *   takes the pull request's outcome and its card offers Propose again;
 * - `reverted`: its append and its revert were both included: CANCELED;
 * - `withdrawn`: it was never appended here and its submission intent was
 *   withdrawn (a Close): CANCELED.
 *
 * A proposal already CANCELED by its established revert moves only with
 * `outcome` (its append included, its revert decided not included).
 */
export type ClassificationMove = {
	snapshotId: string;
	to: "MERGED" | "CLOSED" | "CANCELED";
	reason: "outcome" | "unverified" | "reverted" | "withdrawn";
};

/**
 * Spec §6.6 step 3 and Decision 14, for every non-terminal proposal on a
 * branch whose pull request ended `outcome`. Only the proposal's current
 * submission (its current `proposalAssignment` on this branch) decides; a
 * proposal never appended here and still holding its intent is left for
 * rehome; one with an operation still issued (no outcome) is left for
 * recovery, which the loop runs first.
 *
 * A merge racing the revert is decided here too (Decision 14, spec §4.3): a
 * proposal CANCELED because its current withdrawal is an established revert
 * takes `outcome` when its established append is `included` and its revert
 * is `unverified` (the pull request merged or closed before the revert
 * reached it). With both included it stays CANCELED; with its append not
 * included, or either membership undecided, it is left alone, as it was
 * before this branch settled. Any other CANCELED proposal, and every MERGED
 * or CLOSED one, is never moved.
 */
export function planBranchClassification(i: {
	branchId: string;
	outcome: "MERGED" | "CLOSED";
	ops: readonly ClassificationOp[];
	proposals: readonly ClassificationProposal[];
}): ClassificationMove[] {
	const moves: ClassificationMove[] = [];
	for (const p of i.proposals) {
		const own = i.ops.filter(
			(op) =>
				op.snapshotId === p.snapshotId && op.branchId === i.branchId,
		);
		const s = { branchId: i.branchId, assignment: p.assignment };
		const append = currentAppend(own, s);
		const withdrawal = currentWithdrawal(own, s);
		if (p.state === "CANCELED") {
			if (
				append !== null &&
				isEstablished(append) &&
				(append as ClassificationOp).membership === "included" &&
				withdrawal !== null &&
				isEstablished(withdrawal) &&
				(withdrawal as ClassificationOp).membership === "unverified"
			) {
				moves.push({
					snapshotId: p.snapshotId,
					to: i.outcome,
					reason: "outcome",
				});
			}
			continue;
		}
		if (p.state === "MERGED" || p.state === "CLOSED") {
			continue;
		}
		if (append === null) {
			if (p.withdrawRequestedAt !== null) {
				moves.push({
					snapshotId: p.snapshotId,
					to: "CANCELED",
					reason: "withdrawn",
				});
			}
			continue;
		}
		if (append.outcome === null || withdrawal?.outcome === null) {
			continue;
		}
		if (append.outcome === "unknown" || withdrawal?.outcome === "unknown") {
			moves.push({
				snapshotId: p.snapshotId,
				to: i.outcome,
				reason: "unverified",
			});
			continue;
		}
		const appendIncluded =
			(append as ClassificationOp).membership === "included";
		if (
			withdrawal !== null &&
			isEstablished(withdrawal) &&
			appendIncluded &&
			(withdrawal as ClassificationOp).membership === "included"
		) {
			moves.push({
				snapshotId: p.snapshotId,
				to: "CANCELED",
				reason: "reverted",
			});
			continue;
		}
		moves.push({
			snapshotId: p.snapshotId,
			to: i.outcome,
			reason: appendIncluded ? "outcome" : "unverified",
		});
	}
	return moves;
}

/** Whether the branch's merge sync was ever requested (spec §6.6: once per branch). */
function mergeSyncEverRequested(b: BranchRow): boolean {
	const failurePhase =
		b.failure !== null && typeof b.failure === "object"
			? (b.failure as { phase?: unknown }).phase
			: undefined;
	return (
		b.mergeSyncRequestedAt !== null ||
		b.mergeSyncDispatchedAt !== null ||
		b.mergeSyncRunId !== null ||
		b.mergeSyncExpected !== null ||
		failurePhase === "merge_sync"
	);
}

function targetMismatchOf(observation: unknown): boolean {
	return (
		observation !== null &&
		typeof observation === "object" &&
		(observation as { targetMismatch?: unknown }).targetMismatch === true
	);
}

function reconciledProposalAudit(
	p: LockedBranchProposal,
	organizationId: string,
	branchId: string,
	move: ClassificationMove,
	targetMismatch: boolean,
): RecordAuditInput {
	return {
		action: RECONCILED,
		category: "project",
		actor: { type: "system" },
		organizationId,
		projectId: p.projectId,
		resource: {
			type: "project_instruction_snapshot",
			id: p.id,
			name: `v${p.version}`,
		},
		metadata: {
			outcome:
				move.to === "MERGED"
					? "merged"
					: move.to === "CLOSED"
						? "closed"
						: "canceled",
			operationId: p.pullRequestOperationId,
			branchId,
			reason: move.reason,
			targetMismatch,
		},
	};
}

/** Applies planned moves to locked proposals, each fenced on its attempt and assignment. */
async function applyMoves(
	tx: Prisma.TransactionClient,
	i: {
		branchId: string;
		organizationId: string;
		moves: readonly ClassificationMove[];
		proposals: readonly LockedBranchProposal[];
		targetMismatch: boolean;
	},
): Promise<number> {
	let moved = 0;
	for (const move of i.moves) {
		const p = i.proposals.find((row) => row.id === move.snapshotId);
		if (!p) {
			continue;
		}
		const result = await transitionPullRequest(
			{
				snapshotId: p.id,
				organizationId: i.organizationId,
				event: "branch_settled",
				from: [p.state],
				expectedAttempt: p.attempt,
				to: move.to,
				bumpAttempt: true,
				branch: { id: i.branchId, assignment: p.assignment },
				data: {
					pullRequestFailure: null,
					pullRequestNextAttemptAt: null,
					pendingCommand: null,
					pendingCommandSeq: null,
				},
				audit: reconciledProposalAudit(
					p,
					i.organizationId,
					i.branchId,
					move,
					i.targetMismatch,
				),
			},
			tx,
		);
		if (!result.ok) {
			throw new Error("A locked proposal refused its classification");
		}
		moved++;
	}
	return moved;
}

export type ClassificationCommit = {
	kind: "done" | "stale_revision" | "not_pending";
	/** Proposals that took an outcome. */
	moved: number;
	/** Whether this commit requested the branch's merge sync. */
	mergeSyncRequested: boolean;
};

/**
 * Spec §6.6 step 3, one transaction under §4.7, conditional on the branch's
 * `factsRevision` still being `factsRevision` (else `stale_revision`, and the
 * caller starts again): every non-terminal proposal on the branch, and every
 * CANCELED one whose current withdrawal is an established revert, takes its
 * `planBranchClassification` outcome (`branch_settled`, fenced on its
 * attempt and assignment, one `pull_request_reconciled` each); the branch's
 * membership becomes `status`; and on a MERGED branch whose pull request
 * merged into its frozen target, the merge sync is requested, once per
 * branch. The operations' own memberships are facts the caller wrote first
 * (`setOperationMembership`).
 */
export async function commitBranchClassification(i: {
	branchId: string;
	organizationId: string;
	factsRevision: number;
	status: "done" | "unverified";
}): Promise<ClassificationCommit> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx): Promise<ClassificationCommit> => {
			const none = { moved: 0, mergeSyncRequested: false };
			const branch = await readBranch(tx, i.branchId, i.organizationId);
			if (
				!branch ||
				branch.untracked ||
				membershipStatusOf(branch.membership) !== "pending" ||
				(branch.state !== "MERGED" && branch.state !== "CLOSED")
			) {
				return { kind: "not_pending", ...none };
			}
			if (branch.factsRevision !== i.factsRevision) {
				return { kind: "stale_revision", ...none };
			}
			const ops = await readClassificationOps(
				tx,
				branch.id,
				i.organizationId,
			);
			if (ops.some((op) => op.outcome === null)) {
				// An issued operation is recovery's first (spec §6 item 1).
				return { kind: "stale_revision", ...none };
			}
			const proposals = await lockBranchProposals(
				tx,
				branch.id,
				i.organizationId,
				{ revertCanceled: true },
			);
			const targetMismatch = targetMismatchOf(
				branch.pullRequestObservation,
			);
			const moves = planBranchClassification({
				branchId: branch.id,
				outcome: branch.state,
				ops,
				proposals: proposals.map((p) => ({
					snapshotId: p.id,
					state: p.state,
					assignment: p.assignment,
					withdrawRequestedAt: p.withdrawRequestedAt,
				})),
			});
			const moved = await applyMoves(tx, {
				branchId: branch.id,
				organizationId: i.organizationId,
				moves,
				proposals,
				targetMismatch,
			});
			const now = await databaseNow(tx);
			const previous = branch.membership as Partial<BranchMembership>;
			const membership: BranchMembership = {
				status: i.status,
				at: now.toISOString(),
				attempts:
					typeof previous?.attempts === "number"
						? previous.attempts
						: 0,
			};
			const mergeSync =
				branch.state === "MERGED" &&
				!targetMismatch &&
				!mergeSyncEverRequested(branch);
			const { count } =
				await tx.projectInstructionProposalBranch.updateMany({
					where: {
						id: branch.id,
						organizationId: i.organizationId,
						factsRevision: i.factsRevision,
						untracked: false,
					},
					data: {
						membership: asInputJson(membership),
						...(mergeSync ? { mergeSyncRequestedAt: now } : {}),
					},
				});
			if (count !== 1) {
				throw new Error(
					"A locked proposal branch refused its classification",
				);
			}
			return { kind: "done", moved, mergeSyncRequested: mergeSync };
		},
	);
}

/**
 * Spec §6.6 step 1 and Decision 14: the final history could not be
 * fetched, so classification waits `delayMs` (the caller's backoff) before
 * it tries again. Conditional on the membership still pending at
 * `factsRevision`; `attempts` counts the tries.
 */
export async function deferBranchClassification(i: {
	branchId: string;
	organizationId: string;
	factsRevision: number;
	delayMs: number;
}): Promise<boolean> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await readBranch(tx, i.branchId, i.organizationId);
			if (
				!branch ||
				branch.untracked ||
				branch.factsRevision !== i.factsRevision ||
				membershipStatusOf(branch.membership) !== "pending"
			) {
				return false;
			}
			const now = await databaseNow(tx);
			const previous = branch.membership as Partial<BranchMembership>;
			const membership: BranchMembership = {
				status: "pending",
				at:
					typeof previous.at === "string"
						? previous.at
						: now.toISOString(),
				attempts:
					(typeof previous.attempts === "number"
						? previous.attempts
						: 0) + 1,
				nextAttemptAt: new Date(
					now.getTime() + i.delayMs,
				).toISOString(),
			};
			const { count } =
				await tx.projectInstructionProposalBranch.updateMany({
					where: {
						id: branch.id,
						organizationId: i.organizationId,
						factsRevision: i.factsRevision,
						untracked: false,
					},
					data: { membership: asInputJson(membership) },
				});
			return count === 1;
		},
	);
}

// ---------------------------------------------------------------------------
// Settlement (spec §6.7)
// ---------------------------------------------------------------------------

/**
 * Spec §6.7 step 4 with no pull request: every non-terminal proposal whose
 * submission intent was withdrawn becomes CANCELED ("Withdrawn"). A
 * proposal that keeps its intent is left: with START_OVER it is rehomed.
 */
export function planBranchCancellation(i: {
	proposals: readonly ClassificationProposal[];
}): ClassificationMove[] {
	return i.proposals
		.filter((p) => p.withdrawRequestedAt !== null)
		.map((p) => ({
			snapshotId: p.snapshotId,
			to: "CANCELED" as const,
			reason: "withdrawn" as const,
		}));
}

/**
 * Spec §6.7 step 4, one transaction under §4.7, at the attempt the
 * settlement read on a CLOSE_REQUESTED branch:
 *
 * - a pull request found (`observation`): the branch becomes CLOSED or
 *   MERGED with it, membership `pending`, so the loop's classification
 *   applies Decision 14 and the intent next;
 * - none (`CANCELED`): the branch is CANCELED, and every proposal whose
 *   intent was withdrawn is CANCELED with it (`planBranchCancellation`).
 *
 * Either way `settledAt` is set with the 1 h confirmation due, the
 * settlement checkpoint becomes `recorded`, `closeIntent` is kept as the
 * record of what was asked, and one `pull_request_reconciled` is written on
 * the branch.
 */
export async function recordBranchSettlement(i: {
	branchId: string;
	organizationId: string;
	expectedAttempt: number;
	outcome: "MERGED" | "CLOSED" | "CANCELED";
	observation?: BranchPullRequestObservation;
}): Promise<{ ok: boolean; canceled: number }> {
	if ((i.outcome === "CANCELED") !== (i.observation === undefined)) {
		throw new Error(
			"A branch settlement records an observation exactly when a pull request was found",
		);
	}
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await readBranch(tx, i.branchId, i.organizationId);
			if (
				!branch ||
				branch.untracked ||
				branch.state !== "CLOSE_REQUESTED" ||
				branch.attempt !== i.expectedAttempt
			) {
				return { ok: false, canceled: 0 };
			}
			const now = await databaseNow(tx);
			let canceled = 0;
			if (i.outcome === "CANCELED") {
				const proposals = await lockBranchProposals(
					tx,
					branch.id,
					i.organizationId,
				);
				canceled = await applyMoves(tx, {
					branchId: branch.id,
					organizationId: i.organizationId,
					moves: planBranchCancellation({
						proposals: proposals.map((p) => ({
							snapshotId: p.id,
							state: p.state,
							assignment: p.assignment,
							withdrawRequestedAt: p.withdrawRequestedAt,
						})),
					}),
					proposals,
					targetMismatch: false,
				});
			}
			const destination = parseBranchDestination(branch.destination);
			const o = i.observation;
			const moved = await transitionBranch(
				{
					branchId: branch.id,
					organizationId: i.organizationId,
					from: ["CLOSE_REQUESTED"],
					expectedAttempt: i.expectedAttempt,
					to: i.outcome,
					bumpAttempt: true,
					data: {
						settledAt: now,
						confirmations: 0,
						confirmationDueAt: new Date(now.getTime() + HOUR_MS),
						settlementPhase: "recorded",
						failure: null,
						nextAttemptAt: null,
						retryRequestedAt: null,
						...(o
							? {
									pullRequestUrl: o.url,
									pullRequestExternalId: o.externalId,
									pullRequestObservation: asInputJson(
										branchObservationJson(
											o,
											destination?.targetRef ?? null,
										),
									),
									lastCheckedAt: now,
									membership: asInputJson({
										status: "pending",
										at: now.toISOString(),
										attempts: 0,
									} satisfies BranchMembership),
								}
							: {}),
					},
				},
				tx,
			);
			if (!moved.ok) {
				throw new Error(
					"A locked proposal branch refused its settlement",
				);
			}
			await recordAuditTx(tx, {
				action: RECONCILED,
				category: "project",
				actor: { type: "system" },
				organizationId: i.organizationId,
				projectId: branch.projectId,
				resource: branchResource(branch),
				metadata: {
					outcome:
						i.outcome === "MERGED"
							? "merged"
							: i.outcome === "CLOSED"
								? "closed"
								: "canceled",
					branchId: branch.id,
					closeIntent: branch.closeIntent,
					externalId: o?.externalId ?? null,
					targetMismatch:
						o !== undefined &&
						destination !== null &&
						o.targetRef !== destination.targetRef,
					canceled,
				},
			});
			return { ok: true, canceled };
		},
	);
}

/**
 * Spec §6.7 steps 0 and 4, Decision 11: Start over aborts. The branch
 * returns from CLOSE_REQUESTED (START_OVER, at the attempt settlement read)
 * to BLOCKED with the non-retryable `START_OVER_REFUSED`, `closeIntent` and
 * the checkpoint cleared; the ref and every proposal are untouched. A
 * finding of foreign history (`foreign`) also sets `foreignTipAt`, once.
 */
export async function refuseBranchStartOver(i: {
	branchId: string;
	organizationId: string;
	expectedAttempt: number;
	foreign: boolean;
}): Promise<boolean> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await readBranch(tx, i.branchId, i.organizationId);
			if (
				!branch ||
				branch.untracked ||
				branch.state !== "CLOSE_REQUESTED" ||
				branch.closeIntent !== "START_OVER" ||
				branch.attempt !== i.expectedAttempt
			) {
				return false;
			}
			const now = await databaseNow(tx);
			const failure: PullRequestFailure = {
				phase: "close",
				code: "START_OVER_REFUSED",
				retryable: false,
				at: now.toISOString(),
				params: {},
			};
			const moved = await transitionBranch(
				{
					branchId: branch.id,
					organizationId: i.organizationId,
					from: ["CLOSE_REQUESTED"],
					expectedAttempt: i.expectedAttempt,
					to: "BLOCKED",
					bumpAttempt: true,
					data: {
						closeIntent: null,
						settlementPhase: null,
						failure: asInputJson(failure),
						nextAttemptAt: null,
					},
				},
				tx,
			);
			if (!moved.ok) {
				throw new Error("A locked proposal branch refused its refusal");
			}
			if (i.foreign) {
				await tx.projectInstructionProposalBranch.updateMany({
					where: {
						id: branch.id,
						organizationId: i.organizationId,
						foreignTipAt: null,
					},
					data: { foreignTipAt: now },
				});
			}
			return true;
		},
	);
}

/**
 * Spec §6.7 "Checkpoint": the leased delete's own success, recorded before
 * the second lookup as one conditional write of `deletedAt` and
 * `settlementPhase = deleted`, on the CLOSE_REQUESTED branch at the attempt
 * settlement read. False when the branch moved or was already marked.
 */
export async function recordBranchDeleted(i: {
	branchId: string;
	organizationId: string;
	expectedAttempt: number;
}): Promise<boolean> {
	const count = await db.$executeRaw`
		UPDATE "project_instruction_proposal_branch"
		SET "deletedAt" = (now() AT TIME ZONE 'UTC'), "settlementPhase" = 'deleted',
			"updatedAt" = (now() AT TIME ZONE 'UTC')
		WHERE "id" = ${i.branchId} AND "organizationId" = ${i.organizationId}
			AND "state" = 'CLOSE_REQUESTED' AND "attempt" = ${i.expectedAttempt}
			AND "deletedAt" IS NULL AND NOT "untracked"`;
	return count === 1;
}

// ---------------------------------------------------------------------------
// Confirmations (spec §6.7 step 4, #2563 §6.2 step 4)
// ---------------------------------------------------------------------------

/**
 * One settlement confirmation, conditional on the count the confirmer read
 * (never on the attempt: a confirmation is a fact about the ref). The count
 * goes up by one; the second clears the create marker and the due time,
 * the first moves it to 24 h after `settledAt`. `found` is a pull request
 * other than the branch's own that the confirmer found on the ref: on a
 * CANCELED branch one that merged makes it MERGED, one that is closed (by
 * the confirmer, an earlier attempt of it, or anyone) makes it CLOSED, with
 * the observation and membership `pending` (so the loop classifies it) and
 * one `pull_request_reconciled`.
 */
export async function recordBranchConfirmation(i: {
	branchId: string;
	organizationId: string;
	confirmations: number;
	found?: {
		observation: BranchPullRequestObservation;
		to: "CLOSED" | "MERGED" | "unchanged";
	};
}): Promise<boolean> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await readBranch(tx, i.branchId, i.organizationId);
			if (
				!branch ||
				branch.untracked ||
				branch.settledAt === null ||
				branch.confirmationDueAt === null ||
				branch.confirmations !== i.confirmations
			) {
				return false;
			}
			const now = await databaseNow(tx);
			const count = i.confirmations + 1;
			const moves =
				i.found !== undefined &&
				i.found.to !== "unchanged" &&
				branch.state === "CANCELED" &&
				isLegalBranchMove(branch.state, i.found.to);
			const destination = parseBranchDestination(branch.destination);
			const o = i.found?.observation;
			const { count: written } =
				await tx.projectInstructionProposalBranch.updateMany({
					where: {
						id: branch.id,
						organizationId: i.organizationId,
						confirmations: i.confirmations,
						untracked: false,
					},
					data: {
						confirmations: count,
						confirmationDueAt:
							count >= 2
								? null
								: new Date(
										branch.settledAt.getTime() +
											24 * HOUR_MS,
									),
						...(count >= 2 ? { createIssuedAt: null } : {}),
						...(moves && o && i.found
							? {
									state: i.found.to as "CLOSED" | "MERGED",
									attempt: { increment: 1 },
									pullRequestUrl: o.url,
									pullRequestExternalId: o.externalId,
									pullRequestObservation: asInputJson(
										branchObservationJson(
											o,
											destination?.targetRef ?? null,
										),
									),
									lastCheckedAt: now,
									membership: asInputJson({
										status: "pending",
										at: now.toISOString(),
										attempts: 0,
									} satisfies BranchMembership),
								}
							: {}),
					},
				});
			if (written !== 1) {
				return false;
			}
			if (moves && o && i.found) {
				await recordAuditTx(tx, {
					action: RECONCILED,
					category: "project",
					actor: { type: "system" },
					organizationId: i.organizationId,
					projectId: branch.projectId,
					resource: branchResource(branch),
					metadata: {
						outcome: i.found.to === "MERGED" ? "merged" : "closed",
						branchId: branch.id,
						externalId: o.externalId,
						confirmation: count,
						targetMismatch:
							destination !== null &&
							o.targetRef !== destination.targetRef,
					},
				});
			}
			return true;
		},
	);
}

/**
 * A confirmation that could not look (a provider or credential failure):
 * its due time moves `delayMs` past the database clock, conditional on the
 * count read, so the loop does not ask again at once. Nothing else changes.
 */
export async function deferBranchConfirmation(i: {
	branchId: string;
	organizationId: string;
	confirmations: number;
	delayMs: number;
}): Promise<boolean> {
	const count = await db.$executeRaw`
		UPDATE "project_instruction_proposal_branch"
		SET "confirmationDueAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${Math.round(i.delayMs / 1000)}::int),
			"updatedAt" = (now() AT TIME ZONE 'UTC')
		WHERE "id" = ${i.branchId} AND "organizationId" = ${i.organizationId}
			AND "confirmations" = ${i.confirmations} AND "confirmationDueAt" IS NOT NULL
			AND NOT "untracked"`;
	return count === 1;
}

// ---------------------------------------------------------------------------
// Rehome refusal (spec §4.3 "Rehome", Decision 15)
// ---------------------------------------------------------------------------

/**
 * A rehomable proposal `transferProposal` would not move (`not_joinable`,
 * or `configuration_changed` without a write, as for a proposal already
 * BLOCKED CONFIGURATION_CHANGED in phase append) would be offered to rehome
 * again on every read of the loop. Under §4.7, re-read: while it is still
 * rehomable from this branch, it becomes BLOCKED CONFIGURATION_CHANGED in
 * phase admission (`branch_stale_destination`, fenced on its attempt and
 * assignment), which rehome never takes, and the member sees why. True when
 * it was blocked here.
 */
export async function blockUnrehomableProposal(i: {
	branchId: string;
	organizationId: string;
	snapshotId: string;
}): Promise<boolean> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [i.snapshotId],
		},
		async (tx) => {
			const branch = await readBranch(tx, i.branchId, i.organizationId);
			if (!branch || branch.untracked) {
				return false;
			}
			const proposals = (
				await lockBranchProposals(tx, branch.id, i.organizationId)
			).filter((p) => p.id === i.snapshotId);
			const p = proposals[0];
			if (!p) {
				return false;
			}
			const ops = (
				await readClassificationOps(tx, branch.id, i.organizationId)
			).filter((op) => op.snapshotId === p.id);
			const now = await databaseNow(tx);
			const still = rehomableProposals({
				branch,
				ops,
				proposals: [
					{
						snapshotId: p.id,
						sequence: p.sequence,
						state: p.state,
						status: p.status,
						proposalStatus: p.proposalStatus,
						withdrawRequestedAt: p.withdrawRequestedAt,
						failure: p.failure,
						nextAttemptAt: p.nextAttemptAt,
						assignment: p.assignment,
						attempt: p.attempt,
					},
				],
				now,
			});
			if (!still.includes(p.id)) {
				return false;
			}
			const failure: PullRequestFailure = {
				phase: "admission",
				code: "CONFIGURATION_CHANGED",
				retryable: false,
				at: now.toISOString(),
				params: {},
			};
			const moved = await transitionPullRequest(
				{
					snapshotId: p.id,
					organizationId: i.organizationId,
					event: "branch_stale_destination",
					from: [p.state],
					expectedAttempt: p.attempt,
					to: "BLOCKED",
					bumpAttempt: true,
					branch: { id: branch.id, assignment: p.assignment },
					data: {
						pullRequestFailure: asInputJson(failure),
						pullRequestNextAttemptAt: null,
					},
				},
				tx,
			);
			return moved.ok;
		},
	);
}

// ---------------------------------------------------------------------------
// The branch's merge sync (spec §6.6 "Merge sync", #2563 §9.1)
// ---------------------------------------------------------------------------

function expectedFilter(expected: MergeSyncTuple | null) {
	return {
		equals:
			expected === null
				? Prisma.AnyNull
				: (expected as unknown as Prisma.InputJsonValue),
	};
}

/**
 * #2563 §9.1 steps 2 and 5 on a MERGED branch, conditional on
 * `mergeSyncExpected` still being the tuple the caller compared: an
 * acknowledgment keeps `mergeSyncRunId` and writes exactly its
 * `pull_request_merge_sync_requested` row; a give-up writes its
 * non-retryable `merge_sync` failure and drops the run id. False when the
 * branch moved.
 */
export async function clearBranchMergeSyncRequest(
	i:
		| {
				kind: "acknowledged";
				branchId: string;
				organizationId: string;
				expected: MergeSyncTuple;
				audit: RecordAuditInput;
		  }
		| {
				kind: "gave_up";
				branchId: string;
				organizationId: string;
				expected: MergeSyncTuple | null;
				failure: PullRequestFailure & {
					phase: "merge_sync";
					retryable: false;
				};
		  },
): Promise<boolean> {
	if (
		i.kind === "acknowledged" &&
		i.audit.action !==
			"project.instructions.pull_request_merge_sync_requested"
	) {
		throw new Error(
			"clearBranchMergeSyncRequest: an acknowledgment writes one pull_request_merge_sync_requested row",
		);
	}
	return db.$transaction(async (tx) => {
		const { count } = await tx.projectInstructionProposalBranch.updateMany({
			where: {
				id: i.branchId,
				organizationId: i.organizationId,
				state: "MERGED",
				untracked: false,
				mergeSyncRequestedAt: { not: null },
				mergeSyncExpected: expectedFilter(i.expected),
			},
			data: {
				mergeSyncRequestedAt: null,
				mergeSyncDispatchedAt: null,
				...(i.kind === "gave_up"
					? {
							mergeSyncRunId: null,
							failure: asInputJson(i.failure),
							nextAttemptAt: null,
						}
					: {}),
			},
		});
		if (count !== 1) {
			return false;
		}
		if (i.kind === "acknowledged") {
			await recordAuditTx(tx, i.audit);
		}
		return true;
	});
}

/**
 * #2563 §9.1 step 3 on a MERGED branch: the one conditional write before the
 * starter is called: `mergeSyncDispatchedAt`, the tuple about to be passed,
 * the next attempt, and the previous run id forgotten. False when another
 * dispatcher or a clear moved first.
 */
export async function markBranchMergeSyncDispatched(i: {
	branchId: string;
	organizationId: string;
	lastExpected: MergeSyncTuple | null;
	next: MergeSyncTuple;
	dispatchedAt: Date;
	nextAttemptAt: Date;
}): Promise<boolean> {
	const { count } = await db.projectInstructionProposalBranch.updateMany({
		where: {
			id: i.branchId,
			organizationId: i.organizationId,
			state: "MERGED",
			untracked: false,
			mergeSyncRequestedAt: { not: null },
			mergeSyncExpected: expectedFilter(i.lastExpected),
		},
		data: {
			mergeSyncDispatchedAt: i.dispatchedAt,
			mergeSyncExpected: asInputJson(i.next),
			mergeSyncRunId: null,
			nextAttemptAt: i.nextAttemptAt,
		},
	});
	return count === 1;
}

/**
 * #2563 §9.1 step 3: the Temporal run id the starter reached, conditional on
 * the dispatch this caller marked. Clears a previous `merge_sync` failure.
 */
export async function recordBranchMergeSyncRun(i: {
	branchId: string;
	organizationId: string;
	expected: MergeSyncTuple;
	runId: string;
}): Promise<boolean> {
	return db.$transaction(async (tx) => {
		const branch = await readBranch(tx, i.branchId, i.organizationId);
		const phase =
			branch?.failure !== null && typeof branch?.failure === "object"
				? (branch.failure as { phase?: unknown }).phase
				: undefined;
		const { count } = await tx.projectInstructionProposalBranch.updateMany({
			where: {
				id: i.branchId,
				organizationId: i.organizationId,
				state: "MERGED",
				untracked: false,
				mergeSyncRequestedAt: { not: null },
				mergeSyncDispatchedAt: { not: null },
				mergeSyncExpected: expectedFilter(i.expected),
			},
			data: {
				mergeSyncRunId: i.runId,
				...(phase === "merge_sync" ? { failure: Prisma.DbNull } : {}),
			},
		});
		return count === 1;
	});
}
