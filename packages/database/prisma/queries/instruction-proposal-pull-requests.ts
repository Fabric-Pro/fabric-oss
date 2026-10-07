/**
 * Coding Instructions proposal pull requests: the state mapping, the
 * per-branch attempt records and every fenced transition (Fizzy #2563 spec
 * §4.1 to §4.4).
 *
 * A REPOSITORY proposal's delivery is `pullRequestState`; `proposalStatus` is
 * DERIVED from it by `proposalStatusForPullRequestState` and every transition
 * writes both columns or neither. Each transition is one conditional
 * `UPDATE ... WHERE id AND organizationId AND pullRequestState IN (<allowed>)
 * [AND pullRequestAttempt = <expected>]`: zero rows means another actor moved
 * first, and the caller treats that as an answer, not an error. The allowed
 * (event, from, to) combinations are the spec's §4.4 table, encoded once in
 * `PULL_REQUEST_TRANSITIONS`; asking for any other combination throws,
 * because it is a programming error rather than a race.
 *
 * Attempt records (`pullRequestAttempts`, one per branch) are identified by
 * `(attempt, ref)`. #2563's per-proposal path wrote them, with the two
 * summary columns (`pullRequestObligationOpen`,
 * `pullRequestConfirmationDueAt`) from `summarizeAttempts` in the same
 * transaction (plan Decision 1). That path was retired (Fizzy #2748) and
 * nothing writes a record now; a historical row still carries them, and
 * retention still reads the summary columns. Member proposal branches
 * (Fizzy #2738) record their pushes in the branch journal instead.
 */
import { db, Prisma } from "../client";
import type { ProjectInstructionPullRequestState } from "../generated/client";
import {
	type AuditAction,
	type RecordAuditInput,
	recordAuditTx,
} from "./audit-log";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The typed failure codes of spec §11. Copy comes from `en.json` by code. */
export const INSTRUCTION_PULL_REQUEST_FAILURE_CODES = [
	"VALIDATION_REJECTED",
	"VALIDATION_FAILED",
	"VALIDATION_TIMEOUT",
	"ATTRIBUTION_REJECTED",
	"PERMISSION_REVOKED",
	"CONFIGURATION_CHANGED",
	"TARGET_BRANCH_MISSING",
	"BASE_COMMIT_UNAVAILABLE",
	"TREE_CONFLICT",
	"AUTHENTICATION_FAILED",
	"REPOSITORY_UNAVAILABLE",
	"BRANCH_WRITE_REFUSED",
	"PR_CREATION_REFUSED",
	"REMOTE_REF_CONFLICT",
	"LOOKUP_INCONCLUSIVE",
	"CREATE_OUTCOME_UNKNOWN",
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_TEMPORARY",
	"CLOSE_REFUSED",
	"CLOSE_CREDENTIALS_UNAVAILABLE",
	"STORAGE_FAILED",
	"GIT_FAILED",
	"LIMITS_EXCEEDED",
	"SYNC_START_FAILED",
	"MERGE_SYNC_FAILED",
	"UNEXPECTED",
	// Member proposal branches (Fizzy #2738 spec §9). ATTRIBUTION_REJECTED and
	// CONFIGURATION_CHANGED above are reused.
	"BRANCH_CONFLICT",
	"SUPERSEDED_BY_LATER_CHANGE",
	"BRANCH_MOVED",
	"BRANCH_NAME_UNAVAILABLE",
	"WITHDRAW_CONFLICT",
	"WITHDRAW_BLOCKED_BY_LATER_CHANGE",
	"REPOSITORY_CHANGED",
	"ALREADY_ON_BRANCH",
	"PUSH_OUTCOME_UNKNOWN",
	"WITHDRAW_OUTCOME_UNKNOWN",
	"START_OVER_REFUSED",
	"BRANCH_MISSING",
] as const;

export type InstructionPullRequestFailureCode =
	(typeof INSTRUCTION_PULL_REQUEST_FAILURE_CODES)[number];

export type PullRequestPhase =
	| "admission"
	| "validation"
	| "recover"
	| "prepare"
	| "push"
	| "create"
	| "reconcile"
	| "close"
	| "merge_sync"
	// Member proposal branches (Fizzy #2738 spec §9): a branch proposal's
	// append to, or revert from, its member's branch.
	| "append"
	| "revert";

/** `pullRequestFailure`. `params` holds safe values only (counts, branch, delay, phase). */
export type PullRequestFailure = {
	phase: PullRequestPhase;
	code: InstructionPullRequestFailureCode;
	retryable: boolean;
	/** ISO 8601. */
	at: string;
	params: Record<string, string | number | boolean>;
};

/**
 * One element of `pullRequestAttempts`: one branch Fabric pushed, or is
 * about to push (spec §4.1). `pushIssuedAt` is absent on a record appended
 * before its push was issued (a retry's re-issue).
 */
export type PullRequestAttemptRecord = {
	attempt: number;
	ref: string;
	sha: string;
	pushIssuedAt?: string;
	pushAckedAt?: string;
	/** The create marker. */
	createIssuedAt?: string;
	settledAt?: string;
	confirmations: number;
	outcome?: "opened" | "push_unknown_absent" | "conflict" | "settled";
};

export type PullRequestProposalStatus =
	| "PENDING"
	| "MERGED"
	| "CLOSED"
	| "REJECTED";

/** The one mapping from delivery state to proposal status (spec §4.2). */
export function proposalStatusForPullRequestState(
	s: ProjectInstructionPullRequestState,
): PullRequestProposalStatus {
	switch (s) {
		case "QUEUED":
		case "OPENING":
		case "OPEN":
		case "CLOSE_REQUESTED":
		case "BLOCKED":
			return "PENDING";
		case "MERGED":
			return "MERGED";
		case "CLOSED":
			return "CLOSED";
		case "CANCELED":
			return "REJECTED";
		default:
			return unknownState(s);
	}
}

function unknownState(s: never): never {
	throw new Error(`Unknown pull-request state: ${String(s)}`);
}

// ---------------------------------------------------------------------------
// Attempt records
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * A record still owes work (spec §4.1): an issued create not yet resolved,
 * a settlement awaiting its two confirmations, or a push issued without an
 * acknowledgment or an outcome (ownership unknown).
 */
export function hasOutstandingObligation(r: PullRequestAttemptRecord): boolean {
	if (r.createIssuedAt) {
		return true;
	}
	if (r.settledAt && r.confirmations < 2) {
		return true;
	}
	return Boolean(r.pushIssuedAt && !r.pushAckedAt && !r.outcome);
}

/** When a settled record's next confirmation is due: 1 h, then 24 h, after `settledAt`. */
function confirmationDueAt(r: PullRequestAttemptRecord): number | null {
	if (!r.settledAt || r.confirmations >= 2) {
		return null;
	}
	const settled = Date.parse(r.settledAt);
	if (Number.isNaN(settled)) {
		return null;
	}
	return settled + (r.confirmations === 0 ? HOUR_MS : 24 * HOUR_MS);
}

/** The two maintained summary columns (plan Decision 1). */
export function summarizeAttempts(rs: readonly PullRequestAttemptRecord[]): {
	obligationOpen: boolean;
	confirmationDueAt: Date | null;
} {
	let due: number | null = null;
	for (const r of rs) {
		const at = confirmationDueAt(r);
		if (at !== null && (due === null || at < due)) {
			due = at;
		}
	}
	return {
		obligationOpen: rs.some(hasOutstandingObligation),
		confirmationDueAt: due === null ? null : new Date(due),
	};
}

/** Create recovery backoff while the marker stands: 1, 5, 15, 60 min, then hourly (spec §6.1). */
const CREATE_RECOVERY_BACKOFF_MS = [1, 5, 15, 60].map((m) => m * MINUTE_MS);
/** Merge-sync dispatch backoff: 5, 15, then 60 min (spec §9.1 step 4). */
const MERGE_SYNC_BACKOFF_MS = [5, 15, 60].map((m) => m * MINUTE_MS);

/**
 * The delay before the next automatic attempt (spec §11 and Global
 * Constraints), or null when the code is never retried automatically: a
 * human must act (Retry opening, reconnect and submit again) or the outcome
 * is final. `CREATE_OUTCOME_UNKNOWN` becomes null 24 h after its marker.
 */
