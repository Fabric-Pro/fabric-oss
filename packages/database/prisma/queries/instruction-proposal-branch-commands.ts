/**
 * Member proposal branches: the member's own commands and the reads the tab,
 * the CLI and REST v1 show (Fizzy #2738 spec §4.3 "Try again", "Propose
 * again", "Branch close requested"; §4.4 "Close requested", "Retry opening";
 * Decisions 11, 14, 17, 19; §10 "Procedures, REST v1 and SDK").
 *
 * Every command here is authorized by its procedure (spec Decision 18) and
 * runs in one transaction under the §4.7 lock order: the branch row, then
 * the proposal rows. Nothing here runs git or signals the branch workflow;
 * the procedure wakes it after commit, and the sweeper does when that wake
 * is lost (spec §8).
 */
import { db, type Prisma } from "../client";
import type { ProjectInstructionPullRequestState } from "../generated/client";
import { type RecordAuditInput, recordAuditTx } from "./audit-log";
import {
	acceptsAppends,
	currentAppend,
	currentWithdrawal,
	type EvidenceOp,
	isEstablished,
	isLiveProposal,
	isTerminalPullRequestState,
	type OpOutcome,
	reconcileProposalFromEvidence,
} from "./instruction-proposal-branch-evidence";
import {
	type BranchRow,
	isTerminalBranchState,
	type JoinResult,
	type ProposalBranchNaming,
	transferProposal,
	transitionBranch,
	withBranchLockOrder,
} from "./instruction-proposal-branches";
import { transitionPullRequest } from "./instruction-proposal-pull-requests";
import { applyBranchCloseRequested } from "./instructions";

/** The request half of a member command's audit rows. */
export type BranchCommandRequester = Pick<
	RecordAuditInput,
	| "actor"
	| "ipAddress"
	| "userAgent"
	| "requestId"
	| "sessionId"
	| "correlationId"
>;

const NON_TERMINAL: readonly ProjectInstructionPullRequestState[] = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"BLOCKED",
];

function failureCodeOf(value: unknown): string | null {
	if (value === null || typeof value !== "object") {
		return null;
	}
	const code = (value as { code?: unknown }).code;
	return typeof code === "string" ? code : null;
}

function failureRetryableOf(value: unknown): boolean | null {
	if (value === null || typeof value !== "object") {
		return null;
	}
	const retryable = (value as { retryable?: unknown }).retryable;
	return typeof retryable === "boolean" ? retryable : null;
}

async function clock(tx: Prisma.TransactionClient): Promise<Date> {
	const [row] = await tx.$queryRaw<
		Array<{ now: Date }>
	>`SELECT (now() AT TIME ZONE 'UTC') AS "now"`;
	return row?.now ?? new Date();
}

