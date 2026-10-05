/**
 * The vocabulary the direct-commit and revert workflows share with their
 * activities (Fizzy #2878 §10). Pure: no runtime imports, no I/O, nothing
 * that reads the clock or the environment, so the workflow bundle may import
 * it. Payloads carry ids, states and codes only.
 */

/**
 * The failure code a commit or revert ends with when the project is in
 * Read-only mode: recorded as the commit's `failed` outcome, and the revert's
 * `failed` answer, which the API words as the typed read-only error.
 */
export const READ_ONLY_MODE_FAILURE_CODE = "READ_ONLY_MODE";

/** The direct commit workflow's input: the snapshot, and the tenant it belongs to. */
export type DirectCommitWorkflowInput = {
	snapshotId: string;
	organizationId: string;
};

/** `checkDirectCommitReadiness`: whether the snapshot's validation has reached READY. */
export type DirectCommitReadinessInput = DirectCommitWorkflowInput & {
	/** The workflow's own wait ran out: record the failure and stop. */
	deadlineReached?: boolean;
};

export type DirectCommitReadinessResult =
	| { kind: "ready" }
	| { kind: "pending" }
	/** Nothing more to do: settled already, rejected by the scan, or not a pending commit. */
	| { kind: "stop" };

/**
 * An outcome that wrote nothing to the repository and has not been recorded
 * yet: the workflow records it with its own activity
 * (`recordDirectCommitSettlement`), the one that is retried for a long time,
 * so a database that is briefly unreachable does not leave the commit pending.
 */
export type UnrecordedCommitOutcome =
	| { outcome: "unchanged"; sha: string }
	| { outcome: "branch-moved" }
	| { outcome: "failed"; code: string; retryable: boolean };

/**
 * `commitToSyncedBranch`'s answer, for the workflow's result and tests.
 * `pushed`: the branch holds the commit `sha`; the workflow records it with
 * its own activity (`recordPushedDirectCommit`). `outcome`: the commit ended
 * without a push (unchanged, branch moved, refused, failed), to be recorded by
 * the workflow the same way. `settled`: the activity recorded the outcome
 * itself (the pull request the branch's refusal became).
 */
export type CommitToSyncedBranchResult =
	| { kind: "settled"; outcome: string }
	| { kind: "outcome"; outcome: UnrecordedCommitOutcome }
	| { kind: "pushed"; sha: string }
	| { kind: "not_ready" }
	| { kind: "stopped" };

/**
 * `recordDirectCommitSettlement`'s answer: the outcome name, whether this call
 * wrote it or an earlier attempt already had.
 */
export type RecordDirectCommitSettlementResult = {
	kind: "settled";
	outcome: string;
};

/** The workflow's result: how it ended. */
export type DirectCommitWorkflowResult =
	| { kind: "settled"; outcome: string }
	| { kind: "stopped" };

/**
 * The readiness sleeps between answers that were not `ready`, in seconds: a
 * small change set validates in seconds, so the first waits are short, then
 * the wait settles at 30 s.
 */
export const DIRECT_COMMIT_READINESS_SLEEPS_S = [2, 4, 8, 15, 30] as const;

/** How long the workflow waits for validation before it records `VALIDATION_TIMEOUT`. */
export const DIRECT_COMMIT_VALIDATION_WAIT_MS = 30 * 60_000;

/**
 * Attempts the commit and revert activities get. A failure that is worth
 * another attempt is rethrown until the last, which records it as the
 * outcome; the workflow's retry policy and the activity's own count read this
 * one number.
 */
export const DIRECT_COMMIT_MAX_ATTEMPTS = 3;

export const DIRECT_COMMIT_ACTIVITY_TIMEOUTS = {
	readiness: { startToCloseMs: 30_000 },
	commit: { startToCloseMs: 15 * 60_000, heartbeatMs: 60_000 },
	/** The write that records a pushed commit: a database write and a workflow start. */
	record: { startToCloseMs: 60_000 },
} as const;

/**
 * The sync run a commit that reached the branch asks for: the row it was made
 * against, so a run for a row that was re-configured since is refused by
 * `begin` (`expected`). Ids only.
 */
export type ConfirmingSyncInput = {
	projectId: string;
	organizationId: string;
	syncId: string;
	generation: number;
};

/**
 * What the activity that records a pushed direct commit answers: the outcome
 * (always `committed`) and the run to ask for next.
 */
export type RecordPushedDirectCommitResult = {
	kind: "settled";
	outcome: "committed";
	confirm: ConfirmingSyncInput;
};

/**
 * The activity that asks the sync to take a pushed commit's head. A start is
 * refused with a retryable failure while another run is open (that run may
 * have read the branch before the push, and the head needs a run that starts
 * after it), so it is retried with a backoff of 30 s growing to 5 min, and
 * given up on after 30 minutes: the next poll or webhook takes the head anyway.
 */