export function nextRetryDelayMs(
	code: InstructionPullRequestFailureCode,
	ctx: {
		retryAfterSeconds?: number;
		markerAgeMs?: number;
		recoveries?: number;
	},
): number | null {
	const step = (schedule: readonly number[]) =>
		schedule[
			Math.min(Math.max(ctx.recoveries ?? 0, 0), schedule.length - 1)
		];
	switch (code) {
		case "PROVIDER_RATE_LIMITED":
			return ctx.retryAfterSeconds !== undefined &&
				Number.isFinite(ctx.retryAfterSeconds) &&
				ctx.retryAfterSeconds > 0
				? Math.ceil(ctx.retryAfterSeconds * 1000)
				: 15 * MINUTE_MS;
		case "CREATE_OUTCOME_UNKNOWN":
			if ((ctx.markerAgeMs ?? 0) >= 24 * HOUR_MS) {
				return null;
			}
			return step(CREATE_RECOVERY_BACKOFF_MS);
		case "VALIDATION_TIMEOUT":
			return HOUR_MS;
		case "AUTHENTICATION_FAILED":
		case "CLOSE_CREDENTIALS_UNAVAILABLE":
		case "REPOSITORY_UNAVAILABLE":
		case "BRANCH_WRITE_REFUSED":
		case "CLOSE_REFUSED":
		case "REMOTE_REF_CONFLICT":
			return 6 * HOUR_MS;
		case "SYNC_START_FAILED":
			return step(MERGE_SYNC_BACKOFF_MS);
		case "PROVIDER_TEMPORARY":
		case "UNEXPECTED":
		case "LOOKUP_INCONCLUSIVE":
		case "VALIDATION_FAILED":
		case "STORAGE_FAILED":
		case "GIT_FAILED":
		case "LIMITS_EXCEEDED":
		// The only retryable member-branch code (spec §9): the branch kept
		// moving under the lease, so the append or revert is tried again.
		case "BRANCH_MOVED":
			return 15 * MINUTE_MS;
		case "VALIDATION_REJECTED":
		case "ATTRIBUTION_REJECTED":
		case "PERMISSION_REVOKED":
		case "CONFIGURATION_CHANGED":
		case "TARGET_BRANCH_MISSING":
		case "BASE_COMMIT_UNAVAILABLE":
		case "TREE_CONFLICT":
		case "PR_CREATION_REFUSED":
		case "MERGE_SYNC_FAILED":
		// Member proposal branches (spec §9): a person acts (Try again, Stop
		// tracking, withdraw again) or the code is informational.
		case "BRANCH_CONFLICT":
		case "SUPERSEDED_BY_LATER_CHANGE":
		case "BRANCH_NAME_UNAVAILABLE":
		case "WITHDRAW_CONFLICT":
		case "WITHDRAW_BLOCKED_BY_LATER_CHANGE":
		case "REPOSITORY_CHANGED":
		case "ALREADY_ON_BRANCH":
		case "PUSH_OUTCOME_UNKNOWN":
		case "WITHDRAW_OUTCOME_UNKNOWN":
		case "START_OVER_REFUSED":
		case "BRANCH_MISSING":
			return null;
		default:
			return unknownCode(code);
	}
}

function unknownCode(code: never): never {
	throw new Error(`Unknown pull-request failure code: ${String(code)}`);
}

// ---------------------------------------------------------------------------
// Transitions (spec §4.4)
// ---------------------------------------------------------------------------

/**
 * The events a transition may name. The #2563 events only its retired
 * per-proposal path wrote (claim, adopt, receipt, create_unknown_expired,
 * retry, reissue, cancel_pre_create, cancel_later, settled, confirmation,
 * settle_blocked, observe, merge_sync_acknowledged, merge_sync_given_up,
 * restart_deferred) went with it (Fizzy #2748). Each one below still has a
 * writer: readiness, validation and abandonment, an activity's failure, and
 * a member branch's unknown push outcome.
 */
export type PullRequestEvent =
	| "validation_ready"
	| "validation_failed"
	| "validation_rejected"
	| "abandoned"
	| "deadline"
	| "open_failure"
	| "failure"
	| "push_unknown"
	// Member proposal branches (Fizzy #2738 spec §4.3), v2 rows only.
	| BranchPullRequestEvent;

/**
 * The member proposal branch events (Fizzy #2738 spec §4.3). Every arm of
 * every one of them requires a v2 `pullRequestContext`, so a #2563 row
 * (`v = 1`) never matches one and keeps its §4.4 table unchanged
 * (spec Decision 4).
 */
export const BRANCH_PULL_REQUEST_EVENTS = [
	/** Join (spec §5 step 5): QUEUED, no branch, keeps QUEUED. */
	"branch_join",
	/** Stale destination (spec §5 step 2): BLOCKED CONFIGURATION_CHANGED. */
	"branch_stale_destination",
	/** Transfer (rehome, start over, Propose again): QUEUED on another branch. */
	"branch_transfer",
	/** Claim (spec §6.1): OPENING at a new attempt. */
	"branch_claim",
	/** Evidence reconciliation (spec §4.1): `reconcileProposalFromEvidence`. */
	"branch_evidence",
	/** Stop tracking (spec Decision 19): CANCELED REPOSITORY_CHANGED. */
	"branch_stop_tracking",
	/**
	 * The member's withdrawal (spec §4.3 "Withdraw" rows, §6.8 request):
	 * not appended -> CANCELED; appended -> CLOSE_REQUESTED with a WITHDRAW
	 * command; the last live change keeps OPEN with a `branch` intent.
	 */
	"branch_withdraw",
	/**
	 * Classification and settlement (spec §4.3 "Classification" and "Branch
	 * settled", §6.6 step 3, §6.7 step 4): a non-terminal proposal takes the
	 * pull request's outcome, or CANCELED when both its append and its
	 * revert were included, when it was withdrawn before any append, or when
	 * no pull request existed.
	 */
	"branch_settled",
] as const;

export type BranchPullRequestEvent =
	(typeof BRANCH_PULL_REQUEST_EVENTS)[number];

type JsonColumn =
	| "pullRequestFailure"
	| "pullRequestObservation"
	| "mergeSyncExpected";

/**
 * The columns a transition may write besides the two status columns and the
 * attempt. The three JSON columns also take a plain `null`, which
 * `transitionPullRequest` writes as SQL NULL, so a caller outside this
 * package (the Temporal activities) clears one without Prisma's sentinels.
 */
export type PullRequestColumns = Partial<
	Pick<
		Prisma.ProjectInstructionSnapshotUncheckedUpdateInput,
		| "pullRequestNextAttemptAt"
		| "pullRequestLastCheckedAt"
		| "pullRequestUrl"
		| "pullRequestExternalId"
		| "pullRequestHeadSha"
		| "pullRequestRef"
		| "mergeSyncRequestedAt"
		| "mergeSyncDispatchedAt"
		| "mergeSyncRunId"
		// Member proposal branches (Fizzy #2738 spec §4.1): the branch
		// assignment, submission intent and pending command. The CHECKs keep
		// each pair set or cleared together.
		| "proposalBranchId"
		| "proposalBranchSequence"
		| "proposalAssignment"
		| "proposalIntentOrder"
		| "withdrawRequestedAt"
		| "withdrawScope"
		| "pendingCommand"
		| "pendingCommandSeq"
	>
> & {
	[K in JsonColumn]?:
		| Prisma.ProjectInstructionSnapshotUncheckedUpdateInput[K]
		| null;
};

/** `PullRequestColumns` as Prisma takes it: a plain null becomes SQL NULL. */
function columnsForPrisma(
	data: PullRequestColumns | undefined,
): Prisma.ProjectInstructionSnapshotUncheckedUpdateManyInput {
	const out: Record<string, unknown> = { ...data };
	for (const key of [
		"pullRequestFailure",
		"pullRequestObservation",
		"mergeSyncExpected",
	] as const) {
		if (out[key] === null) {
			out[key] = Prisma.DbNull;
		}
	}
	return out as Prisma.ProjectInstructionSnapshotUncheckedUpdateManyInput;
}

type State = ProjectInstructionPullRequestState;
type Target = State | "unchanged";
type Guard = Prisma.ProjectInstructionSnapshotWhereInput;

const ALL_STATES: readonly State[] = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"MERGED",
	"CLOSED",
	"BLOCKED",
	"CANCELED",
];

