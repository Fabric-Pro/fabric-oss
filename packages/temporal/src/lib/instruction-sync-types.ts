/**
 * The vocabulary the Coding Instructions repository sync workflow shares with
 * its activities (design 2026-09-23 §5.2-§5.5).
 *
 * The workflow bundle imports this file, so it must stay pure: no runtime
 * imports, no I/O, nothing that reads the clock or the environment. Its one
 * import is type-only and erased from the bundle, as
 * workflows/code-based-project-setup.ts imports `ProjectDocumentType`.
 */
import type {
	ClaimedRepositorySyncRow,
	InstructionSyncTrigger,
	RepositorySyncSubjectKind,
} from "@repo/database";

const INSTRUCTION_SYNC_ERROR_CODES = [
	"NOT_CONFIGURED",
	"INTEGRATION_UNAVAILABLE",
	"PERMISSION_DENIED",
	"REF_MISSING",
	"ROOT_MISSING",
	"LIMITS_EXCEEDED",
	"CLONE_FAILED",
	"STORAGE_FAILED",
	"CHILD_ABORTED",
	"CONFIGURATION_CHANGED",
	"TREE_REFUSED",
] as const;
export type InstructionSyncErrorCode =
	(typeof INSTRUCTION_SYNC_ERROR_CODES)[number];

/** What the acquisition activity's retry policy retries (spec §5.2). */
const RETRYABLE_INSTRUCTION_SYNC_ERRORS: readonly InstructionSyncErrorCode[] = [
	"CLONE_FAILED",
	"STORAGE_FAILED",
	"INTEGRATION_UNAVAILABLE",
];
export const NON_RETRYABLE_INSTRUCTION_SYNC_ERRORS: readonly InstructionSyncErrorCode[] =
	INSTRUCTION_SYNC_ERROR_CODES.filter(
		(code) => !RETRYABLE_INSTRUCTION_SYNC_ERRORS.includes(code),
	);

export function isInstructionSyncErrorCode(
	value: unknown,
): value is InstructionSyncErrorCode {
	return (
		typeof value === "string" &&
		(INSTRUCTION_SYNC_ERROR_CODES as readonly string[]).includes(value)
	);
}

/**
 * The run row's trigger enum, from `@repo/database` (Decision 47), re-exported
 * so this file's users keep one import.
 */
export type { InstructionSyncTrigger };

/**
 * The triggers whose eligibility and pause-on-failure rules apply (Decision
 * 47): `begin` skips one of these when automatic sync is off or paused, and
 * `deriveSyncRunOutcome` pauses one of these on a revoked delegate. Any other
 * trigger — MANUAL, or a value a later migration adds before it joins this
 * constant — is treated like MANUAL for both: never skipped for the
 * automatic switches, and never paused on permission revocation, though it
 * still passes the configuration, generation and permission checks every
 * trigger passes. A follow-up is expected to add `PULL_REQUEST_MERGED`
 * WITHOUT joining this set, because a merge-triggered run must not be
 * skipped merely because automatic sync is off.
 */
export const AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS = [
	"POLL",
	"WEBHOOK",
] as const satisfies readonly InstructionSyncTrigger[];

export type AutomaticInstructionSyncTrigger =
	(typeof AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS)[number];

/** Tests membership in `AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS` (Decision 47). */
export function isAutomaticInstructionSyncTrigger(
	trigger: InstructionSyncTrigger,
): trigger is AutomaticInstructionSyncTrigger {
	return (
		AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS as readonly InstructionSyncTrigger[]
	).includes(trigger);
}

/**
 * The row an automatic start was decided on (Decision 56): `begin` refuses
 * the run with CONFIGURATION_CHANGED when the row it loads has another id or
 * generation.
 */
export type RepositorySyncExpectation = {
	syncId: string;
	generation: number;
};

export type InstructionSyncWorkflowInput = {
	projectId: string;
	organizationId: string;
	trigger: InstructionSyncTrigger;
	/** MANUAL only: the member who pressed "Sync now". */
	requesterUserId?: string;
	/** Automatic starts: the row the start was decided on (Decision 56). */
	expected?: RepositorySyncExpectation;
};

