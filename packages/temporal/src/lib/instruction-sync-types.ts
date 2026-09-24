/**
 * The vocabulary the Coding Instructions repository sync workflow shares with
 * its activities (design 2026-09-23 §5.2-§5.5).
 *
 * The workflow bundle imports this file, so it must stay pure: no imports, no
 * I/O, nothing that reads the clock or the environment.
 */

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

export type InstructionSyncTrigger = "MANUAL" | "POLL" | "WEBHOOK";

export type InstructionSyncWorkflowInput = {
	projectId: string;
	organizationId: string;
	trigger: InstructionSyncTrigger;
	/** MANUAL only: the member who pressed "Sync now". */
	requesterUserId?: string;
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