type FromRule = {
	state: State;
	to: readonly Target[];
	/** Further conditions the row must meet in this state (spec §4.4 "Allowed from"). */
	guard?: Guard;
	/**
	 * The arm records a fact that is true whatever attempt owns the row, so
	 * its clause never compares `pullRequestAttempt` (spec §4.4 "not
	 * attempt-fenced"). #2563's receipt on CLOSE_REQUESTED and its settlement
	 * confirmation were the only such facts, and both were retired with that
	 * path (Fizzy #2748), so no arm sets this today. Every arm is fenced: a
	 * claim, an open failure and every other write on behalf of the current
	 * attempt must name the attempt its caller observed, so two callers
	 * holding one observation cannot both write and a stale activity cannot
	 * overwrite a newer one.
	 */
	attemptIndependent?: true;
	/**
	 * A condition a Prisma guard cannot state, checked by
	 * `transitionPullRequest` under the row lock before it writes. Only
	 * `established_current_revert` exists, on exactly one arm: `branch_settled`
	 * from CANCELED (Fizzy #2738 spec Decision 14, "a merge racing the revert
	 * is decided by classification"). The row must be CANCELED only because
	 * its current withdrawal is an established revert: the latest revert
	 * issued after its current append, under its current `proposalBranchId`
	 * and `proposalAssignment`, not `not_pushed`, and `acked` or `observed`
	 * (`hasEstablishedCurrentRevert`). No other terminal branch arm exists
	 * except `branch_transfer` to QUEUED.
	 */
	requires?: "established_current_revert";
};

/**
 * The exact audit rows a transition writes, by target (spec §4.4 "Audit",
 * §13.4): the multiset of actions, compared for equality, so nothing is
 * omitted, added or written twice. A target not listed writes none.
 */
type AuditByTarget = Partial<Record<Target, readonly AuditAction[]>>;

type TransitionRule = {
	from: readonly FromRule[];
	/** Whether the transition increments `pullRequestAttempt`. */
	bump: boolean;
	audit: AuditByTarget;
};

const failurePhaseIn = (phases: readonly PullRequestPhase[]): Guard => ({
	OR: phases.map((phase) => ({
		pullRequestFailure: { path: ["phase"], equals: phase },
	})),
});

const failureCode = (code: InstructionPullRequestFailureCode): Guard => ({
	pullRequestFailure: { path: ["code"], equals: code },
});

const failureRetryable = (retryable: boolean): Guard => ({
	pullRequestFailure: { path: ["retryable"], equals: retryable },
});

/**
 * A member proposal branch row (Fizzy #2738 spec Decision 4): its context is
 * v2. Every branch event's every arm carries it, so no #2563 row matches one.
 */
const V2_CONTEXT: Guard = { pullRequestContext: { path: ["v"], equals: 2 } };
const ON_BRANCH: Guard = {
	AND: [V2_CONTEXT, { proposalBranchId: { not: null } }],
};
const NOT_YET_JOINED: Guard = {
	AND: [V2_CONTEXT, { proposalBranchId: null }],
};
/** Submission intent holds: no withdrawal requested (spec §6.1 "with intent"). */
const NOT_WITHDRAWN: Guard = { withdrawRequestedAt: null };

/** Every non-terminal state, in table order. */
const NON_TERMINAL_STATES: readonly State[] = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"BLOCKED",
];

/**
 * The #2563 events that cancel a row "before anything was pushed or
 * created". Their guards read the #2563 columns (`pullRequestHeadSha`),
 * which a member branch proposal never writes: its pushes are journal
 * operations. So a v2 row with any journal operation would still
 * match them, and its own commit may already be on the branch.
 * `transitionPullRequest` therefore refuses these events, under the row
 * lock, for a row that has any journal operation (Fizzy #2738 spec §4.3
 * "Validation REJECTED or abandonment": QUEUED, OPENING with no journal
 * operation, BLOCKED in validation or admission). Only v2 rows have journal
 * operations, so a #2563 row is unaffected. A member's own withdrawal of a
 * v2 row is `branch_withdraw`.
 */
export const PRE_CREATE_CANCEL_EVENTS = [
	"validation_rejected",
	"abandoned",
] as const satisfies readonly PullRequestEvent[];

/** A validation verdict or abandonment cancels every pre-create state (spec §2.12). */
const PRE_CREATE_CANCEL_FROM: readonly FromRule[] = [
	{ state: "QUEUED", to: ["CANCELED"] },
	{ state: "OPENING", to: ["CANCELED"], guard: { pullRequestHeadSha: null } },
	{
		state: "BLOCKED",
		to: ["CANCELED"],
		guard: failurePhaseIn(["validation", "admission"]),
	},
];

const NO_AUDIT: AuditByTarget = {};
const RECONCILED = "project.instructions.pull_request_reconciled";
const CLOSE_REQUESTED_AUDIT =
	"project.instructions.pull_request_close_requested";

/**
 * The §4.4 table. One entry per event; each `from` rule names a state the
 * event may start from, the targets it may reach from there and any further
 * condition. `CLOSE_REQUESTED` never reaches `BLOCKED` or `OPEN`.
 */
export const PULL_REQUEST_TRANSITIONS: Readonly<
	Record<PullRequestEvent, TransitionRule>