/**
 * What an automatic starter passes (Decisions 44, 47 and 56): any trigger
 * but MANUAL, no requester, because an automatic run acts as the row's
 * delegate, and the row the start was decided on. This type is wider than
 * eligibility: only a trigger in
 * `AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS` is actually automatic for `begin` and
 * `deriveSyncRunOutcome`. The starter's input type stays this wide so a
 * trigger a later migration adds needs no change to the starter, the
 * workflow input or `startRun`'s signature — only to
 * `AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS`, if it should also be automatic.
 */
export type AutomaticInstructionSyncWorkflowInput = {
	projectId: string;
	organizationId: string;
	trigger: Exclude<InstructionSyncTrigger, "MANUAL">;
	/** The claimed or pushed row; the poll and the webhook always pass it. */
	expected?: RepositorySyncExpectation;
};

/** Captured once by `begin`; no later step re-reads the configuration. */
export type SyncRunContext = {
	projectId: string;
	organizationId: string;
	syncId: string;
	generation: number;
	repositoryIntegrationId: string;
	ref: string;
	rootPath: string;
	actingUserId: string;
	trigger: InstructionSyncTrigger;
	/** `<syncId>:<workflow run id>`: the run row's id and the snapshot's `syncRunKey`. */
	runKey: string;
};

export type BeginSyncRunInput = InstructionSyncWorkflowInput & {
	workflowRunId: string;
};

export type BeginSyncRunResult =
	| { ok: true; context: SyncRunContext }
	| { ok: false; error: InstructionSyncErrorCode; context?: SyncRunContext }
	| {
			ok: false;
			skipped: "automatic_disabled" | "paused";
			context: SyncRunContext;
	  };

export type AcquireTreeResult =
	| { outcome: "unchanged"; commitSha: string }
	| { outcome: "staged"; snapshotId: string; commitSha: string | null };

/**
 * `ApplicationFailure.details[0]` of every typed acquisition failure. No
 * user content: no path, no URL, no stderr (spec §8.3).
 */
export type SyncFailureDetails = {
	commitSha?: string;
	snapshotId?: string;
	keptCount?: number;
	/** A planner refusal code, e.g. `duplicate_path`. Never the path. */
	refusal?: string;
};

export type AwaitSnapshotSettledInput = {
	snapshotId: string;
	/** How long one attempt waits for the child to close. Default 10 minutes. */
	maxWaitMs?: number;
	/** How often it asks. Default 5 seconds. */
	pollMs?: number;
};
/**
 * `childResult` is the closed child's own result when Temporal still has it,
 * so an adopted child's publish refusal reason is not lost.
 */
export type AwaitSnapshotSettledResult = {
	settled: boolean;
	childResult?: SnapshotChildResult;
};

/** `projectInstructionSnapshotWorkflow`'s result. */
export type SnapshotChildResult = {
	status: "READY" | "REJECTED";
	published: boolean;
	publishReason?: string;
};

export type RecordSyncRunInput = {
	projectId: string;
	organizationId: string;
	trigger: InstructionSyncTrigger;
	/**
	 * The workflow's own run id, so `record` can rebuild the run key
	 * (`<syncId>:<workflowRunId>`) when `context` is null. Optional only for
	 * histories started before it existed.
	 */
	workflowRunId?: string;
	/**
	 * Null when `begin` found no configuration row, and also when `begin`
	 * threw or was cancelled, possibly AFTER inserting the run receipt:
	 * `record` then finds that receipt by the rebuilt run key.
	 */
	context: SyncRunContext | null;
	skipped: boolean;
	unchanged: boolean;
	snapshotId: string | null;
	commitSha: string | null;
	error: InstructionSyncErrorCode | null;
	childResult: SnapshotChildResult | null;
};

export type RecordSyncRunResult = {
	recorded: boolean;
	status:
		| "SUCCEEDED"
		| "UNCHANGED"
		| "NOT_PUBLISHED"
		| "REJECTED"
		| "FAILED"
		| "SKIPPED"
		| null;
};

/**
 * The repository-sync subjects the poll and the push webhook serve
 * (Decision 46). The poll workflow claims per kind from this list, because a
 * workflow cannot import the adapters; the activities and the webhook
 * resolve each kind's adapter in activities/lib/repository-sync-subjects.ts.
 * One kind in this PR. `satisfies` keeps every listed kind a database kind.
 */
