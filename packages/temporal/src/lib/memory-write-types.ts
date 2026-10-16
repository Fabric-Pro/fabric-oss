/**
 * The vocabulary the Living Memory write workflow shares with its activities
 * and with the API that starts it (ADR-022). Pure: no runtime imports, no I/O,
 * nothing that reads the clock or the environment, so the workflow bundle may
 * import it. Payloads carry ids, codes and the typed outcome only; the bytes of
 * a write are read from storage by the activity that needs them.
 */
import type {
	MemoryWriteOutcome,
	MemoryWriteSettledStatus,
} from "./memory-write/outcome";

/** The registered workflow type, as the API starts it by name. */
export const MEMORY_WRITE_WORKFLOW_TYPE = "memoryWriteWorkflow";

/**
 * The queue the workflow runs on: the one the Coding Instructions direct
 * commit workflow uses. Its activities run on `fabric-worker`
 * (`INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE`), the worker image that has git.
 */
export const MEMORY_WRITE_WORKFLOW_TASK_QUEUE = "project-instructions";

/** The workflow's input: the receipt, and the tenant it belongs to. */
export type MemoryWriteWorkflowInput = {
	writeId: string;
	projectId: string;
	organizationId: string;
};

/**
 * What the activity that does the write answers: nothing to do (the receipt is
 * settled already, or gone), or how the write ended, to be recorded by the
 * workflow's own record activity. The activity never writes the receipt.
 */
export type MemoryWriteStepResult =
	| { kind: "stopped" }
	| { kind: "outcome"; outcome: MemoryWriteOutcome };

/** What `recordMemoryWriteOutcome` answers: the status the receipt holds now. */
export type RecordMemoryWriteOutcomeResult = {
	kind: "settled";
	status: MemoryWriteSettledStatus;
};

export type MemoryWriteWorkflowResult =
	| { kind: "stopped" }
	| { kind: "settled"; status: MemoryWriteSettledStatus };

/**
 * Attempts the activity that does the write gets. A failure worth another
 * attempt is rethrown until the last, which hands it back as the write's
 * `FAILED` outcome; the workflow's retry policy and the activity's own count
 * read this one number.
 */
export const MEMORY_WRITE_MAX_ATTEMPTS = 3;

/** Passes a direct push makes before the branch is called busy (the lease lost to a competing push each time). */
export const MEMORY_WRITE_MAX_PUSH_PASSES = 5;

export const MEMORY_WRITE_ACTIVITY_TIMEOUTS = {
	run: { startToCloseMs: 15 * 60_000, heartbeatMs: 60_000 },
	/** The write that records an outcome: a database write and an audit row. */
	record: { startToCloseMs: 60_000 },
	/** Asking the sync to take the pushed head: a database read and a workflow start. */
	syncKick: { startToCloseMs: 60_000 },
} as const;

/**
 * The failure types the record never retries, because the same write would be
 * refused again: the typed non-retryable failures the record activities throw,
 * and Prisma's own validation error.
 */
export const MEMORY_WRITE_RECORD_NON_RETRYABLE_ERROR_TYPES = [
	"MEMORY_WRITE_MISSING",
	"MEMORY_WRITE_OUTCOME_INVALID",
	"RECORD_REJECTED",
	"PrismaClientValidationError",
];

/**
 * The retry policy of the activity that records an outcome: a commit that is
 * on the branch cannot be un-pushed, so a database that is briefly unreachable
 * must not leave the receipt pending. Backed off from 5 s to a minute for at
 * most 20 attempts (about twenty minutes), which fits the workflow's execution
 * timeout; a record that is still failing then is reported.
 */
export const MEMORY_WRITE_RECORD_RETRY = {
	initialInterval: "5 seconds" as const,
	backoffCoefficient: 2,
	maximumInterval: "1 minute" as const,
	maximumAttempts: 20,
	nonRetryableErrorTypes: MEMORY_WRITE_RECORD_NON_RETRYABLE_ERROR_TYPES,
};

/** The retry policy of the report that follows a record that gave up: it is best effort. */
export const MEMORY_WRITE_REPORT_RETRY = {
	initialInterval: "5 seconds" as const,
	backoffCoefficient: 2,
	maximumAttempts: 5,
};

/**
 * The retry policy of the sync kick. A kick that never lands is not a write
 * failure: the Living Memory poll or the push webhook takes the new head anyway.
 */
export const MEMORY_WRITE_SYNC_KICK_RETRY = {
	initialInterval: "10 seconds" as const,
	backoffCoefficient: 2,
	maximumInterval: "1 minute" as const,
	maximumAttempts: 3,
};

/**
 * How long a write's workflow may run, end to end: the write's attempts, the
 * record's attempts and the sync kick fit well inside it. A receipt that is
 * still `PENDING` after it has nothing behind it, and no longer counts toward
 * the pending cap (`MEMORY_WRITE_PENDING_WINDOW_MS`).
 */
export const MEMORY_WRITE_WORKFLOW_EXECUTION_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * How far back a `PENDING` receipt counts toward a member's cap of pending
 * writes in a project: longer than the workflow can run, so a receipt older
 * than this has no workflow behind it.
 */
export const MEMORY_WRITE_PENDING_WINDOW_MS = 3 * 60 * 60_000;

/** The most `PENDING` writes one member has in one project. */
export const MEMORY_WRITE_MAX_PENDING = 5;

/** How far back an identical request from the same member returns the receipt it already has. */
export const MEMORY_WRITE_DEDUPE_WINDOW_MS = 2 * 60 * 60_000;

/** The code a receipt is recorded `FAILED` with when the record of its outcome gave up. */
export const MEMORY_WRITE_SETTLE_FAILED_CODE = "SETTLE_FAILED";