> = {
	// Readiness: clears a VALIDATION_FAILED failure, keeps QUEUED.
	validation_ready: {
		from: [
			{
				state: "QUEUED",
				to: ["unchanged"],
				guard: failureCode("VALIDATION_FAILED"),
			},
		],
		bump: false,
		audit: NO_AUDIT,
	},
	// Readiness: a FAILED validation keeps the operation queued.
	validation_failed: {
		from: [{ state: "QUEUED", to: ["unchanged"] }],
		bump: false,
		audit: NO_AUDIT,
	},
	validation_rejected: {
		from: PRE_CREATE_CANCEL_FROM,
		bump: true,
		audit: { CANCELED: [RECONCILED] },
	},
	abandoned: {
		from: PRE_CREATE_CANCEL_FROM,
		bump: true,
		audit: { CANCELED: [RECONCILED] },
	},
	// The 6 h validation clock ran out.
	deadline: {
		from: [{ state: "QUEUED", to: ["BLOCKED"] }],
		bump: false,
		audit: NO_AUDIT,
	},
	open_failure: {
		from: [{ state: "OPENING", to: ["BLOCKED"] }],
		bump: false,
		audit: NO_AUDIT,
	},
	// Any other activity's failure is failure-only.
	failure: {
		from: ALL_STATES.map((state) => ({
			state,
			to: ["unchanged"] as const,
		})),
		bump: false,
		audit: NO_AUDIT,
	},
	push_unknown: {
		from: [
			{ state: "OPENING", to: ["unchanged", "BLOCKED"] },
			{ state: "CLOSE_REQUESTED", to: ["unchanged"] },
		],
		bump: false,
		audit: NO_AUDIT,
	},

	// -----------------------------------------------------------------------
	// Member proposal branches (Fizzy #2738 spec §4.3). v2 rows only; this
	// amends #2563 §4.4 for them: CLOSE_REQUESTED can return to OPEN
	// (evidence), and Propose again moves a terminal proposal back to QUEUED
	// (transfer). Every arm is fenced on the attempt its writer read under
	// the row lock.
	// -----------------------------------------------------------------------

	// Join (spec §5 step 5): the branch, its sequence and a new assignment
	// are written; the state stays QUEUED.
	branch_join: {
		from: [{ state: "QUEUED", to: ["unchanged"], guard: NOT_YET_JOINED }],
		bump: false,
		audit: NO_AUDIT,
	},
	// Stale destination (spec §5 step 2, Decision 15): the proposal's frozen
	// destination no longer matches the configuration. It never retires
	// anything; it is BLOCKED CONFIGURATION_CHANGED where it stands.
	branch_stale_destination: {
		from: (["QUEUED", "OPENING", "OPEN", "BLOCKED"] as const).map(
			(state) => ({
				state,
				to: ["BLOCKED"] as const,
				guard: V2_CONTEXT,
			}),
		),
		bump: true,
		audit: NO_AUDIT,
	},
	// Transfer (spec §5): rehome (QUEUED, BLOCKED), start over (any live
	// state) and Propose again (a terminal proposal with unverified
	// membership). Always QUEUED on the new branch, with a new assignment.
	branch_transfer: {
		from: (
			[
				"QUEUED",
				"OPENING",
				"OPEN",
				"BLOCKED",
				"MERGED",
				"CLOSED",
				"CANCELED",
			] as const
		).map((state) => ({
			state,
			to: ["QUEUED"] as const,
			guard: { AND: [ON_BRANCH, NOT_WITHDRAWN] },
		})),
		bump: true,
		audit: NO_AUDIT,
	},
	// Claim (spec §6.1): QUEUED, OPENING at any attempt, or a retryable
	// BLOCKED row in phase append or validation whose backoff the claim has
	// checked on the database clock under the row lock.
	branch_claim: {
		from: [
			{
				state: "QUEUED",
				to: ["OPENING"],
				guard: { AND: [ON_BRANCH, NOT_WITHDRAWN] },
			},
			{
				state: "OPENING",
				to: ["OPENING"],
				guard: { AND: [ON_BRANCH, NOT_WITHDRAWN] },
			},
			{
				state: "BLOCKED",
				to: ["OPENING"],
				guard: {
					AND: [
						ON_BRANCH,
						NOT_WITHDRAWN,
						failureRetryable(true),
						failurePhaseIn(["append", "validation"]),
					],
				},
			},
		],
		bump: true,
		audit: NO_AUDIT,
	},
	// Evidence reconciliation (spec §4.1): any non-terminal state to the
	// first matching row's lifecycle. Only `reconcileProposalFromEvidence`
	// computes the target; it also fences on the branch and assignment.
	branch_evidence: {
		from: NON_TERMINAL_STATES.map((state) => ({
			state,
			to: [
				"CANCELED",
				"CLOSE_REQUESTED",
				"OPEN",
				"BLOCKED",
				"unchanged",
			] as const,
			guard: ON_BRANCH,
		})),
		bump: true,
		audit: { CANCELED: [RECONCILED] },
	},
	// Stop tracking (spec Decision 19): every non-terminal proposal on an
	// untracked branch is CANCELED REPOSITORY_CHANGED.
	branch_stop_tracking: {
		from: NON_TERMINAL_STATES.map((state) => ({
			state,
			to: ["CANCELED"] as const,
			guard: ON_BRANCH,
		})),
		bump: true,
		audit: { CANCELED: [RECONCILED] },
	},
	// The member's withdrawal (spec §4.3, §6.8), decided by
	// `withdrawBranchProposal` under the branch and proposal locks:
	// - not appended (QUEUED, or BLOCKED without an established append;
	//   joined or not yet joined): CANCELED, intent `change`;
	// - appended (OPEN): CLOSE_REQUESTED, intent `change`, WITHDRAW command;
	// - the branch's last live change (OPEN): unchanged, intent `branch`,
	//   while the branch itself becomes CLOSE_REQUESTED (WITHDRAW).
	// Each writes one `pull_request_close_requested` row, as #2563's cancel.
	branch_withdraw: {
		from: [
			{ state: "QUEUED", to: ["CANCELED"], guard: V2_CONTEXT },
			{ state: "BLOCKED", to: ["CANCELED"], guard: V2_CONTEXT },
			{
				state: "OPEN",
				to: ["CLOSE_REQUESTED", "unchanged"],
				guard: { AND: [ON_BRANCH, NOT_WITHDRAWN] },
			},
		],
		bump: true,
		audit: {
			CANCELED: [CLOSE_REQUESTED_AUDIT],
			CLOSE_REQUESTED: [CLOSE_REQUESTED_AUDIT],
			unchanged: [CLOSE_REQUESTED_AUDIT],
		},
	},
	// Classification and settlement (spec §4.3, §6.6 step 3, §6.7 step 4),
	// decided by the branch's settlement writers under the branch and
	// proposal locks, fenced on the attempt and the branch assignment read
	// there. Each writes one `pull_request_reconciled` row.
	//
	// The one terminal arm (Decision 14's first outcome): a proposal CANCELED
	// because its revert was established takes the pull request's outcome
	// when classification finds its append included and its revert not (the
	// pull request merged or closed before the revert reached it). The
	// in-lock `established_current_revert` check keeps every other CANCELED
	// row out, and MERGED or CLOSED rows have no arm here at all.
	branch_settled: {
		from: [
			...NON_TERMINAL_STATES.map(
				(state): FromRule => ({
					state,
					to: ["MERGED", "CLOSED", "CANCELED"] as const,
					guard: ON_BRANCH,
				}),
			),
			{
				state: "CANCELED",
				to: ["MERGED", "CLOSED"],
				guard: ON_BRANCH,
				requires: "established_current_revert",
			},
		],
		bump: true,
		audit: {
			MERGED: [RECONCILED],
			CLOSED: [RECONCILED],
			CANCELED: [RECONCILED],
		},
	},
};

function fromRuleOf(
	event: PullRequestEvent,
	state: State,
	to: Target,
): FromRule {
	const match = PULL_REQUEST_TRANSITIONS[event].from.find(
		(r) => r.state === state && r.to.includes(to),
	);
	if (!match) {
		throw new Error(
			`Illegal pull-request transition: ${event} from ${state} to ${to}`,
		);
	}
	return match;
}

/**
 * The row predicate a transition's allowed-from set compiles to. Each source
 * state is its own clause, and a fenced arm's clause carries
 * `pullRequestAttempt = expectedAttempt` (spec §4.2), so the fence is decided
 * per (event, source, target), never per call. A call selecting any fenced
 * arm must name the attempt its caller observed; a call selecting only
 * attempt-independent arms must pass null, so no caller believes a fact write
 * is fenced when it is not.
 */
export function pullRequestTransitionWhere(
	event: PullRequestEvent,
	from: readonly State[],
	to: Target,
	expectedAttempt: number | null,
): Guard {
	if (from.length === 0) {
		throw new Error(
			`Pull-request transition ${event} names no source state`,
		);
	}
	const arms = from.map((state) => ({
		state,
		rule: fromRuleOf(event, state, to),
	}));
	const fenced = arms.find((a) => a.rule.attemptIndependent !== true);
	if (fenced && expectedAttempt === null) {
		throw new Error(
			`Pull-request transition ${event} from ${fenced.state} to ${to} is attempt-fenced: pass the attempt the caller observed`,
		);
	}
	if (!fenced && expectedAttempt !== null) {
		throw new Error(
			`Pull-request transition ${event} to ${to} names only attempt-independent arms: pass expectedAttempt null`,
		);
	}
	const clauses = arms.map(({ state, rule }): Guard => {
		const own: Guard =
			rule.attemptIndependent === true
				? { pullRequestState: state }
				: {
						pullRequestState: state,
						pullRequestAttempt: expectedAttempt as number,
					};
		return rule.guard ? { AND: [own, rule.guard] } : own;
	});
	const [only] = clauses;
	return clauses.length === 1 && only ? only : { OR: clauses };
}

/** Whether every arm the call selects compares the attempt. */
function allArmsFenced(
	event: PullRequestEvent,
	from: readonly State[],
	to: Target,
): boolean {
	return from.every(
		(state) => fromRuleOf(event, state, to).attemptIndependent !== true,
	);
}

function auditsOf(
	audit: RecordAuditInput | readonly RecordAuditInput[] | undefined,
): readonly RecordAuditInput[] {
	if (audit === undefined) {
		return [];
	}
	return Array.isArray(audit) ? audit : [audit as RecordAuditInput];
}

/**
 * The exact audit actions an (event, target) writes (spec §4.4, §13.4): a
 * multiset, empty when the transition writes none.
 */
export function requiredPullRequestAudits(
	event: PullRequestEvent,
	to: Target,
): readonly AuditAction[] {
	return PULL_REQUEST_TRANSITIONS[event].audit[to] ?? [];
}

function assertExactAudits(
	event: PullRequestEvent,
	to: Target,
	audits: readonly RecordAuditInput[],
): void {
	const want = [...requiredPullRequestAudits(event, to)].sort();
	const got = audits.map((a) => a.action).sort();
	if (
		want.length !== got.length ||
		want.some((action, n) => action !== got[n])
	) {
		throw new Error(
			`Pull-request transition ${event} to ${to} writes exactly [${want.join(", ")}], not [${got.join(", ")}]`,
		);
	}
}

