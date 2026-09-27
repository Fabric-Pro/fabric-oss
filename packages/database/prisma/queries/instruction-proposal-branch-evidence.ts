/**
 * Member proposal branches: the evidence predicates and the one reducer that
 * derives a proposal's lifecycle from its journal (Fizzy #2738 spec §4.1
 * "Shared predicates", "Current submission", "Submission intent", "Pending
 * command" and `reconcileProposalFromEvidence`).
 *
 * Journal facts (an operation's outcome) are written whenever they arrive,
 * conditional only on the operation's identity. Lifecycle is never written
 * from a fact directly: every writer of an outcome runs
 * `reconcileProposalFromEvidence` in the same transaction, and that function
 * applies the first matching row of the spec's table (rows 1-9, in order) to
 * the proposal's CURRENT submission only. A late fact about an older
 * operation therefore never regresses lifecycle.
 *
 * The pure half (`reduceProposalLifecycle` and the predicates) is what every
 * caller shares; the transactional half applies it through
 * `transitionPullRequest` with the `branch_evidence` event, so the write is an
 * encoded transition like every other (#2563 §4.4).
 */
import type { Prisma } from "../client";
import type { ProjectInstructionPullRequestState } from "../generated/client";
import type { RecordAuditInput } from "./audit-log";
import {
	type InstructionPullRequestFailureCode,
	type PullRequestFailure,
	type PullRequestPhase,
	transitionPullRequest,
} from "./instruction-proposal-pull-requests";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** An operation's outcome; `null` is issued with no outcome yet (spec §4.1). */
export type OpOutcome = "acked" | "observed" | "not_pushed" | "unknown" | null;

export const OPERATION_OUTCOMES = [
	"acked",
	"observed",
	"not_pushed",
	"unknown",
] as const satisfies readonly Exclude<OpOutcome, null>[];

/** What the reducer reads of one journal operation. */
export type EvidenceOp = {
	id: string;
	kind: "APPEND" | "REVERT";
	executionSeq: number;
	/** The proposal's `proposalAssignment` when the operation was issued. */
	assignment: number;
	branchId: string;
	outcome: OpOutcome;
};

/** A member command not yet satisfied (spec §4.1 "Pending command"). */
export type PendingCommand = {
	kind: "APPEND" | "WITHDRAW";
	seq: number;
} | null;

/** Submission intent: `withdrawRequestedAt` and `withdrawScope`, always as a pair. */
export type SubmissionIntent = { at: Date; scope: "change" | "branch" } | null;

/** The lifecycle columns the reducer reads and writes. */
export type ProposalLifecycle = {
	state: ProjectInstructionPullRequestState;
	failure: PullRequestFailure | null;
	intent: SubmissionIntent;
	command: PendingCommand;
};

/** The §4.1 table row that decided a reduction. */
export type ReducerRow = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

const TERMINAL_STATES: readonly ProjectInstructionPullRequestState[] = [
	"MERGED",
	"CLOSED",
	"CANCELED",
];

export function isTerminalPullRequestState(
	state: ProjectInstructionPullRequestState | null | undefined,
): boolean {
	return state !== null && state !== undefined
		? TERMINAL_STATES.includes(state)
		: false;
}

/**
 * The failures an established current append supersedes (spec §4.1 row 5:
 * "PUSH_OUTCOME_UNKNOWN, the append-phase conflict failures"). Any other
 * failure an OPEN proposal carries is failure-only and is kept.
 */
export const APPEND_PHASE_CONFLICT_CODES: readonly InstructionPullRequestFailureCode[] =
	[
		"BRANCH_CONFLICT",
		"SUPERSEDED_BY_LATER_CHANGE",
		"PUSH_OUTCOME_UNKNOWN",
		"BRANCH_MOVED",
	];

// ---------------------------------------------------------------------------
// Shared predicates (spec §4.1): one definition each, used everywhere
// ---------------------------------------------------------------------------

/** established(op): `acked` or `observed`. Drives lifecycle. */
export function isEstablished(op: Pick<EvidenceOp, "outcome">): boolean {
	return op.outcome === "acked" || op.outcome === "observed";
}

/** deletion authority(op): `acked` only. An `observed` push never proves deletion is safe. */
export function hasDeletionAuthority(op: Pick<EvidenceOp, "outcome">): boolean {
	return op.outcome === "acked";
}

type Submission = { branchId: string; assignment: number };

/** Latest by `executionSeq` first. */
function latest(ops: readonly EvidenceOp[]): EvidenceOp | null {
	let best: EvidenceOp | null = null;
	for (const op of ops) {
		if (best === null || op.executionSeq > best.executionSeq) {
			best = op;
		}
	}
	return best;
}