function branchAudit(
	branch: Pick<BranchRow, "id" | "projectId" | "number">,
	organizationId: string,
	action:
		| "project.instructions.pull_request_close_requested"
		| "project.instructions.pull_request_retry_requested",
	requester: BranchCommandRequester,
	metadata: Record<string, unknown>,
): RecordAuditInput {
	return {
		action,
		category: "project",
		actor: requester.actor,
		organizationId,
		projectId: branch.projectId,
		// The branch number, never the ref: the ref carries the member's name.
		resource: {
			type: "project_instruction_proposal_branch",
			id: branch.id,
			name: `#${branch.number}`,
		},
		metadata: { branchId: branch.id, ...metadata },
		ipAddress: requester.ipAddress,
		userAgent: requester.userAgent,
		requestId: requester.requestId,
		sessionId: requester.sessionId,
		correlationId: requester.correlationId,
	};
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One branch of the project, tenant-scoped; null when there is none. */
export function getMemberProposalBranch(i: {
	branchId: string;
	projectId: string;
	organizationId: string;
}): Promise<BranchRow | null> {
	return db.projectInstructionProposalBranch.findFirst({
		where: {
			id: i.branchId,
			projectId: i.projectId,
			organizationId: i.organizationId,
		},
	});
}

/** The branch a proposal is on now, or null. */
export async function proposalBranchIdOf(i: {
	snapshotId: string;
	organizationId: string;
}): Promise<string | null> {
	const row = await db.projectInstructionSnapshot.findFirst({
		where: { id: i.snapshotId, organizationId: i.organizationId },
		select: { proposalBranchId: true },
	});
	return row?.proposalBranchId ?? null;
}

/** One journal operation as the views read it. */
export type AttachmentOp = EvidenceOp & {
	sha: string;
	membership: string | null;
};

/** A proposal on a member branch, with the branch and its own operations there. */
export type ProposalBranchAttachment = {
	snapshotId: string;
	branch: BranchRow;
	assignment: number;
	state: ProjectInstructionPullRequestState | null;
	failure: unknown;
	/** Every operation of this proposal on `branch`, any assignment. */
	ops: AttachmentOp[];
};

const ATTACHMENT_OP_SELECT = {
	id: true,
	snapshotId: true,
	kind: true,
	executionSeq: true,
	assignment: true,
	branchId: true,
	outcome: true,
	sha: true,
	membership: true,
} satisfies Prisma.ProjectInstructionProposalBranchOperationSelect;

/**
 * The branch and journal of each of `snapshotIds` that is on a member branch,
 * in three tenant-scoped queries whatever the count: a page of the proposal
 * list reads them once. A proposal on no branch (FABRIC, #2563) is absent.
 */
export async function readProposalBranchAttachments(i: {
	organizationId: string;
	snapshotIds: readonly string[];
}): Promise<Map<string, ProposalBranchAttachment>> {
	const out = new Map<string, ProposalBranchAttachment>();
	const ids = [...new Set(i.snapshotIds)];
	if (ids.length === 0) {
		return out;
	}
	const proposals = await db.projectInstructionSnapshot.findMany({
		where: {
			id: { in: ids },
			organizationId: i.organizationId,
			proposalBranchId: { not: null },
		},
		select: {
			id: true,
			proposalBranchId: true,
			proposalAssignment: true,
			pullRequestState: true,
			pullRequestFailure: true,
		},
	});
	if (proposals.length === 0) {
		return out;
	}
	const branchIds = [
		...new Set(proposals.map((p) => p.proposalBranchId as string)),
	];
	const [branches, ops] = await Promise.all([
		db.projectInstructionProposalBranch.findMany({
			where: { id: { in: branchIds }, organizationId: i.organizationId },
		}),
		db.projectInstructionProposalBranchOperation.findMany({
			where: {
				organizationId: i.organizationId,
				snapshotId: { in: proposals.map((p) => p.id) },
				branchId: { in: branchIds },
			},
			select: ATTACHMENT_OP_SELECT,
		}),
	]);
	const branchById = new Map(branches.map((b) => [b.id, b]));
	for (const p of proposals) {
		const branch = branchById.get(p.proposalBranchId as string);
		if (!branch) {
			continue;
		}
		out.set(p.id, {
			snapshotId: p.id,
			branch,
			assignment: p.proposalAssignment,
			state: p.pullRequestState,
			failure: p.pullRequestFailure,
			ops: ops
				.filter(
					(op) => op.snapshotId === p.id && op.branchId === branch.id,
				)
				.map((op) => ({
					id: op.id,
					kind: op.kind,
					executionSeq: op.executionSeq,
					assignment: op.assignment,
					branchId: op.branchId,
					outcome: op.outcome as OpOutcome,
					sha: op.sha,
					membership: op.membership,
				})),
		});
	}
	return out;
}

/** What a proposal's append did (spec §10 `append`). */
export type ProposalAppendSummary = {
	outcome: "appended" | "already_on_branch" | null;
	commitSha: string | null;
	membership: "included" | "unverified" | null;
};

/**
 * The `append` block of a proposal on a branch, from its current submission
 * only (spec §4.1): `appended` with the commit when the current append is
 * established, `already_on_branch` for the informational no-op cancel.
 * Membership is the current append's classification (Decision 14), and
 * `unverified` too for a current append or withdrawal still `unknown` on a
 * terminal branch (spec §4.3 "Terminal branch, unresolved push").
 */
export function proposalAppendSummary(
	a: Pick<
		ProposalBranchAttachment,
		"branch" | "assignment" | "failure" | "ops"
	>,
): ProposalAppendSummary {
	const submission = { branchId: a.branch.id, assignment: a.assignment };
	const append = currentAppend(a.ops, submission);
	const withdrawal = currentWithdrawal(a.ops, submission);
	const appended = append !== null && isEstablished(append);
	const own =
		append === null
			? null
			: (a.ops.find((op) => op.id === append.id) ?? null);
	const membership =
		own?.membership === "included" || own?.membership === "unverified"
			? own.membership
			: isTerminalBranchState(a.branch.state) &&
					(append?.outcome === "unknown" ||
						withdrawal?.outcome === "unknown")
				? "unverified"
				: null;
	return {
		outcome: appended
			? "appended"
			: failureCodeOf(a.failure) === "ALREADY_ON_BRANCH"
				? "already_on_branch"
				: null,
		commitSha: appended && own ? own.sha : null,
		membership,
	};
}

/**
 * How many live changes each branch carries (spec §4.1 `live`), for the
 * panel's count and the Close copy ("withdraws its N changes").
 */
export async function countLiveBranchChanges(i: {
	organizationId: string;
	branchIds: readonly string[];
}): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	const ids = [...new Set(i.branchIds)];
	if (ids.length === 0) {
		return out;
	}
	const [proposals, ops] = await Promise.all([
		db.projectInstructionSnapshot.findMany({
			where: {
				organizationId: i.organizationId,
				proposalBranchId: { in: ids },
				pullRequestState: { in: [...NON_TERMINAL] },
			},
			select: {
				id: true,
				proposalBranchId: true,
				proposalAssignment: true,
				pullRequestState: true,
				pullRequestFailure: true,
				withdrawRequestedAt: true,
			},
		}),
		db.projectInstructionProposalBranchOperation.findMany({
			where: { organizationId: i.organizationId, branchId: { in: ids } },
			select: ATTACHMENT_OP_SELECT,
		}),
	]);
	for (const id of ids) {
		out.set(id, 0);
	}
	for (const p of proposals) {
		const branchId = p.proposalBranchId as string;
		const live = isLiveProposal({
			state: p.pullRequestState,
			failure: p.pullRequestFailure,
			withdrawRequestedAt: p.withdrawRequestedAt,
			ops: ops
				.filter((op) => op.snapshotId === p.id)
				.map((op) => ({ ...op, outcome: op.outcome as OpOutcome })),
			branchId,
			assignment: p.proposalAssignment,
		});
		if (live) {
			out.set(branchId, (out.get(branchId) ?? 0) + 1);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Branch commands (spec §4.4 "Close requested", "Retry opening"; Decision 11)
// ---------------------------------------------------------------------------

export type BranchCommandResult =
	| { kind: "done"; changed: boolean; attempt: number }
	| { kind: "not_found" }
	/** The branch is not in a state the command applies to. */
	| { kind: "not_applicable" }
	/** The branch moved since the caller read `expectedAttempt`. */
	| { kind: "stale" };

const CLOSABLE: readonly BranchRow["state"][] = [
	"PENDING",
	"OPENING",
	"OPEN",
	"BLOCKED",
];

/** Reads the branch under its row lock (the caller's `withBranchLockOrder`). */
function lockedBranch(
	tx: Prisma.TransactionClient,
	i: { branchId: string; projectId: string; organizationId: string },
): Promise<BranchRow | null> {
	return tx.projectInstructionProposalBranch.findFirst({
		where: {
			id: i.branchId,
			projectId: i.projectId,
			organizationId: i.organizationId,
		},
	});
}

type BranchCommandInput = {
	branchId: string;
	projectId: string;
	organizationId: string;
	expectedAttempt: number;
	requester: BranchCommandRequester;
};

/**
 * Close pull request (spec Decision 11, §4.4 "Close requested", §4.3 "Branch
 * close requested"): the branch becomes CLOSE_REQUESTED with `closeIntent =
 * WITHDRAW` (attempt + 1) and, in the same transaction, every non-terminal
 * proposal on it takes intent `branch` with its command cleared; QUEUED and
 * pre-append BLOCKED ones are CANCELED. Settlement then closes the pull
 * request and deletes what Fabric alone made. A repeat on a branch already
 * closing with WITHDRAW changes nothing. The branch's failure is kept, so a
 * REPOSITORY_CHANGED branch can still be stopped tracking.
 */
export function closeProposalBranch(
	i: BranchCommandInput,
): Promise<BranchCommandResult> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await lockedBranch(tx, i);
			if (!branch || branch.untracked) {
				return { kind: "not_found" };
			}
			if (
				branch.state === "CLOSE_REQUESTED" &&
				branch.closeIntent === "WITHDRAW"
			) {
				return {
					kind: "done",
					changed: false,
					attempt: branch.attempt,
				};
			}
			if (!CLOSABLE.includes(branch.state)) {
				return { kind: "not_applicable" };
			}
			if (branch.attempt !== i.expectedAttempt) {
				return { kind: "stale" };
			}
			const moved = await transitionBranch(
				{
					branchId: branch.id,
					organizationId: i.organizationId,
					from: [branch.state],
					expectedAttempt: branch.attempt,
					to: "CLOSE_REQUESTED",
					bumpAttempt: true,
					data: {
						closeIntent: "WITHDRAW",
						nextAttemptAt: null,
						retryRequestedAt: null,
					},
				},
				tx,
			);
			if (!moved.ok) {
				throw new Error("A locked proposal branch refused its close");
			}
			const applied = await applyBranchCloseRequested(tx, {
				branchId: branch.id,
				organizationId: i.organizationId,
				projectId: branch.projectId,
				requester: i.requester,
			});
			await recordAuditTx(
				tx,
				branchAudit(
					branch,
					i.organizationId,
					"project.instructions.pull_request_close_requested",
					i.requester,
					{
						scope: "branch",
						closeIntent: "WITHDRAW",
						stateBefore: branch.state,
						canceled: applied.canceled,
						kept: applied.kept,
					},
				),
			);
			return { kind: "done", changed: true, attempt: moved.attempt };
		},
	);
}