/**
 * The stale-VALIDATING reaper (`listStaleValidatingInstructionSnapshots`)
 * reads `updatedAt` as the time a snapshot has spent validating, and Prisma's
 * `@updatedAt` stamps it on every `updateMany`. A pull-request write is not a
 * validation event, so on a snapshot still VALIDATING (a QUEUED operation
 * whose 6 h validation clock ran out, say) every writer here puts the value
 * it read under the row lock back, and the reaper's clock is left alone.
 * Every other status keeps Prisma's stamp.
 */
async function lockSnapshotClock(
	client: Prisma.TransactionClient,
	snapshotId: string,
	organizationId: string,
): Promise<{ status: string; updatedAt: Date } | null> {
	const [row] = await client.$queryRaw<
		Array<{ id: string; status?: string; updatedAt?: Date }>
	>`
		SELECT "id", "status"::text AS "status", "updatedAt"
		FROM "project_instruction_snapshot"
		WHERE "id" = ${snapshotId} AND "organizationId" = ${organizationId}
		FOR UPDATE`;
	if (!row) {
		return null;
	}
	return {
		status: row.status ?? "",
		updatedAt: row.updatedAt ?? new Date(0),
	};
}

/**
 * Whether any member-branch journal operation names this proposal (Fizzy
 * #2738 spec §4.1), on any branch it was ever assigned to. Read under the
 * proposal's row lock, which `recordBranchOperation` also takes before it
 * inserts, so the answer cannot go stale before the caller's write.
 */
async function hasJournalOperation(
	client: Prisma.TransactionClient,
	snapshotId: string,
	organizationId: string,
): Promise<boolean> {
	const [row] = await client.$queryRaw<Array<{ journaled?: unknown }>>`
		SELECT EXISTS (
			SELECT 1 FROM "project_instruction_proposal_branch_operation" o
			WHERE o."snapshotId" = ${snapshotId} AND o."organizationId" = ${organizationId}
		) AS "journaled"`;
	return row?.journaled === true;
}

/**
 * Whether the proposal's current withdrawal is an established revert under
 * its current `proposalBranchId` and `proposalAssignment` (Fizzy #2738 spec
 * §4.1): the latest REVERT issued after the latest APPEND, both not
 * `not_pushed`, with outcome `acked` or `observed`. The SQL twin of
 * `hasEstablishedCurrentRevert` in the evidence module; `s` is the snapshot
 * row. `executionSeq` is unique per branch, so the latest revert is one
 * operation.
 */
export function establishedCurrentRevertSql(): Prisma.Sql {
	return Prisma.sql`EXISTS (
	SELECT 1 FROM "project_instruction_proposal_branch_operation" r
	WHERE r."snapshotId" = s."id" AND r."organizationId" = s."organizationId"
		AND r."branchId" = s."proposalBranchId" AND r."assignment" = s."proposalAssignment"
		AND r."kind"::text = 'REVERT' AND r."outcome" IN ('acked', 'observed')
		AND r."executionSeq" = (
			SELECT max(w."executionSeq") FROM "project_instruction_proposal_branch_operation" w
			WHERE w."snapshotId" = s."id" AND w."organizationId" = s."organizationId"
				AND w."branchId" = s."proposalBranchId" AND w."assignment" = s."proposalAssignment"
				AND w."kind"::text = 'REVERT' AND w."outcome" IS DISTINCT FROM 'not_pushed'
				AND w."executionSeq" > (
					SELECT max(a."executionSeq") FROM "project_instruction_proposal_branch_operation" a
					WHERE a."snapshotId" = s."id" AND a."organizationId" = s."organizationId"
						AND a."branchId" = s."proposalBranchId" AND a."assignment" = s."proposalAssignment"
						AND a."kind"::text = 'APPEND' AND a."outcome" IS DISTINCT FROM 'not_pushed'
				)
		)
)`;
}

/**
 * The row's state and whether its current withdrawal is an established
 * revert (`establishedCurrentRevertSql`), read under the row lock. Issuing a
 * new operation (`recordBranchOperation`) takes that lock first, and an
 * established outcome never regresses (§4.1 monotonic evidence), so a true
 * answer cannot turn false before the caller's write.
 */
async function readCurrentRevert(
	client: Prisma.TransactionClient,
	snapshotId: string,
	organizationId: string,
): Promise<{ state: string | null; revertEstablished: boolean }> {
	const [row] = await client.$queryRaw<
		Array<{ state?: string | null; revertEstablished?: unknown }>
	>`
		SELECT s."pullRequestState"::text AS "state",
			${establishedCurrentRevertSql()} AS "revertEstablished"
		FROM "project_instruction_snapshot" s
		WHERE s."id" = ${snapshotId} AND s."organizationId" = ${organizationId}`;
	return {
		state: row?.state ?? null,
		revertEstablished: row?.revertEstablished === true,
	};
}

function keepValidatingClock(
	locked: { status: string; updatedAt: Date } | null,
): { updatedAt?: Date } {
	return locked?.status === "VALIDATING"
		? { updatedAt: locked.updatedAt }
		: {};
}

/**
 * One fenced transition (spec §4.4). Writes both status columns when `to` is
 * a state, bumps the attempt when the event does, and writes its audit rows
 * with `recordAuditTx` in the same transaction only when the row moved. The
 * rows must be exactly `requiredPullRequestAudits(event, to)`.
 * `expectedAttempt` is the attempt the caller observed: required (a number)
 * whenever the call selects an attempt-fenced arm, and null only for a call
 * whose every arm is attempt-independent (`pullRequestTransitionWhere`).
 *
 * `branch` (member proposal branches, Fizzy #2738 spec §4.1) further
 * conditions the write on the proposal's current `proposalBranchId` and
 * `proposalAssignment`: a fact about a submission the proposal has left
 * never moves it. Only a branch event may name it.
 */
export async function transitionPullRequest(
	i: {
		snapshotId: string;
		organizationId: string;
		event: PullRequestEvent;
		from: readonly State[];
		expectedAttempt: number | null;
		to: Target;
		bumpAttempt: boolean;
		data?: PullRequestColumns;
		audit?: RecordAuditInput | readonly RecordAuditInput[];
		branch?: { id: string; assignment: number };
	},
	tx?: Prisma.TransactionClient,
): Promise<{ ok: true; attempt: number } | { ok: false }> {
	const rule = PULL_REQUEST_TRANSITIONS[i.event];
	// Legality and the fence first: an illegal (event, from, to), or a
	// fenced arm named without an attempt, is a programming error.
	const stateWhere = pullRequestTransitionWhere(
		i.event,
		i.from,
		i.to,
		i.expectedAttempt,
	);
	const fencedCall = allArmsFenced(i.event, i.from, i.to);
	const revertStates = i.from.filter(
		(state) =>
			fromRuleOf(i.event, state, i.to).requires ===
			"established_current_revert",
	);
	if (i.bumpAttempt !== rule.bump) {
		throw new Error(
			`Pull-request transition ${i.event} ${rule.bump ? "must" : "must not"} bump the attempt`,
		);
	}
	const audits = auditsOf(i.audit);
	assertExactAudits(i.event, i.to, audits);
	if (
		i.branch !== undefined &&
		!(BRANCH_PULL_REQUEST_EVENTS as readonly string[]).includes(i.event)
	) {
		throw new Error(
			`Pull-request transition ${i.event} is not a branch event and takes no branch fence`,
		);
	}
	const where: Prisma.ProjectInstructionSnapshotWhereInput = {
		id: i.snapshotId,
		organizationId: i.organizationId,
		AND: [stateWhere],
		...(i.branch === undefined
			? {}
			: {
					proposalBranchId: i.branch.id,
					proposalAssignment: i.branch.assignment,
				}),
	};
	const data: Prisma.ProjectInstructionSnapshotUncheckedUpdateManyInput = {
		...columnsForPrisma(i.data),
		...(i.to === "unchanged"
			? {}
			: {
					pullRequestState: i.to,
					proposalStatus: proposalStatusForPullRequestState(i.to),
				}),
		...(i.bumpAttempt ? { pullRequestAttempt: { increment: 1 } } : {}),
	};

	const run = async (
		client: Prisma.TransactionClient,
	): Promise<{ ok: true; attempt: number } | { ok: false }> => {
		const locked = await lockSnapshotClock(
			client,
			i.snapshotId,
			i.organizationId,
		);
		if (!locked) {
			return { ok: false };
		}
		if (
			(PRE_CREATE_CANCEL_EVENTS as readonly string[]).includes(i.event) &&
			(await hasJournalOperation(client, i.snapshotId, i.organizationId))
		) {
			// A member branch proposal with a journal operation: its commit
			// may be on the branch, so no pre-create cancel applies.
			return { ok: false };
		}
		if (revertStates.length > 0) {
			// Decision 14: a terminal row moves here only when its current
			// withdrawal is an established revert on its current branch.
			const current = await readCurrentRevert(
				client,
				i.snapshotId,
				i.organizationId,
			);
			const needsRevert =
				current.state === null ||
				(revertStates as readonly string[]).includes(current.state);
			if (needsRevert && !current.revertEstablished) {
				return { ok: false };
			}
		}
		const { count } = await client.projectInstructionSnapshot.updateMany({
			where,
			data: { ...data, ...keepValidatingClock(locked) },
		});
		if (count !== 1) {
			return { ok: false };
		}
		let attempt: number;
		if (fencedCall) {
			attempt = (i.expectedAttempt as number) + (i.bumpAttempt ? 1 : 0);
		} else {
			// An attempt-independent arm matched the row at whatever attempt
			// it holds. Our UPDATE holds the row lock until commit, so this
			// read sees exactly the attempt it left.
			const row = await client.projectInstructionSnapshot.findFirst({
				where: { id: i.snapshotId, organizationId: i.organizationId },
				select: { pullRequestAttempt: true },
			});
			attempt = row?.pullRequestAttempt ?? 0;
		}
		for (const a of audits) {
			await recordAuditTx(client, a);
		}
		return { ok: true, attempt };
	};
	return tx ? run(tx) : db.$transaction((t) => run(t));
}

