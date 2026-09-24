/**
 * The vocabulary the Living Memory repository sync workflow shares with its
 * activities (design 2026-09-23 §5.2–§5.5, Fizzy #2657).
 *
 * The workflow bundle imports this file, so it must stay pure: no imports,
 * no I/O, nothing that reads the clock or the environment.
 */

/**
 * `ProjectContextSyncError` (§5.5), value for value the Prisma enum of the
 * same name. `@repo/database` cannot be imported here (the workflow sandbox
 * loads this file), so the activity module pins the two together at compile
 * time and `context-sync-types.test.ts` pins them at run time.
 */
const CONTEXT_SYNC_ERROR_CODES = [
	"NOT_CONFIGURED",
	"INTEGRATION_UNAVAILABLE",
	"PERMISSION_DENIED",
	"RUN_IN_PROGRESS",
	"REF_MISSING",
	"PATHS_MISSING",
	"LIMITS_EXCEEDED",
	"CLONE_FAILED",
	"STORE_FAILED",
	"CONFIGURATION_CHANGED",
	"SUPERSEDED",
	"INTERRUPTED",
] as const;
export type ProjectContextSyncError = (typeof CONTEXT_SYNC_ERROR_CODES)[number];

/** What the sync activity's retry policy retries (§5.2). */
const RETRYABLE_CONTEXT_SYNC_ERRORS: readonly ProjectContextSyncError[] = [
	"CLONE_FAILED",
	"INTEGRATION_UNAVAILABLE",
	"STORE_FAILED",
];

/** Every other typed failure is final for the run (§5.2). */
export const NON_RETRYABLE_CONTEXT_SYNC_ERRORS: readonly ProjectContextSyncError[] =
	CONTEXT_SYNC_ERROR_CODES.filter(
		(code) => !RETRYABLE_CONTEXT_SYNC_ERRORS.includes(code),
	);

export function isContextSyncErrorCode(
	value: unknown,
): value is ProjectContextSyncError {
	return (
		typeof value === "string" &&
		(CONTEXT_SYNC_ERROR_CODES as readonly string[]).includes(value)
	);
}

/** `ProjectContextSyncRunStatus`, as `record` writes it (§5.4). */
export type ContextSyncRunStatus =
	| "SUCCEEDED"
	| "PARTIAL"
	| "UNCHANGED"
	| "FAILED";

/** `ProjectContextSyncTrigger`: this slice has manual runs only. */
export type ContextSyncTrigger = "MANUAL";

/**
 * The workflow's input. MUST stay the shape
 * `packages/api/modules/projects/lib/context-repository-sync-workflow.ts`
 * starts it with (`ContextRepositorySyncWorkflowInput`).
 */
export type ContextSyncWorkflowInput = {
	projectId: string;
	organizationId: string;
	trigger: ContextSyncTrigger;
	/** The member who pressed "Sync now"; the run acts as them. */
	requesterUserId: string;
};

/**
 * Everything a run needs, captured once by `begin` from the configuration
 * row under lock 1 (§4.2, §5.3.0). No later step re-reads the configuration:
 * every mutation is fenced on `(syncId, generation, runKey)` instead (§4.5).
 */
export type ContextSyncFrozenContext = {
	projectId: string;
	organizationId: string;
	syncId: string;
	generation: number;
	/** `<syncId>:<workflow run id>`: the run row's id. */
	runKey: string;
	trigger: ContextSyncTrigger;
	repositoryIntegrationId: string;
	/** Branch name, without `refs/heads/`. */
	ref: string;
	/** Canonical selected paths; `[""]` is the whole repository. */
	paths: string[];
	actingUserId: string;
};

/** The run key of a configuration's run (§4.2): `<syncId>:<workflow run id>`. */
export function contextSyncRunKey(
	syncId: string,
	workflowRunId: string,
): string {
	return `${syncId}:${workflowRunId}`;
}

export type BeginContextSyncRunInput = ContextSyncWorkflowInput & {
	/** The workflow's own run id: the second half of the run key. */
	workflowRunId: string;
};

/**
 * `begin`'s answer. A refusal is a value, never a throw: `NOT_CONFIGURED`
 * carries no context (there is no configuration to key a receipt on); every
 * other refusal carries the context of the finished receipt it inserted.
 */
export type BeginContextSyncRunResult =
	| { ok: true; context: ContextSyncFrozenContext }
	| {
			ok: false;
			error: ProjectContextSyncError;
			context?: ContextSyncFrozenContext;
	  };

/**
 * How many attempts the workflow gives `begin`. `begin` reads it too: a
 * predecessor it could not describe is retried (a thrown, retryable
 * failure) until the last attempt, which refuses with `RUN_IN_PROGRESS`
 * instead so the refusal has a receipt (§5.3.0 step 3).
 */
export const CONTEXT_SYNC_BEGIN_MAX_ATTEMPTS = 5;

/**
 * `ApplicationFailure.details[0]` of every typed sync failure (§5.5): the
 * pinned commit when there is one, and plain counts. No path, no URL, no
 * stderr, no content.
 */
export type ContextSyncFailureDetails = {
	commitSha?: string;
	/** Named counters (entries seen, keys kept, bytes read, …). */
	counts?: Record<string, number>;
};

/**
 * `syncContextTreeFromRepository`'s answer (§5.3.1 step 10). The counts live
 * on the run row's ledger, which `record` reads; only the commit travels
 * through history.
 */
export type SyncContextTreeResult = {
	outcome: "applied";
	commitSha: string;
};

export type RecordContextSyncRunInput = {
	projectId: string;
	organizationId: string;
	trigger: ContextSyncTrigger;
	/**
	 * The workflow's own run id, so `record` can rebuild the run key when
	 * `context` is null: `begin` threw, or its answer was lost to a
	 * cancellation, possibly AFTER its receipt committed.
	 */
	workflowRunId: string;
	context: ContextSyncFrozenContext | null;
	/** A `begin` refusal, or the sync activity's typed failure. */
	error: ProjectContextSyncError | null;
	/**
	 * The workflow was cancelled before the run finished. Not a typed
	 * failure the workflow classified: `record` completes such a run as
	 * `FAILED` / `INTERRUPTED`, the verdict reconciliation gives a run
	 * whose execution stopped (§5.3.0 step 3).
	 */
	cancelled: boolean;
	/** The commit the sync answered with or named in its failure details. */
	commitSha: string | null;
};

/**
 * `record`'s answer and the workflow's result. `recorded` is false when this
 * delivery completed nothing: the receipt was already finished (its stored
 * verdict is returned) or there is none.
 */
export type RecordContextSyncRunResult = {
	recorded: boolean;
	status: ContextSyncRunStatus | null;
	error: ProjectContextSyncError | null;
};