/**
 * Start over on a new branch (spec Decision 11): only for a branch BLOCKED
 * with non-retryable CREATE_OUTCOME_UNKNOWN and no foreign commits. The
 * branch becomes CLOSE_REQUESTED with `closeIntent = START_OVER`; its
 * proposals keep their submission intent, because settlement moves the live
 * ones to a new branch only after it deleted the ref.
 */
export function startOverProposalBranch(
	i: BranchCommandInput,
): Promise<BranchCommandResult> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await lockedBranch(tx, i);
			if (!branch || branch.untracked) {
				return { kind: "not_found" };
			}
			if (
				branch.state === "CLOSE_REQUESTED" &&
				branch.closeIntent === "START_OVER"
			) {
				return {
					kind: "done",
					changed: false,
					attempt: branch.attempt,
				};
			}
			if (
				branch.state !== "BLOCKED" ||
				failureCodeOf(branch.failure) !== "CREATE_OUTCOME_UNKNOWN" ||
				failureRetryableOf(branch.failure) !== false ||
				branch.foreignTipAt !== null
			) {
				return { kind: "not_applicable" };
			}
			if (branch.attempt !== i.expectedAttempt) {
				return { kind: "stale" };
			}
			const moved = await transitionBranch(
				{
					branchId: branch.id,
					organizationId: i.organizationId,
					from: ["BLOCKED"],
					expectedAttempt: branch.attempt,
					to: "CLOSE_REQUESTED",
					bumpAttempt: true,
					data: { closeIntent: "START_OVER", nextAttemptAt: null },
				},
				tx,
			);
			if (!moved.ok) {
				throw new Error(
					"A locked proposal branch refused its start over",
				);
			}
			await recordAuditTx(
				tx,
				branchAudit(
					branch,
					i.organizationId,
					"project.instructions.pull_request_close_requested",
					i.requester,
					{
						scope: "branch",
						closeIntent: "START_OVER",
						stateBefore: branch.state,
					},
				),
			);
			return { kind: "done", changed: true, attempt: moved.attempt };
		},
	);
}