// ---------------------------------------------------------------------------
// Retention (spec §4.3)
// ---------------------------------------------------------------------------

/** The states in which an operation may still push, create, close or settle. */
const UNRESOLVED_STATES = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"BLOCKED",
] as const satisfies readonly State[];

/** The terminal states; a row in one is resolved once nothing is owed on it. */
const RESOLVED_STATES = [
	"MERGED",
	"CLOSED",
	"CANCELED",
] as const satisfies readonly State[];

/** A branch's terminal states (Fizzy #2738 spec §4.4). */
const TERMINAL_BRANCH_STATES = ["MERGED", "CLOSED", "CANCELED"] as const;

/**
 * Fizzy #2738 spec §4.5: the branch a v2 row sits on still owes work. It is
 * not terminal, its membership is pending, it owes a merge sync, or it has
 * an open settlement obligation (a create marker, or a confirmation due);
 * and it is tracked: an `untracked` branch owes nothing Fabric can still do.
 */
function unresolvedBranch() {
	return {
		untracked: false,
		OR: [
			{ state: { notIn: [...TERMINAL_BRANCH_STATES] } },
			{ membership: { path: ["status"], equals: "pending" } },
			{ mergeSyncRequestedAt: { not: null } },
			{ createIssuedAt: { not: null } },
			{ confirmationDueAt: { not: null } },
		],
	} satisfies Prisma.ProjectInstructionProposalBranchWhereInput;
}

/**
 * A row retention must keep: a live operation, a merge sync still owed, or
 * any attempt record with an outstanding obligation (the maintained
 * `pullRequestObligationOpen` column). Spec §4.3. A member proposal branch
 * row (Fizzy #2738 spec §4.5) is also kept while its branch still owes work
 * (`unresolvedBranch`).
 */
export function unresolvedPullRequestOperation() {
	return {
		OR: [
			{ pullRequestState: { in: [...UNRESOLVED_STATES] } },
			{ mergeSyncRequestedAt: { not: null } },
			{ pullRequestObligationOpen: true },
			{ proposalBranch: { is: unresolvedBranch() } },
			// A direct commit has no pull-request state while its push outcome is
			// unresolved. Its intent bytes must survive retention until that
			// outcome is durable.
			{
				proposalDestination: "REPOSITORY_COMMIT",
				commitOutcome: { equals: Prisma.AnyNull },
			},
		],
	} satisfies Prisma.ProjectInstructionSnapshotWhereInput;
}

/**
 * The null-safe complement of `unresolvedPullRequestOperation`, which every
 * retention filter uses. `NOT` over that `OR` would be wrong for a FABRIC
 * row: `"pullRequestState" IN (...)` is NULL for a null state, so the
 * negation is NULL too and no FABRIC row would ever be prunable again. The
 * branch clause is negated only for a row that has a branch, for the same
 * reason.
 */
export function resolvedPullRequestOperation() {
	return {
		AND: [
			{
				OR: [
					{ pullRequestState: null },
					{ pullRequestState: { in: [...RESOLVED_STATES] } },
				],
			},
			{ mergeSyncRequestedAt: null },
			{ pullRequestObligationOpen: false },
			{
				OR: [
					{ proposalBranchId: null },
					{ NOT: { proposalBranch: { is: unresolvedBranch() } } },
				],
			},
			{
				OR: [
					{ proposalDestination: { not: "REPOSITORY_COMMIT" } },
					{ commitOutcome: { not: Prisma.AnyNull } },
				],
			},
		],
	} satisfies Prisma.ProjectInstructionSnapshotWhereInput;
}

/** What the row form reads of a v2 row's branch (Fizzy #2738 spec §4.5). */
export type RetentionBranchFields = {
	state: string;
	untracked: boolean;
	membership: unknown;
	mergeSyncRequestedAt: Date | null;
	createIssuedAt: Date | null;
	confirmationDueAt: Date | null;
};

function isUnresolvedBranch(b: RetentionBranchFields): boolean {
	if (b.untracked) {
		return false;
	}
	const membership =
		b.membership !== null && typeof b.membership === "object"
			? (b.membership as { status?: unknown }).status
			: undefined;
	return (
		!(TERMINAL_BRANCH_STATES as readonly string[]).includes(b.state) ||
		membership === "pending" ||
		b.mergeSyncRequestedAt !== null ||
		b.createIssuedAt !== null ||
		b.confirmationDueAt !== null
	);
}

/**
 * The same predicate over a row value, for a caller that has read the row.
 * A caller that reads a v2 row passes its `proposalBranch` (the
 * `RetentionBranchFields`); one that omits it answers for the row's own
 * columns only.
 */
export function isUnresolvedPullRequestOperation(row: {
	pullRequestState?: State | null;
	mergeSyncRequestedAt?: Date | null;
	pullRequestObligationOpen?: boolean | null;
	proposalBranch?: RetentionBranchFields | null;
	proposalDestination?: string | null;
	commitOutcome?: unknown;
}): boolean {
	return (
		(row.pullRequestState !== null &&
			row.pullRequestState !== undefined &&
			(UNRESOLVED_STATES as readonly State[]).includes(
				row.pullRequestState,
			)) ||
		(row.mergeSyncRequestedAt !== null &&
			row.mergeSyncRequestedAt !== undefined) ||
		row.pullRequestObligationOpen === true ||
		(row.proposalBranch !== null &&
			row.proposalBranch !== undefined &&
			isUnresolvedBranch(row.proposalBranch)) ||
		(row.proposalDestination === "REPOSITORY_COMMIT" &&
			(row.commitOutcome === null || row.commitOutcome === undefined))
	);
}

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/** `<alias>."<column>"`. The alias is a caller's constant, checked, never input. */
function column(alias: string, name: string): Prisma.Sql {
	if (!SQL_ALIAS.test(alias)) {
		throw new Error(`Invalid SQL alias: ${alias}`);
	}
	return Prisma.raw(`${alias}."${name}"`);
}

function stateList(states: readonly State[]): Prisma.Sql {
	return Prisma.raw(states.map((state) => `'${state}'`).join(", "));
}

/**
 * `unresolvedBranch()` for raw SQL: an EXISTS over the row's branch, so it
 * is never NULL and its negation is null-safe.
 */
function unresolvedBranchSql(alias: string): Prisma.Sql {
	return Prisma.sql`EXISTS (SELECT 1 FROM "project_instruction_proposal_branch" rb WHERE rb."id" = ${column(alias, "proposalBranchId")} AND NOT rb."untracked" AND (rb."state"::text NOT IN ('MERGED', 'CLOSED', 'CANCELED') OR rb."membership"->>'status' = 'pending' OR rb."mergeSyncRequestedAt" IS NOT NULL OR rb."createIssuedAt" IS NOT NULL OR rb."confirmationDueAt" IS NOT NULL))`;
}