/** The submission's operations that can still decide anything: not `not_pushed`. */
function ofSubmission(ops: readonly EvidenceOp[], s: Submission): EvidenceOp[] {
	return ops.filter(
		(op) =>
			op.branchId === s.branchId &&
			op.assignment === s.assignment &&
			op.outcome !== "not_pushed",
	);
}

/**
 * Current append: the latest append (by `executionSeq`) issued under the
 * proposal's current assignment on its current branch and not `not_pushed`.
 */
export function currentAppend(
	ops: readonly EvidenceOp[],
	s: Submission,
): EvidenceOp | null {
	return latest(ofSubmission(ops, s).filter((op) => op.kind === "APPEND"));
}

/**
 * Current withdrawal: the latest revert issued after the current append,
 * under the same assignment, and not `not_pushed`. None without a current
 * append.
 */
export function currentWithdrawal(
	ops: readonly EvidenceOp[],
	s: Submission,
): EvidenceOp | null {
	const append = currentAppend(ops, s);
	if (append === null) {
		return null;
	}
	return latest(
		ofSubmission(ops, s).filter(
			(op) =>
				op.kind === "REVERT" && op.executionSeq > append.executionSeq,
		),
	);
}

/**
 * Whether the submission's current withdrawal is an established revert: the
 * only way a CANCELED branch proposal can still take its pull request's
 * outcome (spec Decision 14). `establishedCurrentRevertSql` in the
 * pull-request module is its SQL twin.
 */
export function hasEstablishedCurrentRevert(
	ops: readonly EvidenceOp[],
	s: Submission,
): boolean {
	const withdrawal = currentWithdrawal(ops, s);
	return withdrawal !== null && isEstablished(withdrawal);
}

/**
 * A command is satisfied once the current operation of its kind has
 * `executionSeq >= seq` (spec §4.1). Derived: a later `not_pushed` answer for
 * that operation makes the command unsatisfied again.
 */
export function commandSatisfied(
	cmd: NonNullable<PendingCommand>,
	append: EvidenceOp | null,
	withdrawal: EvidenceOp | null,
): boolean {
	const op = cmd.kind === "APPEND" ? append : withdrawal;
	return op !== null && op.executionSeq >= cmd.seq;
}

/**
 * The monotonic evidence rule (spec §4.1 "Facts versus lifecycle"): what a
 * newly reported outcome does to the recorded one. `apply` writes it, `same`
 * is a repeat (nothing to write), `refuse` would downgrade evidence.
 *
 * - issued (null) may take any outcome; `not_pushed` only from there, because
 *   it is the push command's own definitive answer;
 * - `unknown` may become `observed` or `acked`;
 * - `observed` may become `acked`;
 * - an established outcome never becomes `unknown` or `not_pushed`, and
 *   `not_pushed` never changes.
 */
export function outcomeTransition(
	recorded: OpOutcome,
	reported: Exclude<OpOutcome, null>,
): "apply" | "same" | "refuse" {
	if (recorded === reported) {
		return "same";
	}
	switch (recorded) {
		case null:
			return "apply";
		case "unknown":
			return reported === "observed" || reported === "acked"
				? "apply"
				: "refuse";
		case "observed":
			return reported === "acked" ? "apply" : "refuse";
		default:
			return "refuse";
	}
}

/**
 * accepts appends(branch): not terminal, not `CLOSE_REQUESTED`, not retired,
 * not `untracked`, and its failure is not `ATTRIBUTION_REJECTED` or
 * `REPOSITORY_CHANGED`. A BLOCKED branch that is not retired still accepts.
 */
export function acceptsAppends(branch: {
	state: string;
	retiredAt: Date | null;
	untracked: boolean;
	failure: unknown;
}): boolean {
	if (
		branch.state === "MERGED" ||
		branch.state === "CLOSED" ||
		branch.state === "CANCELED" ||
		branch.state === "CLOSE_REQUESTED"
	) {
		return false;
	}
	if (branch.retiredAt !== null || branch.untracked) {
		return false;
	}
	const code = failureCodeOf(branch.failure);
	return code !== "ATTRIBUTION_REJECTED" && code !== "REPOSITORY_CHANGED";
}

/**
 * live(proposal): not terminal, no `withdrawRequestedAt`, and either an
 * established unreverted append (current append established, current
 * withdrawal not established) or a state of `QUEUED`, `OPENING` or retryable
 * `BLOCKED`.
 */