export const CONFIRMING_SYNC_ACTIVITY_TIMEOUTS = {
	startToCloseMs: 60_000,
	scheduleToCloseMs: 30 * 60_000,
} as const;

export const CONFIRMING_SYNC_RETRY = {
	initialInterval: "30 seconds",
	backoffCoefficient: 2,
	maximumInterval: "5 minutes",
} as const;

/**
 * The most attempts the activities that record an outcome get. Backed off to
 * five minutes this outlasts a database outage of about eight hours, which is
 * past the point where the workflow's own execution timeout
 * (`COMMIT_WORKFLOW_EXECUTION_TIMEOUT_MS`) decides; a record that is still
 * failing then is reported and left to the reaper (`STALE`).
 */
export const RECORD_MAX_ATTEMPTS = 100;

/**
 * The failure types a record never retries, because the same write would be
 * refused again: the typed non-retryable failures the record activities throw
 * (`DIRECT_COMMIT_SNAPSHOT_MISSING`, `DIRECT_COMMIT_OUTCOME_REFUSED`,
 * `RECORD_REJECTED`, which wraps a database constraint, enum or value
 * refusal) and Prisma's own validation error, thrown as such.
 */
export const RECORD_NON_RETRYABLE_ERROR_TYPES = [
	"DIRECT_COMMIT_SNAPSHOT_MISSING",
	"DIRECT_COMMIT_OUTCOME_REFUSED",
	"RECORD_REJECTED",
	"PrismaClientValidationError",
];

/**
 * The retry policy of the activities that record an outcome after the commit
 * step (a pushed commit, a revert's audit row, a commit that wrote nothing):
 * backoff from 5 s to 5 min for up to `RECORD_MAX_ATTEMPTS` attempts, because
 * a pushed commit cannot be un-pushed and a record that gives up too soon
 * leaves the member's commit pending. A fault that a retry cannot fix is
 * thrown as a non-retryable failure and ends the record at once.
 */
export const RECORD_PUSHED_RETRY = {
	initialInterval: "5 seconds" as const,
	backoffCoefficient: 2,
	maximumInterval: "5 minutes" as const,
	maximumAttempts: RECORD_MAX_ATTEMPTS,
	nonRetryableErrorTypes: RECORD_NON_RETRYABLE_ERROR_TYPES,
};

/** The retry policy of the report that follows a record that gave up: it is best effort. */
export const RECORD_REPORT_RETRY = {
	initialInterval: "5 seconds" as const,
	backoffCoefficient: 2,
	maximumAttempts: 5,
};

/**
 * How long a commit or revert workflow may run, end to end: the wait for
 * validation (30 minutes), the commit's attempts, the record's attempts and
 * the confirming run's retries fit well inside it. A workflow that is still
 * open then has nothing behind it; the reaper closes a commit row that waited
 * this long (`STALE`).
 */
export const COMMIT_WORKFLOW_EXECUTION_TIMEOUT_MS = 24 * 60 * 60_000;

/** The code a commit is recorded `failed` with when its record gave up. */
export const SETTLE_FAILED_CODE = "SETTLE_FAILED";

/**
 * The revert workflow's input. `requestId` is chosen by the API, once per
 * request. The attribution is rendered by the API (the deployment's mail
 * domain is its configuration) and frozen here, so every retry builds the
 * same commit.
 */
export type RevertCommitWorkflowInput = {
	projectId: string;
	organizationId: string;
	/** The member reverting: the permission checked and the audit actor. */
	userId: string;
	/** The commit to revert. */
	sha: string;
	requestId: string;
	author: { name: string; email: string };
	committer: { name: string; email: string };
	/** ISO 8601 UTC, whole seconds. */
	committedAt: string;
};

/**
 * How a revert ended. `refused` carries a typed code of the revert's own
 * (`REVERT_CONFLICT`, `REVERT_REJECTED`, `REVERT_TOO_LARGE`,
 * `REVERT_UNSUPPORTED`, `COMMIT_NOT_ON_BRANCH`); `protected` and `busy` are the
 * branch refusing the push or kept moving, where a pull request is the
 * member's remaining way; `failed` is a typed infrastructure code, never text.
 */
export type RevertCommitWorkflowResult =
	| { kind: "reverted"; sha: string; ref: string; fileCount: number }
	| { kind: "unchanged"; sha: string }
	| { kind: "refused"; code: string }
	| { kind: "protected" }
	| { kind: "busy" }
	| { kind: "failed"; code: string };

export const REVERT_ACTIVITY_TIMEOUTS = {
	revert: { startToCloseMs: 15 * 60_000, heartbeatMs: 60_000 },
} as const;