/** `unresolvedPullRequestOperation()` for raw SQL over `alias`. */
export function unresolvedPullRequestOperationSql(alias: string): Prisma.Sql {
	const destination = column(alias, "proposalDestination");
	const outcome = column(alias, "commitOutcome");
	return Prisma.sql`(${column(alias, "pullRequestState")} IN (${stateList(UNRESOLVED_STATES)}) OR ${column(alias, "mergeSyncRequestedAt")} IS NOT NULL OR ${column(alias, "pullRequestObligationOpen")} OR ${unresolvedBranchSql(alias)} OR (${destination} = 'REPOSITORY_COMMIT' AND (${outcome} IS NULL OR ${outcome} = 'null'::jsonb)))`;
}

/** `resolvedPullRequestOperation()` for raw SQL over `alias`, null-safe as it is. */
export function resolvedPullRequestOperationSql(alias: string): Prisma.Sql {
	const state = column(alias, "pullRequestState");
	const destination = column(alias, "proposalDestination");
	const outcome = column(alias, "commitOutcome");
	return Prisma.sql`(${state} IS NULL OR ${state} IN (${stateList(RESOLVED_STATES)})) AND ${column(alias, "mergeSyncRequestedAt")} IS NULL AND NOT ${column(alias, "pullRequestObligationOpen")} AND NOT ${unresolvedBranchSql(alias)} AND (${destination} IS DISTINCT FROM 'REPOSITORY_COMMIT' OR (${outcome} IS NOT NULL AND ${outcome} <> 'null'::jsonb))`;
}

// ---------------------------------------------------------------------------
// The sweeper's Observe cadence (spec §9)
// ---------------------------------------------------------------------------

/**
 * Seconds after its last check that an OPEN pull request is due for Observe
 * again (Fizzy #2761). The sweeper fires every five minutes and Observe is
 * meant to revisit a pull request every ten, i.e. on every second tick. A
 * check stamps its own completion time, which lands anywhere within its
 * tick's four-minute budget, so "ten minutes since the stamp" was never true
 * on the tick ten minutes later: a pull request checked at 18:10:05 was
 * skipped at 18:20:00 and taken at 18:25, every time.
 *
 * Measured from the stamp, a row checked by one tick must be due on the
 * tick ten minutes after it and not on the tick five minutes after it. With
 * the stamp at most the 240 s budget into its tick, any value above 300 s
 * and at most 360 s does both; 330 s leaves 30 s of scheduling slack on each
 * side. The temporal sweep's own test pins this against its budget and
 * cron.
 */
export const PROPOSAL_OBSERVE_DUE_AFTER_SECONDS = 330;

/**
 * Observe's due test on a last-checked column, for the member proposal
 * branches' Observe (Fizzy #2738). #2563's own Observe lane shared it until
 * that path was retired (Fizzy #2748). Never checked is due at once.
 */
export function observeDue(lastCheckedAt: Prisma.Sql, nowUtc: Prisma.Sql) {
	return Prisma.sql`(${lastCheckedAt} IS NULL OR ${lastCheckedAt} <= ${nowUtc} - ${Prisma.raw(`interval '${PROPOSAL_OBSERVE_DUE_AFTER_SECONDS} seconds'`)})`;
}

// ---------------------------------------------------------------------------
// Refresh (spec §12)
// ---------------------------------------------------------------------------

/**
 * How often a person's Refresh is admitted, per operation (spec §12):
 * at most once in this many seconds, on the database clock.
 */
export const PULL_REQUEST_REFRESH_COOLDOWN_SECONDS = 60;

/**
 * A Refresh's answer (spec §12): admitted, with what the row holds
 * afterwards, or refused with the seconds until one could be admitted.
 * `provider_rate_limited` is a row whose provider set its own deadline,
 * which no Refresh moves; `cooldown` is one refreshed within the last
 * `PULL_REQUEST_REFRESH_COOLDOWN_SECONDS`.
 */
export type PullRequestRefreshResult =
	| { admitted: true; state: State; attempt: number; failure: unknown }
	| {
			admitted: false;
			reason: "cooldown" | "provider_rate_limited";
			retryAfterSeconds: number;
	  };

/**
 * Refresh (spec §12), for a person asking Fabric to look again: nulls
 * `pullRequestLastCheckedAt`, so the sweeper's Observe takes an OPEN row on
 * its next tick, and makes a retryable BLOCKED row due now on the database
 * clock (Review Focus 4). A non-retryable BLOCKED row keeps its next attempt:
 * only a human retry re-issues it. Only an unresolved REPOSITORY operation
 * with a member branch context (`pullRequestContext.v = 2`) in the caller's
 * project and organization is touched; null otherwise. A #2563 (v1) row is
 * excluded because nothing acts on one any more (Fizzy #2748): admitting its
 * Refresh would clear its last check and report success with no check to
 * follow.
 *
 * Every Refresh brings provider work forward, so it is rationed (review
 * round 1). ONE conditional UPDATE admits it, and only when no Refresh of
 * this operation was admitted in the last
 * `PULL_REQUEST_REFRESH_COOLDOWN_SECONDS`; the same statement stamps
 * `pullRequestRefreshAdmittedAt`. Two concurrent refreshes serialize on the
 * row lock and the second re-reads the stamp the first wrote, so exactly one
 * is admitted. A BLOCKED `PROVIDER_RATE_LIMITED` row whose deadline is still
 * ahead is never admitted: that deadline is the provider's own (its
 * Retry-After), and no Refresh shortens it. A refused Refresh changes
 * nothing; a second read only explains the refusal and never admits.
 *
 * Raw SQL on purpose: a Prisma update would stamp `updatedAt`, which on a
 * VALIDATING snapshot is the gate's staleness clock. Not attempt-fenced:
 * it moves no state and bumps nothing, and the one statement decides under
 * its own row lock, so a transition racing it is either wholly before or
 * wholly after. An admitted answer carries what the row holds afterwards,
 * for the caller to decide whether the operation's workflow should run.
 */