export const REPOSITORY_SYNC_SUBJECT_KINDS = [
	"instructions",
] as const satisfies readonly RepositorySyncSubjectKind[];

/** Spec §6.1: one poll tick's whole budget. */
export const INSTRUCTION_SYNC_POLL_BUDGET_MS = 4 * 60 * 1000;

/**
 * The least budget a lane needs to dispatch a check, and a claim to be
 * worth making (Decision 32). It covers the 30 s ls-remote bound plus token
 * resolution and the fenced writes with 30 s to spare. The check's own
 * start-to-close stays 90 s as a per-attempt ceiling, and a row that would
 * be dispatched with less than this left keeps its two-minute lease instead.
 */
export const INSTRUCTION_SYNC_CHECK_RESERVE_MS = 60 * 1000;

/**
 * The check's start-to-close, and the least lease a lane needs left to
 * dispatch a claimed row (Decision 49). A row with less is left to expire:
 * the check could not finish before its lease did.
 */
export const INSTRUCTION_SYNC_CHECK_START_TO_CLOSE_MS = 90 * 1000;

/**
 * The most rows one poll tick claims (Fizzy #2685). Every claim wave and
 * every check is an activity round trip in the tick's history, and nothing
 * else bounds their number: a backlog of fast checks could record thousands
 * before the budget ends, within Temporal's limits but large to store and
 * slow to replay. At this cap a tick whose checks never wait records on the
 * order of 3,000 events, well under the server's 10,000-event warning. Rows
 * past it stay due and the next tick, five minutes on, claims them first.
 */
export const INSTRUCTION_SYNC_POLL_CLAIM_CAP = 400;

/**
 * One row the poll claimed (spec §6.1): the subject's claimed row, tagged
 * with its kind so the check resolves the same subject (Decision 46), with
 * `leaseUntil` as the ISO string a Temporal payload carries. Derived from
 * `@repo/database`'s type through a type-only import, so the two cannot
 * drift and the workflow bundle loads nothing.
 */
export type ClaimedInstructionSyncCheck = Omit<
	ClaimedRepositorySyncRow,
	"leaseUntil"
> & {
	kind: RepositorySyncSubjectKind;
	/** The `nextCheckAt` the claim wrote, to the millisecond: the lease (Decision 31). */
	leaseUntil: string;
};

export type InstructionSyncCheckInput = ClaimedInstructionSyncCheck & {
	/** The poll workflow's run id: a failure receipt is `<syncId>:<pollRunId>:<generation>`. */
	pollRunId: string;
	/**
	 * The poll's budget end, as an ISO string. The check stops itself 5 s
	 * before this or its lease, whichever is first, because a Temporal
	 * timeout does not stop an activity's JavaScript (Decision 50).
	 */
	deadlineAt: string;
};

/**
 * What one check did (spec §6.1). `stale`: the check lost its lease (it
 * expired, was re-claimed, a run or a re-configure moved the row, or the
 * sync was paused or turned off), reached its own deadline, or could not
 * tell whether its start went through, so nothing was written
 * (Decisions 48, 50 and 51).
 */
export type InstructionSyncCheckOutcome =
	| "started"
	| "already_running"
	| "evaluated"
	| "suppressed"
	| "ref_missing"
	| "permission_revoked"
	| "transient"
	| "stale";

export type InstructionSyncCheckResult = {
	outcome: InstructionSyncCheckOutcome;
};

/**
 * The poll workflow's result, summed over every subject kind: one count per
 * outcome, plus claims, thrown checks, `deferred` (rows claimed but left to
 * their leases, because the claim came back under the reserve or with too
 * little lease left to check them), and `claimFailed` (kinds whose claim
 * threw after its retries; Decision 52).
 */
export type InstructionSyncPollResult = {
	claimed: number;
	started: number;
	alreadyRunning: number;
	evaluated: number;
	suppressed: number;
	refMissing: number;
	permissionRevoked: number;
	transient: number;
	stale: number;
	failed: number;
	deferred: number;
	claimFailed: number;
};

/**
 * The poll workflow's optional input (Decision 52). The schedule passes
 * none, so the workflow serves every registered kind; the tests pass two
 * kinds to prove the rotation.
 */
export type InstructionSyncPollInput = {
	kinds?: readonly RepositorySyncSubjectKind[];
};