export function isLiveProposal(p: {
	state: ProjectInstructionPullRequestState | null;
	failure: unknown;
	withdrawRequestedAt: Date | null;
	ops: readonly EvidenceOp[];
	branchId: string | null;
	assignment: number;
}): boolean {
	if (
		p.state === null ||
		isTerminalPullRequestState(p.state) ||
		p.withdrawRequestedAt !== null
	) {
		return false;
	}
	if (p.branchId !== null) {
		const s = { branchId: p.branchId, assignment: p.assignment };
		const append = currentAppend(p.ops, s);
		if (append !== null && isEstablished(append)) {
			const withdrawal = currentWithdrawal(p.ops, s);
			if (withdrawal === null || !isEstablished(withdrawal)) {
				return true;
			}
		}
	}
	return (
		p.state === "QUEUED" ||
		p.state === "OPENING" ||
		(p.state === "BLOCKED" && failureRetryableOf(p.failure) === true)
	);
}

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

// ---------------------------------------------------------------------------
// The reducer (spec §4.1 table, rows 1-9 in order)
// ---------------------------------------------------------------------------

function sameFailure(
	a: PullRequestFailure | null,
	b: PullRequestFailure | null,
): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	return canonicalJson(a) === canonicalJson(b);
}

/** JSON with sorted keys, so a value read back from Postgres compares equal. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
		return `{${entries
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sameLifecycle(
	a: ProposalLifecycle,
	b: ProposalLifecycle,
): boolean {
	return (
		a.state === b.state &&
		sameFailure(a.failure, b.failure) &&
		(a.intent === null || b.intent === null
			? a.intent === b.intent
			: a.intent.scope === b.intent.scope &&
				a.intent.at.getTime() === b.intent.at.getTime()) &&
		(a.command === null || b.command === null
			? a.command === b.command
			: a.command.kind === b.command.kind &&
				a.command.seq === b.command.seq)
	);
}

/**
 * The failure `code` a row requires: the current one when it already is that
 * non-retryable code (so a repeated reduction writes nothing and bumps
 * nothing), otherwise a new one stamped `now`.
 */
function requiredFailure(
	current: PullRequestFailure | null,
	code: "PUSH_OUTCOME_UNKNOWN" | "WITHDRAW_OUTCOME_UNKNOWN",
	phase: PullRequestPhase,
	now: Date,
): PullRequestFailure {
	if (current !== null && current.code === code && !current.retryable) {
		return current;
	}
	return { phase, code, retryable: false, at: now.toISOString(), params: {} };
}

/**
 * Applies the first matching §4.1 row to the proposal's current submission
 * (`branchId`, `assignment`). `changed` is false whenever `next` equals
 * `current`, and a terminal proposal is never changed (the fence contract).
 *
 * | # | Current append | Current withdrawal, pending command | Lifecycle |
 * |---|---|---|---|
 * | 1 | established | established | CANCELED; the command is complete |
 * | 2 | established | unsatisfied WITHDRAW | CLOSE_REQUESTED |
 * | 3 | established | issued, no outcome | CLOSE_REQUESTED |
 * | 4 | established | unknown | OPEN + WITHDRAW_OUTCOME_UNKNOWN; a `change` intent and the command cleared, a `branch` intent kept |
 * | 5 | established | none | OPEN; clears PUSH_OUTCOME_UNKNOWN, the append-phase conflict failures and the command |
 * | 6 | unknown | unsatisfied APPEND | unchanged |
 * | 7 | unknown | otherwise | BLOCKED PUSH_OUTCOME_UNKNOWN (non-retryable) |
 * | 8 | issued, no outcome | — | unchanged |
 * | 9 | none | — | unchanged |
 */
