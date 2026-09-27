/**
 * The vocabulary the member proposal branch activities share with the branch
 * workflow (Fizzy #2738 spec §6): inputs, typed outcomes and activity
 * timeouts. Pure: no runtime imports, no I/O, nothing that reads the clock
 * or the environment, so the workflow bundle may import it (types only via
 * `import type` from anywhere else). Payloads carry ids, states and codes
 * only.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */

/**
 * An absolute deadline a caller hands an activity, as #2563's
 * `ProposalActivityDeadline`: the attempt stops issuing effects 10 s before
 * it (`withProposalDeadline`).
 */
export type BranchActivityDeadline = { deadlineAt?: string };

/** Every branch activity names its branch and tenant. */
export type BranchIds = { branchId: string; organizationId: string };

/** `claimBranchProposal` (spec §6.1). */
export type ClaimBranchProposalInput = BranchIds & BranchActivityDeadline;

export type ClaimBranchProposalResult =
	| {
			kind: "claimed";
			snapshotId: string;
			proposalAttempt: number;
			branchAttempt: number;
	  }
	| { kind: "none" }
	/** Spec §6.1: the first claim's presentation was refused; the branch is BLOCKED ATTRIBUTION_REJECTED. */
	| { kind: "attribution_rejected" };

/**
 * The append's outcome (spec §6.4):
 * - `appended`: pushed and acknowledged; the proposal is OPEN;
 * - `already_on_branch`: every path was a no-op; CANCELED ALREADY_ON_BRANCH;
 * - `blocked`: the proposal is BLOCKED (any code, retryable or not);
 * - `released`: the claim went back to QUEUED (a pull request no longer
 *   open, or a missing branch retired for rehome);
 * - `stopped`: the claim no longer holds, or evidence changed the lifecycle
 *   (the loop reads the database again);
 * - `retry_later`: nothing was decided (an issued operation must be
 *   recovered first, or an unexpected failure was recorded).
 */
export type AppendOutcome =
	| "appended"
	| "already_on_branch"
	| "blocked"
	| "released"
	| "stopped"
	| "retry_later";

export type AppendBranchProposalInput = BranchIds &
	BranchActivityDeadline & {
		snapshotId: string;
		proposalAttempt: number;
		branchAttempt: number;
	};

export type RecoverBranchOperationInput = BranchIds &
	BranchActivityDeadline & { operationId: string };

/**
 * Spec §6.2's verdict. `retry_later` (an addition to the plan's interface):
 * the history could not be fetched, so no verdict was written.
 */
export type RecoverBranchOperationResult = {
	outcome: "observed" | "unknown" | "retry_later";
};

export type ReobserveProposalOperationsInput = BranchIds &
	BranchActivityDeadline & { snapshotId: string };

export type ReobserveProposalOperationsResult = { changed: boolean };

export type CreateBranchPullRequestInput = BranchIds &
	BranchActivityDeadline & { branchAttempt: number };

/** `stopped` (an addition): the branch moved before the create committed to anything. */
export type CreateBranchPullRequestResult = {
	outcome: "opened" | "adopted" | "blocked" | "unknown" | "stopped";
};

export type LookupBranchPullRequestInput = BranchIds & BranchActivityDeadline;

export type LookupBranchPullRequestResult = {
	outcome: "adopted" | "absent" | "inconclusive";
};

export type ReleaseBranchInput = BranchIds &
	BranchActivityDeadline & { branchAttempt: number };

export type ReleaseBranchResult = {
	outcome: "released" | "adopted" | "kept";
};

export type RetryBranchOpeningInput = BranchIds &
	BranchActivityDeadline & { branchAttempt: number };

export type RetryBranchOpeningResult = {
	outcome: "opened" | "adopted" | "blocked";
};

export type RevertBranchProposalInput = BranchIds &
	BranchActivityDeadline & {
		snapshotId: string;
		proposalAttempt: number;
	};

/**
 * The revert's outcome (spec §6.8). `retry_later` (an addition): a lease or
 * hook refusal recorded failure-only; the proposal stays CLOSE_REQUESTED
 * with its backoff.
 */