/**
 * Retry opening (spec Decision 17, §4.4): only for a branch BLOCKED with
 * PR_CREATION_REFUSED. Persists `retryRequestedAt`; the workflow's `retry`
 * item looks for the pull request first and re-issues `open` on the same ref
 * only when it finds none. The branch keeps its state and attempt, so a
 * second request before the workflow runs changes nothing.
 */
export function requestProposalBranchRetry(
	i: BranchCommandInput,
): Promise<BranchCommandResult> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await lockedBranch(tx, i);
			if (!branch || branch.untracked) {
				return { kind: "not_found" };
			}
			if (
				branch.state !== "BLOCKED" ||
				failureCodeOf(branch.failure) !== "PR_CREATION_REFUSED"
			) {
				return { kind: "not_applicable" };
			}
			if (branch.attempt !== i.expectedAttempt) {
				return { kind: "stale" };
			}
			if (branch.retryRequestedAt !== null) {
				return {
					kind: "done",
					changed: false,
					attempt: branch.attempt,
				};
			}
			const moved = await transitionBranch(
				{
					branchId: branch.id,
					organizationId: i.organizationId,
					from: ["BLOCKED"],
					expectedAttempt: branch.attempt,
					to: "unchanged",
					bumpAttempt: false,
					data: { retryRequestedAt: await clock(tx) },
				},
				tx,
			);
			if (!moved.ok) {
				throw new Error("A locked proposal branch refused its retry");
			}
			await recordAuditTx(
				tx,
				branchAudit(
					branch,
					i.organizationId,
					"project.instructions.pull_request_retry_requested",
					i.requester,
					{ kind: "retry_opening" },
				),
			);
			return { kind: "done", changed: true, attempt: moved.attempt };
		},
	);
}