export function reduceProposalLifecycle(input: {
	current: ProposalLifecycle;
	ops: readonly EvidenceOp[];
	branchId: string;
	assignment: number;
	now: Date;
}): { row: ReducerRow; next: ProposalLifecycle; changed: boolean } {
	const { current, now } = input;
	const s = { branchId: input.branchId, assignment: input.assignment };
	const append = currentAppend(input.ops, s);
	const withdrawal = append === null ? null : currentWithdrawal(input.ops, s);
	const cmd = current.command;
	const unsatisfied = (kind: "APPEND" | "WITHDRAW") =>
		cmd !== null &&
		cmd.kind === kind &&
		!commandSatisfied(cmd, append, withdrawal);

	let row: ReducerRow;
	let next: ProposalLifecycle;
	if (append !== null && isEstablished(append)) {
		if (withdrawal !== null && isEstablished(withdrawal)) {
			// Row 1: established withdrawal evidence completes any WITHDRAW
			// command, including a withdraw-again whose own revert never ran.
			// The withdrawal happened, so the intent is kept; a terminal
			// proposal carries no failure and no command.
			row = 1;
			next = {
				state: "CANCELED",
				failure: null,
				intent: current.intent,
				command: null,
			};
		} else if (unsatisfied("WITHDRAW")) {
			// Row 2: the accepted request still awaits its own revert,
			// whatever older withdrawal is current.
			row = 2;
			next = { ...current, state: "CLOSE_REQUESTED" };
		} else if (withdrawal !== null && withdrawal.outcome === null) {
			// Row 3: a revert is issued and not yet answered.
			row = 3;
			next = { ...current, state: "CLOSE_REQUESTED" };
		} else if (withdrawal !== null && withdrawal.outcome === "unknown") {
			// Row 4: a `branch` intent is newer (closeBranch replaced the
			// change intent) and is carried out by branch settlement.
			row = 4;
			next = {
				state: "OPEN",
				failure: requiredFailure(
					current.failure,
					"WITHDRAW_OUTCOME_UNKNOWN",
					"revert",
					now,
				),
				intent:
					current.intent?.scope === "branch" ? current.intent : null,
				command: null,
			};
		} else {
			// Row 5: no current withdrawal and no unsatisfied WITHDRAW.
			row = 5;
			const code = current.failure?.code;
			next = {
				state: "OPEN",
				failure:
					code !== undefined &&
					APPEND_PHASE_CONFLICT_CODES.includes(code)
						? null
						: current.failure,
				intent: current.intent,
				command: null,
			};
		}
	} else if (append !== null && append.outcome === "unknown") {
		if (unsatisfied("APPEND")) {
			// Row 6: the member's queued retry stands.
			row = 6;
			next = current;
		} else {
			row = 7;
			next = {
				...current,
				state: "BLOCKED",
				failure: requiredFailure(
					current.failure,
					"PUSH_OUTCOME_UNKNOWN",
					"append",
					now,
				),
			};
		}
	} else if (append !== null) {
		// Row 8: issued, no outcome: recovery resolves it first.
		row = 8;
		next = current;
	} else {
		// Row 9: not yet appended.
		row = 9;
		next = current;
	}
	if (isTerminalPullRequestState(current.state)) {
		return { row, next: current, changed: false };
	}
	const changed = !sameLifecycle(next, current);
	return { row, next: changed ? next : current, changed };
}

// ---------------------------------------------------------------------------
// The transactional wrapper
// ---------------------------------------------------------------------------

type LockedProposal = {
	id: string;
	projectId: string;
	version: number;
	pullRequestOperationId: string | null;
	state: ProjectInstructionPullRequestState | null;
	attempt: number;
	failure: PullRequestFailure | null;
	withdrawRequestedAt: Date | null;
	withdrawScope: string | null;
	pendingCommand: string | null;
	pendingCommandSeq: number | null;
	proposalBranchId: string | null;
	proposalAssignment: number;
	databaseNow: Date;
};

/** The lifecycle as the row holds it. The CHECKs keep both pairs whole. */
export function lifecycleOfRow(row: {
	state: ProjectInstructionPullRequestState;
	failure: unknown;
	withdrawRequestedAt: Date | null;
	withdrawScope: string | null;
	pendingCommand: string | null;
	pendingCommandSeq: number | null;
}): ProposalLifecycle {
	const scope = row.withdrawScope;
	const kind = row.pendingCommand;
	return {
		state: row.state,
		failure: (row.failure as PullRequestFailure | null) ?? null,
		intent:
			row.withdrawRequestedAt !== null &&
			(scope === "change" || scope === "branch")
				? { at: row.withdrawRequestedAt, scope }
				: null,
		command:
			(kind === "APPEND" || kind === "WITHDRAW") &&
			row.pendingCommandSeq !== null
				? { kind, seq: Number(row.pendingCommandSeq) }
				: null,
	};
}

/** The columns a lifecycle is written as: every pair set or cleared together. */
export function lifecycleColumns(next: ProposalLifecycle): {
	pullRequestFailure: Prisma.InputJsonValue | null;
	withdrawRequestedAt: Date | null;
	withdrawScope: string | null;
	pendingCommand: string | null;
	pendingCommandSeq: number | null;
} {
	return {
		pullRequestFailure:
			next.failure === null
				? null
				: (next.failure as unknown as Prisma.InputJsonValue),
		withdrawRequestedAt: next.intent?.at ?? null,
		withdrawScope: next.intent?.scope ?? null,
		pendingCommand: next.command?.kind ?? null,
		pendingCommandSeq: next.command?.seq ?? null,
	};
}