export type RevertBranchProposalResult = {
	outcome:
		| "reverted"
		| "withdraw_conflict"
		| "canceled_by_evidence"
		| "unknown"
		| "stopped"
		| "retry_later";
};

/**
 * Activity timeouts (spec §6 "Activities": append and revert run 15 min with
 * a 60 s heartbeat; the rest follow #2563 §6's `PROPOSAL_ACTIVITY_TIMEOUTS`).
 */
export const BRANCH_ACTIVITY_TIMEOUTS = {
	claim: { startToCloseMs: 60_000 },
	append: { startToCloseMs: 15 * 60_000, heartbeatMs: 60_000 },
	revert: { startToCloseMs: 15 * 60_000, heartbeatMs: 60_000 },
	recover: { startToCloseMs: 5 * 60_000, heartbeatMs: 60_000 },
	reobserve: { startToCloseMs: 5 * 60_000, heartbeatMs: 60_000 },
	create: { startToCloseMs: 15 * 60_000, heartbeatMs: 60_000 },
	lookup: { startToCloseMs: 5 * 60_000, heartbeatMs: 60_000 },
	release: { startToCloseMs: 10 * 60_000, heartbeatMs: 60_000 },
	retry: { startToCloseMs: 15 * 60_000, heartbeatMs: 60_000 },
} as const;

// ---------------------------------------------------------------------------
// The loop's read, observation, classification, rehome, settlement,
// confirmations and merge sync (spec §6, §6.6, §6.7)
// ---------------------------------------------------------------------------

/**
 * The loop's next item (spec §6), as the workflow receives it: the
 * database's `BranchWork` with an idle timer given as a delay on the
 * database clock (`wakeInMs`), never as a date the workflow would compare
 * with its own clock.
 */
export type BranchWorkItem =
	| { kind: "recover"; operationId: string }
	| { kind: "confirm" }
	| { kind: "close" }
	| { kind: "release" }
	| { kind: "classify"; factsRevision: number }
	| { kind: "rehome"; snapshotIds: string[] }
	| { kind: "revert"; snapshotId: string; proposalAttempt: number }
	| { kind: "retry" }
	| { kind: "lookup" }
	| { kind: "create" }
	| { kind: "append" }
	| { kind: "wait"; snapshotId: string }
	| { kind: "idle"; wakeInMs: number | null };

/** `nextBranchWorkItem`: the item and the branch attempt read in the same snapshot. */
export type NextBranchWorkResult = {
	work: BranchWorkItem;
	branchAttempt: number;
};

/** `checkBranchProposalReadiness` (spec §6 item 12): the head proposal still validating. */
export type CheckBranchProposalReadinessInput = BranchIds &
	BranchActivityDeadline & { projectId: string; snapshotId: string };

export type CheckBranchProposalReadinessResult = {
	kind: "ready" | "pending" | "stop";
};

/**
 * `reconcileInstructionProposalBranch` (spec §6.6 "Observation"): the
 * sweeper passes the attempt it read at selection; without one the
 * activity fences on the attempt it reads itself.
 */
export type ReconcileBranchInput = BranchIds &
	BranchActivityDeadline & { expectedAttempt?: number };

/** The branch's state as it now stands; null when no such branch. */
export type ReconcileBranchResult = {
	state:
		| null
		| "PENDING"
		| "OPENING"
		| "OPEN"
		| "CLOSE_REQUESTED"
		| "BLOCKED"
		| "MERGED"
		| "CLOSED"
		| "CANCELED";
};

export type ClassifyBranchInput = BranchIds &
	BranchActivityDeadline & { factsRevision: number };

/**
 * Classification's answer (spec §6.6, Decision 14): `done` when every
 * established operation's membership was decided from the final history,
 * `unverified` after the 24 h fallback, `retry_later` when the history
 * could not be fetched (a backoff is recorded) or nothing was decided, and
 * `stale_revision` when an operation became established since the read.
 */