// ---------------------------------------------------------------------------
// Proposal commands (spec §4.3 "Try again", "Propose again")
// ---------------------------------------------------------------------------

/** The failures Try again answers (spec §4.3, §9). */
export const TRY_AGAIN_FAILURE_CODES = [
	"BRANCH_CONFLICT",
	"SUPERSEDED_BY_LATER_CHANGE",
	"PUSH_OUTCOME_UNKNOWN",
] as const;

export type TryAgainResult =
	/** The current append was already established: the proposal is OPEN. */
	| { kind: "open"; branchId: string; attempt: number }
	/** Queued at the end of the branch with a new intent order and an APPEND command. */
	| {
			kind: "queued";
			branchId: string;
			attempt: number;
			sequence: number;
			pendingCommandSeq: number;
	  }
	| { kind: "not_found" }
	| { kind: "not_applicable" }
	| { kind: "stale" }
	/** The branch no longer takes appends (closing, terminal, retired, untracked, blocked for good). */
	| { kind: "branch_not_accepting" };

/** Retries the lock-ordered transaction when the proposal moved branch while it waited. */
class TryAgainRelock extends Error {
	constructor() {
		super("the proposal moved to another branch");
	}
}

const RELOCKS = 3;

/**
 * Try again (spec §4.3): a BLOCKED proposal with either conflict code or
 * PUSH_OUTCOME_UNKNOWN, by its author, at the attempt the card showed.
 *
 * Under the branch lock, then the proposal's, it first reconciles from all
 * the evidence for its current submission (`reconcileProposalFromEvidence`,
 * §4.1): an already established current append makes it OPEN and nothing is
 * queued. Otherwise it becomes QUEUED at a new sequence at the end of the
 * branch, with a new `intentOrder` from `project_instruction_proposal_intent_seq`
 * and `pendingCommand = APPEND` at the branch's `nextExecutionSeq`, read under
 * the branch lock, so a late fact about an older operation cannot undo the
 * member's command. The assignment is kept: this is the same submission. An
 * `unknown` current append is re-observed by the branch workflow before its
 * next append (§6.2 step 5), never here: the API runs no git.
 */
export async function tryBranchProposalAgain(i: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	proposerUserId: string;
	expectedAttempt: number;
	requester: BranchCommandRequester;
}): Promise<TryAgainResult> {
	const own = {
		id: i.snapshotId,
		projectId: i.projectId,
		organizationId: i.organizationId,
		userId: i.proposerUserId,
	};
	for (let relock = 0; ; relock++) {
		const peek = await db.projectInstructionSnapshot.findFirst({
			where: own,
			select: { proposalBranchId: true },
		});
		if (!peek) {
			return { kind: "not_found" };
		}
		const branchId = peek.proposalBranchId;
		if (branchId === null) {
			return { kind: "not_applicable" };
		}
		try {
			return await withBranchLockOrder(
				{
					organizationId: i.organizationId,
					branchIds: [branchId],
					snapshotIds: [i.snapshotId],
				},
				(tx) => tryAgainLocked(tx, i, own, branchId),
			);
		} catch (error) {
			if (error instanceof TryAgainRelock && relock < RELOCKS) {
				continue;
			}
			throw error;
		}
	}
}