/** `pull_request_reconciled` for a proposal the evidence made CANCELED. */
function withdrawnAudit(
	row: LockedProposal,
	organizationId: string,
	branchId: string,
): RecordAuditInput {
	return {
		action: "project.instructions.pull_request_reconciled",
		category: "project",
		actor: { type: "system" },
		organizationId,
		projectId: row.projectId,
		resource: {
			type: "project_instruction_snapshot",
			id: row.id,
			name: `v${row.version}`,
		},
		metadata: {
			outcome: "canceled",
			operationId: row.pullRequestOperationId,
			branchId,
			targetMismatch: false,
		},
	};
}

/**
 * `reconcileProposalFromEvidence` (spec §4.1): re-derives the proposal's
 * lifecycle from its current submission's journal and writes it only when it
 * changed. Run in the same transaction as every change of any of the
 * proposal's operation outcomes, and before a lease-retry restart, an
 * all-no-op finalization, Try again and withdraw-again.
 *
 * Callers take the §4.7 lock order: the branch row, then this proposal,
 * which this function locks `FOR UPDATE` itself. Every outcome writer runs
 * this under that proposal lock after its own write, so the operations read
 * here are the ones the write is decided on.
 *
 * Fence contract: the write is conditional on the proposal's current
 * `proposalBranchId` and `proposalAssignment` (the operations read are that
 * submission's), on a non-terminal state and on the attempt read under the
 * lock. It deliberately does not take the issuing activity's attempt,
 * because it applies facts. Only an actual lifecycle change bumps
 * `pullRequestAttempt`, which invalidates any in-flight claim holder; an
 * unchanged reduction writes nothing. A caller inside a claim proceeds under
 * its claim when `changed` is false and stops when it is true.
 */
export async function reconcileProposalFromEvidence(
	tx: Prisma.TransactionClient,
	i: { snapshotId: string; organizationId: string },
): Promise<{ changed: boolean; row: ReducerRow; attempt: number }> {
	const [row] = await tx.$queryRaw<LockedProposal[]>`
		SELECT "id", "projectId", "version", "pullRequestOperationId",
			"pullRequestState"::text AS "state", "pullRequestAttempt" AS "attempt",
			"pullRequestFailure" AS "failure", "withdrawRequestedAt", "withdrawScope",
			"pendingCommand", "pendingCommandSeq", "proposalBranchId", "proposalAssignment",
			(now() AT TIME ZONE 'UTC') AS "databaseNow"
		FROM "project_instruction_snapshot"
		WHERE "id" = ${i.snapshotId} AND "organizationId" = ${i.organizationId}
		FOR UPDATE`;
	if (!row) {
		return { changed: false, row: 9, attempt: 0 };
	}
	const attempt = Number(row.attempt);
	if (row.proposalBranchId === null || row.state === null) {
		return { changed: false, row: 9, attempt };
	}
	const branchId = row.proposalBranchId;
	const assignment = Number(row.proposalAssignment);
	const ops = await tx.projectInstructionProposalBranchOperation.findMany({
		where: {
			organizationId: i.organizationId,
			branchId,
			snapshotId: i.snapshotId,
		},
		select: {
			id: true,
			kind: true,
			executionSeq: true,
			assignment: true,
			branchId: true,
			outcome: true,
		},
	});
	const current = lifecycleOfRow({ ...row, state: row.state });
	const result = reduceProposalLifecycle({
		current,
		ops: ops.map((op) => ({ ...op, outcome: op.outcome as OpOutcome })),
		branchId,
		assignment,
		now: row.databaseNow,
	});
	if (!result.changed) {
		return { changed: false, row: result.row, attempt };
	}
	const next = result.next;
	const moved = await transitionPullRequest(
		{
			snapshotId: i.snapshotId,
			organizationId: i.organizationId,
			event: "branch_evidence",
			from: [row.state],
			// The attempt read under this transaction's row lock, not the
			// issuing activity's: facts are not claim-fenced.
			expectedAttempt: attempt,
			to: next.state === row.state ? "unchanged" : next.state,
			bumpAttempt: true,
			branch: { id: branchId, assignment },
			data: lifecycleColumns(next),
			audit:
				next.state === "CANCELED"
					? withdrawnAudit(row, i.organizationId, branchId)
					: undefined,
		},
		tx,
	);
	if (!moved.ok) {
		// Unreachable under the row lock unless the row is not a v2 branch
		// proposal. The fact the caller wrote must stand either way, so this
		// is "no lifecycle change", never a throw that would roll it back.
		return { changed: false, row: result.row, attempt };
	}
	return { changed: true, row: result.row, attempt: moved.attempt };
}