export type ClassifyBranchResult = {
	outcome: "done" | "unverified" | "retry_later" | "stale_revision";
};

export type RehomeBranchProposalsInput = BranchIds &
	BranchActivityDeadline & { snapshotIds: string[] };

export type RehomeBranchProposalsResult = {
	moved: number;
	/** The accepting branches the moved proposals joined, each woken. */
	wakeBranchIds: string[];
};

export type SettleBranchInput = BranchIds &
	BranchActivityDeadline & { branchAttempt: number };

/**
 * Settlement's answer (spec §6.7). Two additions to the plan's interface:
 * `moved` (the branch moved before settlement committed to anything) and
 * `retry_later` (a failure was recorded, failure-only, with its backoff).
 */
export type SettleBranchResult = {
	outcome:
		| "closed"
		| "merged"
		| "canceled"
		| "adopted"
		| "start_over_refused"
		| "rehomed"
		| "moved"
		| "retry_later";
};

export type RunBranchConfirmationsInput = BranchIds & BranchActivityDeadline;

export type DispatchBranchMergeSyncInput = BranchIds & BranchActivityDeadline;

/** How the branch workflow ended one run (spec §6 "Ending", "Continue-as-new"). */
export type ProposalBranchWorkflowResult = { ended: "idle" | "continued" };

/** Loop iterations one run makes before it continues as new, carrying ids only (spec §6). */
export const BRANCH_ITERATIONS_PER_RUN = 200;

/** Timeouts for the loop's read and the §6.6/§6.7 activities (#2563 §6's sizes). */
export const BRANCH_LOOP_ACTIVITY_TIMEOUTS = {
	read: { startToCloseMs: 60_000 },
	readiness: { startToCloseMs: 30_000 },
	reconcile: { startToCloseMs: 3 * 60_000, heartbeatMs: 60_000 },
	classify: { startToCloseMs: 10 * 60_000, heartbeatMs: 60_000 },
	rehome: { startToCloseMs: 5 * 60_000, heartbeatMs: 60_000 },
	settle: { startToCloseMs: 10 * 60_000, heartbeatMs: 60_000 },
	confirm: { startToCloseMs: 5 * 60_000, heartbeatMs: 60_000 },
	mergeSync: { startToCloseMs: 60_000, heartbeatMs: 30_000 },
} as const;

// ---------------------------------------------------------------------------
// The sweeper's branch sub-batches (spec §8)
// ---------------------------------------------------------------------------

/** The branch sub-batch limits of one sweeper tick, beside #2563's five. */
export type BranchSweepLimits = {
	close: number;
	recover: number;
	mergeSync: number;
	observe: number;
	restart: number;
	attach: number;
};

/** Spec §8: the five sub-batches keep #2563's limits for branch rows; Attach takes 10. */
export const BRANCH_SWEEP_LIMITS: BranchSweepLimits = {
	close: 10,
	recover: 10,
	mergeSync: 10,
	observe: 20,
	restart: 10,
	attach: 10,
};

/** One selected branch: ids, the attempt read at selection, the integration. */
export type BranchSweepItem = {
	branchId: string;
	projectId: string;
	organizationId: string;
	attempt: number;
	integrationId: string | null;
};

/** One v2 proposal without a branch that Attach joins, then wakes its branch. */
export type BranchAttachItem = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
};

export type DueBranchSweep = {
	close: BranchSweepItem[];
	recover: BranchSweepItem[];
	mergeSync: BranchSweepItem[];
	observe: BranchSweepItem[];
	restart: BranchSweepItem[];
	attach: BranchAttachItem[];
};

/** The sweeper's wake: `signalWithStart(wake)` on the branch's workflow. */
export type WakeBranchInput = BranchIds &
	BranchActivityDeadline & { projectId: string };

export type AttachBranchInput = BranchAttachItem & BranchActivityDeadline;

/** Attach's answer: the join's, and the branch woken when there is one. */
export type AttachBranchResult = {
	kind: "joined" | "already" | "not_joinable" | "configuration_changed";
	branchId?: string;
};