const TRY_AGAIN_SELECT = {
	id: true,
	version: true,
	pullRequestOperationId: true,
	pullRequestState: true,
	pullRequestAttempt: true,
	pullRequestFailure: true,
	withdrawRequestedAt: true,
	proposalBranchId: true,
	proposalAssignment: true,
} satisfies Prisma.ProjectInstructionSnapshotSelect;

async function tryAgainLocked(
	tx: Prisma.TransactionClient,
	i: Parameters<typeof tryBranchProposalAgain>[0],
	own: Prisma.ProjectInstructionSnapshotWhereInput,
	branchId: string,
): Promise<TryAgainResult> {
	const read = () =>
		tx.projectInstructionSnapshot.findFirst({
			where: own,
			select: TRY_AGAIN_SELECT,
		});
	let row = await read();
	if (!row) {
		return { kind: "not_found" };
	}
	if (row.proposalBranchId !== branchId) {
		throw new TryAgainRelock();
	}
	const code = failureCodeOf(row.pullRequestFailure);
	if (
		row.pullRequestState !== "BLOCKED" ||
		row.withdrawRequestedAt !== null ||
		code === null ||
		!(TRY_AGAIN_FAILURE_CODES as readonly string[]).includes(code)
	) {
		return { kind: "not_applicable" };
	}
	if (row.pullRequestAttempt !== i.expectedAttempt) {
		return { kind: "stale" };
	}
	const audit = (outcome: "open" | "queued"): RecordAuditInput => ({
		action: "project.instructions.pull_request_retry_requested",
		category: "project",
		actor: i.requester.actor,
		organizationId: i.organizationId,
		projectId: i.projectId,
		resource: {
			type: "project_instruction_snapshot",
			id: i.snapshotId,
			name: `v${row?.version ?? 0}`,
		},
		metadata: {
			kind: "try_again",
			operationId: row?.pullRequestOperationId ?? null,
			branchId,
			failureCode: code,
			outcome,
		},
		ipAddress: i.requester.ipAddress,
		userAgent: i.requester.userAgent,
		requestId: i.requester.requestId,
		sessionId: i.requester.sessionId,
		correlationId: i.requester.correlationId,
	});

	// Reconcile first (spec §4.3 "Try again", §4.1 callers).
	const reconciled = await reconcileProposalFromEvidence(tx, {
		snapshotId: i.snapshotId,
		organizationId: i.organizationId,
	});
	if (reconciled.changed) {
		row = await read();
		if (!row) {
			return { kind: "not_found" };
		}
	}
	if (row.pullRequestState === "OPEN") {
		await recordAuditTx(tx, audit("open"));
		return { kind: "open", branchId, attempt: row.pullRequestAttempt };
	}
	if (row.pullRequestState !== "BLOCKED") {
		// The evidence moved it somewhere Try again does not apply.
		return { kind: "not_applicable" };
	}
	const branch = await tx.projectInstructionProposalBranch.findFirst({
		where: { id: branchId, organizationId: i.organizationId },
	});
	if (!branch || !acceptsAppends(branch)) {
		return { kind: "branch_not_accepting" };
	}
	const [order] = await tx.$queryRaw<Array<{ v: bigint }>>`
		SELECT nextval('project_instruction_proposal_intent_seq') AS "v"`;
	const sequence = branch.nextSequence;
	const pendingCommandSeq = branch.nextExecutionSeq;
	// `branch_transfer` is the one BLOCKED -> QUEUED arm with the branch and
	// assignment fence and the intent guard; the proposal stays on its branch
	// with its assignment, at the end of the queue.
	const moved = await transitionPullRequest(
		{
			snapshotId: i.snapshotId,
			organizationId: i.organizationId,
			event: "branch_transfer",
			from: ["BLOCKED"],
			expectedAttempt: row.pullRequestAttempt,
			to: "QUEUED",
			bumpAttempt: true,
			branch: { id: branchId, assignment: row.proposalAssignment },
			data: {
				proposalBranchSequence: sequence,
				proposalIntentOrder: BigInt(order?.v ?? 0),
				pendingCommand: "APPEND",
				pendingCommandSeq,
				pullRequestFailure: null,
				pullRequestNextAttemptAt: null,
			},
		},
		tx,
	);
	if (!moved.ok) {
		throw new Error("A locked proposal refused Try again");
	}
	await tx.projectInstructionProposalBranch.updateMany({
		where: { id: branchId, organizationId: i.organizationId },
		data: { nextSequence: { increment: 1 } },
	});
	await recordAuditTx(tx, audit("queued"));
	return {
		kind: "queued",
		branchId,
		attempt: moved.attempt,
		sequence,
		pendingCommandSeq,
	};
}