export async function requestPullRequestRefresh(i: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<PullRequestRefreshResult | null> {
	const cooldown = PULL_REQUEST_REFRESH_COOLDOWN_SECONDS;
	const admitted = await db.$queryRaw<
		Array<{ state: State; attempt: number; failure: unknown }>
	>`
		UPDATE "project_instruction_snapshot"
		SET "pullRequestLastCheckedAt" = NULL,
			"pullRequestRefreshAdmittedAt" = (now() AT TIME ZONE 'UTC'),
			"pullRequestNextAttemptAt" = CASE
				WHEN "pullRequestState" = 'BLOCKED'
					AND ("pullRequestFailure"->>'retryable') = 'true'
					AND ("pullRequestFailure"->>'code') IS DISTINCT FROM 'PROVIDER_RATE_LIMITED'
				THEN (now() AT TIME ZONE 'UTC')
				ELSE "pullRequestNextAttemptAt"
			END
		WHERE "id" = ${i.snapshotId}
			AND "projectId" = ${i.projectId}
			AND "organizationId" = ${i.organizationId}
			AND "proposalDestination" = 'REPOSITORY'
			AND ("pullRequestContext"->>'v') = '2'
			AND "pullRequestState" IN (${stateList(UNRESOLVED_STATES)})
			AND ("pullRequestRefreshAdmittedAt" IS NULL
				OR "pullRequestRefreshAdmittedAt"
					<= (now() AT TIME ZONE 'UTC') - make_interval(secs => ${cooldown}::int))
			AND NOT COALESCE(
				"pullRequestState" = 'BLOCKED'
					AND ("pullRequestFailure"->>'code') = 'PROVIDER_RATE_LIMITED'
					AND "pullRequestNextAttemptAt" > (now() AT TIME ZONE 'UTC'),
				false)
		RETURNING "pullRequestState" AS "state", "pullRequestAttempt" AS "attempt", "pullRequestFailure" AS "failure"
	`;
	const row = admitted[0];
	if (row) {
		return {
			admitted: true,
			state: row.state,
			attempt: Number(row.attempt),
			failure: row.failure,
		};
	}
	// Not admitted: say why, from the row as it is now. Read-only, and in the
	// same scope as the UPDATE, so a row that is not an unresolved operation
	// of this project is still null.
	const refused = await db.$queryRaw<
		Array<{
			rateLimited: boolean | null;
			backoffSeconds: number | null;
			cooldownSeconds: number | null;
		}>
	>`
		SELECT
			("pullRequestState" = 'BLOCKED'
				AND ("pullRequestFailure"->>'code') = 'PROVIDER_RATE_LIMITED'
				AND "pullRequestNextAttemptAt" > (now() AT TIME ZONE 'UTC')) AS "rateLimited",
			CEIL(EXTRACT(EPOCH FROM ("pullRequestNextAttemptAt" - (now() AT TIME ZONE 'UTC'))))::int AS "backoffSeconds",
			CEIL(EXTRACT(EPOCH FROM (
				"pullRequestRefreshAdmittedAt" + make_interval(secs => ${cooldown}::int)
					- (now() AT TIME ZONE 'UTC'))))::int AS "cooldownSeconds"
		FROM "project_instruction_snapshot"
		WHERE "id" = ${i.snapshotId}
			AND "projectId" = ${i.projectId}
			AND "organizationId" = ${i.organizationId}
			AND "proposalDestination" = 'REPOSITORY'
			AND ("pullRequestContext"->>'v') = '2'
			AND "pullRequestState" IN (${stateList(UNRESOLVED_STATES)})
	`;
	const why = refused[0];
	if (!why) {
		return null;
	}
	// A refused Refresh is told to wait at least a second: if the cooldown
	// ran out between the two statements, trying again is simply admitted.
	const cooling = Math.min(cooldown, Math.max(0, why.cooldownSeconds ?? 0));
	if (why.rateLimited === true) {
		return {
			admitted: false,
			reason: "provider_rate_limited",
			retryAfterSeconds: Math.max(1, why.backoffSeconds ?? 1, cooling),
		};
	}
	return {
		admitted: false,
		reason: "cooldown",
		retryAfterSeconds: Math.max(1, cooling),
	};
}

// ---------------------------------------------------------------------------
// Merge-sync receipts (spec §9.1)
// ---------------------------------------------------------------------------

/** What `classifyMergeSyncReceipt` (Task 13) reads from a run receipt. */
const RECEIPT_SELECT = {
	id: true,
	projectId: true,
	syncId: true,
	generation: true,
	trigger: true,
	startedAt: true,
	status: true,
	error: true,
} satisfies Prisma.ProjectInstructionRepositorySyncRunSelect;

/**
 * The newest merge-triggered run for the tuple the request was dispatched
 * with, started at or after the request (spec §9.1 step 2), when no run id
 * was recorded. Scoped to the row's organization and project (spec §13.5).
 */
export function findMergeTriggeredRun(i: {
	projectId: string;
	organizationId: string;
	syncId: string;
	generation: number;
	startedAtOrAfter: Date;
}) {
	return db.projectInstructionRepositorySyncRun.findFirst({
		where: {
			projectId: i.projectId,
			organizationId: i.organizationId,
			syncId: i.syncId,
			generation: i.generation,
			trigger: "PULL_REQUEST_MERGED",
			startedAt: { gte: i.startedAtOrAfter },
		},
		orderBy: { startedAt: "desc" },
		select: RECEIPT_SELECT,
	});
}

/**
 * The receipt of the Temporal run `runId`, whichever sync row keyed it
 * (spec §9.1): the receipt id is `<syncId>:<runId>` for the row that existed
 * when `begin` ran, so a key built from the dispatcher's own sync id names
 * nothing after a reconfiguration. Scoped to the row's organization and project (spec
 * §13.5); `projectId` also bounds the scan by the `(projectId, startedAt)`
 * index prefix.
 */
export async function getSyncRunReceiptByRunId(i: {
	projectId: string;
	organizationId: string;
	runId: string;
}) {
	if (i.runId === "") {
		// `endsWith(":")` would match every receipt of the project.
		throw new Error("getSyncRunReceiptByRunId needs a run id");
	}
	return db.projectInstructionRepositorySyncRun.findFirst({
		where: {
			projectId: i.projectId,
			organizationId: i.organizationId,
			id: { endsWith: `:${i.runId}` },
		},
		select: RECEIPT_SELECT,
	});
}

/** A merge-sync run's receipt as the queries here read it. */
type SyncRunReceipt = Prisma.ProjectInstructionRepositorySyncRunGetPayload<{
	select: typeof RECEIPT_SELECT;
}>;

/**
 * The receipts of several Temporal runs in ONE query, for a page of proposals
 * (spec §9.1, §12): the same rule as `getSyncRunReceiptByRunId`
 * for each id (a receipt in this project and organization whose id ends
 * `:<runId>`, whichever sync row keyed it), keyed by run id. A run with no
 * receipt is absent from the map. Empty ids are skipped rather than refused:
 * a row whose `mergeSyncRunId` is empty reads no receipt on the single path
 * either, and `endsWith(":")` would match every receipt of the project. No
 * query at all when no id is left.
 */
export async function getSyncRunReceiptsByRunIds(i: {
	projectId: string;
	organizationId: string;
	runIds: readonly string[];
}): Promise<Map<string, SyncRunReceipt>> {
	const runIds = [...new Set(i.runIds.filter((runId) => runId !== ""))];
	const byRunId = new Map<string, SyncRunReceipt>();
	if (runIds.length === 0) {
		return byRunId;
	}
	const receipts = await db.projectInstructionRepositorySyncRun.findMany({
		where: {
			projectId: i.projectId,
			organizationId: i.organizationId,
			OR: runIds.map((runId) => ({ id: { endsWith: `:${runId}` } })),
		},
		select: RECEIPT_SELECT,
	});
	for (const runId of runIds) {
		const receipt = receipts.find((r) => r.id.endsWith(`:${runId}`));
		if (receipt) {
			byRunId.set(runId, receipt);
		}
	}
	return byRunId;
}

/** A sync row's identity at one generation (spec §9.1). */
export type MergeSyncTuple = { syncId: string; generation: number };

// ---------------------------------------------------------------------------
// The operation row, as readiness and the API read it (spec §6.1, §12)
// ---------------------------------------------------------------------------

const PROPOSAL_OPERATION_SELECT = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	version: true,
	status: true,
	rejection: true,
	proposalStatus: true,
	proposalDestination: true,
	baseSnapshotId: true,
	createdAt: true,
	pullRequestOperationId: true,
	pullRequestState: true,
	pullRequestAttempt: true,
	pullRequestContext: true,
	pullRequestHeadSha: true,
	pullRequestRef: true,
	pullRequestAttempts: true,
	pullRequestUrl: true,
	pullRequestExternalId: true,
	pullRequestObservation: true,
	pullRequestFailure: true,
	pullRequestLastCheckedAt: true,
	pullRequestNextAttemptAt: true,
	mergeSyncRequestedAt: true,
	mergeSyncDispatchedAt: true,
	mergeSyncRunId: true,
	mergeSyncExpected: true,
} satisfies Prisma.ProjectInstructionSnapshotSelect;

export type ProposalOperationRow = Prisma.ProjectInstructionSnapshotGetPayload<{
	select: typeof PROPOSAL_OPERATION_SELECT;
}> & {
	/**
	 * The database clock when the row was read (UTC, as the timestamp
	 * columns store it). Every due decision an activity makes from this row
	 * (a confirmation, the 24 h create rule, a merge-sync backoff) compares
	 * with this, never with the worker's clock (Review Focus 4).
	 */
	databaseNow: Date;
};

/**
 * One proposal operation, scoped to its project and organization (spec
 * §13.5), with the database clock read beside it. Null when no such row.
 */
export async function getProposalOperation(i: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<ProposalOperationRow | null> {
	const [row, clock] = await Promise.all([
		db.projectInstructionSnapshot.findFirst({
			where: {
				id: i.snapshotId,
				projectId: i.projectId,
				organizationId: i.organizationId,
			},
			select: PROPOSAL_OPERATION_SELECT,
		}),
		db.$queryRaw<
			Array<{ now: Date }>
		>`SELECT (now() AT TIME ZONE 'UTC') AS "now"`,
	]);
	if (!row) {
		return null;
	}
	return { ...row, databaseNow: clock[0]?.now ?? new Date() };
}