export type ProposeAgainResult =
	| JoinResult
	| { kind: "not_found" }
	/** Not terminal, withdrawn, not on a branch, or its membership was proved. */
	| { kind: "not_applicable" };

/**
 * Propose again (spec Decision 14, §4.3): a terminal proposal whose change
 * Fabric could not confirm was in the pull request (`membership:
 * unverified`) and whose submission intent holds, by its author. It is
 * transferred to the member's accepting branch as QUEUED with a new
 * `intentOrder` and a new assignment (`transferProposal`), to be appended
 * there again from Fabric's content. Nothing is ever resubmitted
 * automatically. One `pull_request_retry_requested` row records it.
 *
 * One transaction: eligibility is decided again under the transfer's locks
 * (the old branch, the proposal's operations on it, the proposal), so a late
 * recovery or classification that proved the change (or left it unproved
 * but no longer `unverified`) refuses the command instead of re-queueing an
 * established change; and the audit row commits with the transfer or not at
 * all. The read before it only answers the common refusals early.
 */
export async function proposeBranchProposalAgain(i: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	proposerUserId: string;
	naming: ProposalBranchNaming;
	requester: BranchCommandRequester;
}): Promise<ProposeAgainResult> {
	const row = await db.projectInstructionSnapshot.findFirst({
		where: {
			id: i.snapshotId,
			projectId: i.projectId,
			organizationId: i.organizationId,
			userId: i.proposerUserId,
		},
		select: {
			id: true,
			pullRequestState: true,
			withdrawRequestedAt: true,
			proposalBranchId: true,
		},
	});
	if (!row) {
		return { kind: "not_found" };
	}
	if (
		row.proposalBranchId === null ||
		row.withdrawRequestedAt !== null ||
		!isTerminalPullRequestState(row.pullRequestState)
	) {
		return { kind: "not_applicable" };
	}
	const attachment = (
		await readProposalBranchAttachments({
			organizationId: i.organizationId,
			snapshotIds: [i.snapshotId],
		})
	).get(i.snapshotId);
	if (
		!attachment ||
		proposalAppendSummary(attachment).membership !== "unverified"
	) {
		return { kind: "not_applicable" };
	}
	const fromBranchId = row.proposalBranchId;
	return transferProposal({
		snapshotId: i.snapshotId,
		organizationId: i.organizationId,
		expectedBranchId: fromBranchId,
		newIntentOrder: true,
		naming: i.naming,
		admit: (a) =>
			proposalAppendSummary({
				branch: a.branch,
				assignment: a.proposal.proposalAssignment,
				failure: a.proposal.pullRequestFailure,
				ops: a.ops,
			}).membership === "unverified",
		onTransferred: async (tx, { proposal, result }) => {
			if (result.kind !== "joined" && result.kind !== "already") {
				return;
			}
			await recordAuditTx(tx, {
				action: "project.instructions.pull_request_retry_requested",
				category: "project",
				actor: i.requester.actor,
				organizationId: i.organizationId,
				projectId: i.projectId,
				resource: {
					type: "project_instruction_snapshot",
					id: i.snapshotId,
					name: `v${proposal.version}`,
				},
				metadata: {
					kind: "propose_again",
					operationId: proposal.pullRequestOperationId,
					fromBranchId,
					branchId: result.branchId,
					stateBefore: proposal.pullRequestState,
				},
				ipAddress: i.requester.ipAddress,
				userAgent: i.requester.userAgent,
				requestId: i.requester.requestId,
				sessionId: i.requester.sessionId,
				correlationId: i.requester.correlationId,
			});
		},
	});
}
