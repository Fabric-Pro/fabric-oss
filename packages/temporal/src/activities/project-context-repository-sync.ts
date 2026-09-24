/**
 * Living Memory repository sync activities (design 2026-09-23 §5.3, §5.4,
 * Fizzy #2657): `begin`, the sync itself, and `record`, all on the
 * `fabric-worker` queue. The activities barrel re-exports this module, so
 * EVERY export here becomes a schedulable activity: helpers stay unexported
 * or live in ./lib.
 *
 * Lock order everywhere (§4.5): the configuration row, then the run row. No
 * transaction here calls Temporal or any network while holding them: `begin`
 * describes its predecessors BEFORE it locks, then revalidates under the
 * lock, and the sync publishes, drains and starts embeddings only after the
 * batch that led to them has committed.
 */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
	acquireContextRepositorySyncRunKey,
	applyRepositoryContextBatch,
	CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS,
	CONTEXT_SYNC_UNFINISHED_RUNS_LIMIT,
	type ContextRepositorySyncRunLedger,
	type ContextSyncError,
	type ContextSyncPlan,
	canCreateProjectContexts,
	completeContextRepositorySyncRun,
	db,
	findContextRepositorySyncRunReceiptByWorkflowRunId,
	getContextRepositorySync,
	getContextRepositorySyncForUpdate,
	getContextRepositorySyncRun,
	getContextRepositorySyncRunForUpdate,
	getContextSyncIntegration,
	getProjectRepoIntegration,
	getUserById,
	hashContextContent,
	insertContextRepositorySyncRun,
	type LockedContextRepositorySync,
	listContextRepositorySyncAwaitingIndex,
	listPruneCandidates,
	listUnfinishedContextRepositorySyncRuns,
	mergeContextRepositorySyncRunOutcomes,
	type Prisma,
	pinContextRepositorySyncRunCommit,
	pruneRepositoryContextBatch,
	type RepositoryContextFile,
	recordContextRepositorySyncLastApplied,
	recordContextRepositorySyncPrune,
	releaseContextRepositorySyncRunKey,
	type ContextSyncTrigger as StoredContextSyncTrigger,
	withContextRepositorySyncRunFence,
	writeContextRepositorySyncRunPlan,
	writeContextRepositorySyncScheduling,
} from "@repo/database";
import { logger } from "@repo/logs";
import { emitContextChange } from "@repo/utils/realtime-emit";
import {
	ApplicationFailure,
	activityInfo,
	CancelledFailure,
} from "@temporalio/activity";
import { getTemporalClient } from "../client";
import { startContextEmbeddingWorkflow } from "../lib/context-embedding-start";
import {
	type BeginContextSyncRunInput,
	type BeginContextSyncRunResult,
	CONTEXT_SYNC_BEGIN_MAX_ATTEMPTS,
	type ContextSyncFailureDetails,
	type ContextSyncFrozenContext,
	type ContextSyncTrigger,
	contextSyncRunKey,
	isAutomaticContextSyncTrigger,
	type ProjectContextSyncError,
	type RecordContextSyncRunInput,
	type RecordContextSyncRunResult,
	type SyncContextTreeResult,
} from "../lib/context-sync-types";
import { drainPendingVectorCleanup } from "../lib/delete-channel-context";
import {
	requestAbortSignal,
	safeHeartbeat,
	withHeartbeatTicker,
} from "./lib/activity-liveness";
import {
	type ContextSyncExecutionState,
	describeContextSyncExecutions,
} from "./lib/context-sync-describe";
import {
	type ContextInventoryEntry,
	listContextInventory,
} from "./lib/context-sync-inventory";
import {
	type AttentionItem,
	buildContextSyncPlan,
	type ContextIgnorePolicy,
	type ContextSyncCandidate,
	contextIgnorePathFor,
	createPruneEligibility,
	ignorePolicyForEntry,
	ignorePolicyFromBytes,
	MAX_CONTEXT_SYNC_KEPT,
	MAX_CONTEXT_SYNC_TOTAL_BYTES,
	planContextTree,
	repositoryPathsForKeys,
	type SelectedPathShape,
	selectedPathShapes,
} from "./lib/context-sync-plan";
import {
	deriveContextSyncRunVerdict,
	deriveContextSyncScheduling,
	EMPTY_CONTEXT_SYNC_RUN_COUNTS,
	recordContextSyncCompletedAudit,
	tallyContextSyncRun,
} from "./lib/context-sync-record";
import {
	classifyContextBytes,
	MAX_CONTEXT_FILE_BYTES,
	MAX_CONTEXT_IGNORE_BYTES,
} from "./lib/context-sync-rules";
import {
	credentialFreeUrl,
	fetchPinnedCommit,
	MAX_INVENTORY_ENTRIES,
	readBlobCapped,
	redactSecrets,
	revParseHead,
	sparseCheckout,
} from "./lib/instruction-sync-git";
import {
	createSyncRunDir,
	removeSyncRunDir,
} from "./lib/instruction-sync-temp";
import {
	cloneWithAuthRecovery,
	gitStepFailureCode,
	logGitFailure,
} from "./lib/repository-sync-clone";

/**
 * The workflow's error union and the Prisma enum are one set (§5.5): each
 * of these compiles only while every value of one is a value of the other.
 */
function toStoredError(error: ProjectContextSyncError): ContextSyncError {
	return error;
}
function fromStoredError(error: ContextSyncError): ProjectContextSyncError {
	return error;
}
/** The same pin for the trigger (§11.1): the workflow's union is the Prisma enum. */
function toStoredTrigger(
	trigger: ContextSyncTrigger,
): StoredContextSyncTrigger {
	return trigger;
}
function fromStoredTrigger(
	trigger: StoredContextSyncTrigger,
): ContextSyncTrigger {
	return trigger;
}

// ---------------------------------------------------------------------------
// begin (§5.3.0)
// ---------------------------------------------------------------------------

/** Read → describe → lock-and-revalidate passes before `STORE_FAILED` (§5.3.0 step 4). */
const BEGIN_REVALIDATION_PASSES = 3;

/** Thrown inside the lock to roll back a pass that found moved state. */
class BeginStateChanged extends Error {}

type BeginPass =
	| { kind: "result"; result: BeginContextSyncRunResult }
	/** A predecessor could not be described; retry the activity. */
	| { kind: "undescribed" }
	| { kind: "changed" };

/**
 * Open the run (§5.3.0): read without locks, describe each unfinished
 * predecessor's exact execution without locks (bounded), then lock the
 * configuration and revalidate what was read.
 *
 * - A receipt for this run key already exists: an unfinished one this run
 *   still holds is returned as it was frozen (a retried `begin`); a finished
 *   one is `SUPERSEDED` and touches nothing (a delayed attempt of an
 *   execution reconciliation already closed).
 * - Predecessors Temporal reports closed or not found are completed
 *   `FAILED` / `INTERRUPTED`, releasing the key when they hold it.
 * - A predecessor running, one that could not be described on the last
 *   attempt, or a key another run holds → `RUN_IN_PROGRESS`, never a
 *   takeover. On an earlier attempt an undescribed predecessor throws a
 *   retryable failure instead, so Temporal asks again after a back-off.
 * - An automatic run (POLL, WEBHOOK; §11.1) is skipped, with nothing
 *   written, while automatic sync is off or paused, and refused
 *   `CONFIGURATION_CHANGED` when the configuration is no longer the row its
 *   start was decided on (`expected`). It acts as the configuration's
 *   `userId`, read under the lock; a manual run acts as its requester.
 * - Then the integration must be `ACTIVE` and the acting member must hold
 *   `CONTEXT_CREATE`, read through the transaction.
 * - Refusals insert a FINISHED receipt (with its completed audit row and its
 *   scheduling effect) so history shows them; `NOT_CONFIGURED` has no
 *   configuration to key one on and inserts nothing.
 * - Otherwise insert the receipt with the frozen context and take the key.
 *
 * State that moved between the read and the lock (a receipt vanished, was
 * completed by someone else, or a new one appeared) rolls back and starts
 * again, three times, then fails `STORE_FAILED` (retryable).
 */
export async function beginContextRepositorySyncRun(
	input: BeginContextSyncRunInput,
): Promise<BeginContextSyncRunResult> {
	if (
		!(
			input.trigger === "MANUAL" ||
			isAutomaticContextSyncTrigger(input.trigger)
		) ||
		(input.trigger === "MANUAL" && !input.requesterUserId) ||
		!input.workflowRunId
	) {
		throw ApplicationFailure.nonRetryable(
			"A Living Memory sync needs a known trigger, the requesting member of a manual run, and the workflow run id",
			"CONTEXT_SYNC_INPUT_INVALID",
		);
	}
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	const lastAttempt = currentAttempt() >= CONTEXT_SYNC_BEGIN_MAX_ATTEMPTS;

	for (let pass = 0; pass < BEGIN_REVALIDATION_PASSES; pass++) {
		// 1. Read, no lock. Tenant-scoped: a configuration of another
		// organization is not this run's.
		const sync = await getContextRepositorySync(
			input.projectId,
			input.organizationId,
		);
		if (!sync) {
			return { ok: false, error: "NOT_CONFIGURED" };
		}
		const runKey = contextSyncRunKey(sync.id, input.workflowRunId);
		const receipt = await getContextRepositorySyncRun(runKey, scope);
		const observedReceipt: ReceiptState = receipt
			? receipt.finishedAt
				? "finished"
				: "unfinished"
			: "absent";
		// A run that already has a receipt answers from it; only a new run
		// needs its predecessors.
		const observedPredecessors =
			observedReceipt === "absent"
				? (await listUnfinishedContextRepositorySyncRuns(sync.id))
						.map((run) => run.id)
						.filter((id) => id !== runKey)
				: [];

		// 2. Describe, no lock, 5 s each and 20 s in all.
		const states = await describeContextSyncExecutions({
			projectId: input.projectId,
			syncId: sync.id,
			runKeys: observedPredecessors,
		});

		// 3. Lock and revalidate.
		let outcome: BeginPass;
		try {
			outcome = await db.$transaction(
				(tx) =>
					beginUnderLock(tx, {
						input,
						syncId: sync.id,
						runKey,
						observedReceipt,
						observedPredecessors,
						states,
						lastAttempt,
					}),
				{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
			);
		} catch (error) {
			if (error instanceof BeginStateChanged) {
				continue;
			}
			throw error;
		}
		if (outcome.kind === "changed") {
			continue;
		}
		if (outcome.kind === "undescribed") {
			throw ApplicationFailure.retryable(
				"A previous Living Memory sync run could not be described; asking again",
				"RUN_IN_PROGRESS",
			);
		}
		return outcome.result;
	}
	throw ApplicationFailure.retryable(
		"The Living Memory sync's runs kept changing while this run began",
		"STORE_FAILED",
	);
}

type ReceiptState = "absent" | "unfinished" | "finished";

function currentAttempt(): number {
	try {
		return activityInfo().attempt;
	} catch {
		// Outside an activity (unit tests): a first attempt.
		return 1;
	}
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	const set = new Set(a);
	return b.every((id) => set.has(id));
}

function frozenFromReceipt(
	input: BeginContextSyncRunInput,
	run: ContextRepositorySyncRunLedger,
): ContextSyncFrozenContext {
	return {
		projectId: input.projectId,
		organizationId: input.organizationId,
		syncId: run.syncId,
		generation: run.generation,
		runKey: run.id,
		trigger: fromStoredTrigger(run.trigger),
		repositoryIntegrationId: run.context.repositoryIntegrationId,
		ref: run.context.ref,
		paths: [...run.context.paths],
		actingUserId: run.context.actingUserId,
	};
}

function frozenFromConfiguration(
	input: BeginContextSyncRunInput,
	sync: LockedContextRepositorySync,
	runKey: string,
): ContextSyncFrozenContext {
	// MANUAL acts as whoever pressed "Sync now"; an automatic run acts as the
	// configuration's member NOW, so a run queued before a re-configure acts
	// as the new one against the new configuration (as the instructions
	// sync's `begin` does).
	const actingUserId =
		input.trigger === "MANUAL" ? input.requesterUserId : sync.userId;
	if (!actingUserId) {
		// The input check above makes this unreachable.
		throw ApplicationFailure.nonRetryable(
			"A manual Living Memory sync needs the requesting member",
			"CONTEXT_SYNC_INPUT_INVALID",
		);
	}
	return {
		projectId: input.projectId,
		organizationId: input.organizationId,
		syncId: sync.id,
		generation: sync.generation,
		runKey,
		trigger: input.trigger,
		repositoryIntegrationId: sync.repositoryIntegrationId,
		ref: sync.ref,
		paths: [...sync.paths],
		actingUserId,
	};
}

async function beginUnderLock(
	tx: Prisma.TransactionClient,
	pass: {
		input: BeginContextSyncRunInput;
		syncId: string;
		runKey: string;
		observedReceipt: ReceiptState;
		observedPredecessors: readonly string[];
		states: ReadonlyMap<string, ContextSyncExecutionState>;
		lastAttempt: boolean;
	},
): Promise<BeginPass> {
	const { input, runKey } = pass;
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	// Lock 1. Gone (or replaced by a new configuration) since the read:
	// read again, and the next read decides NOT_CONFIGURED.
	const sync = await getContextRepositorySyncForUpdate(
		tx,
		pass.syncId,
		scope,
	);
	if (!sync) {
		return { kind: "changed" };
	}

	// Lock 3 on this run's own receipt, after lock 1.
	const own = await getContextRepositorySyncRunForUpdate(tx, runKey);
	const receipt: ReceiptState =
		own.status === "ok" ? "unfinished" : own.run ? "finished" : "absent";
	if (receipt !== pass.observedReceipt) {
		return { kind: "changed" };
	}
	if (own.status !== "ok") {
		if (own.run) {
			// Finished: reconciliation (or `record`) closed this run while
			// this attempt was delayed. Nothing is written, and the key —
			// perhaps a successor's now — is left alone.
			return {
				kind: "result",
				result: { ok: false, error: "SUPERSEDED" },
			};
		}
	} else {
		const run = own.run;
		const context = frozenFromReceipt(input, run);
		if (
			run.syncId !== sync.id ||
			run.projectId !== input.projectId ||
			run.organizationId !== input.organizationId ||
			sync.activeRunKey !== runKey
		) {
			// An unfinished receipt this run no longer holds: every fenced
			// write would refuse it. `record` completes it as SUPERSEDED.
			return {
				kind: "result",
				result: { ok: false, error: "SUPERSEDED", context },
			};
		}
		if (run.generation !== sync.generation) {
			// Re-configured since this run began: fenced out (§4.5).
			return {
				kind: "result",
				result: { ok: false, error: "CONFIGURATION_CHANGED", context },
			};
		}
		// A retried `begin`: the run as it was frozen.
		return { kind: "result", result: { ok: true, context } };
	}

	// A new run. An automatic one is eligible only while automatic sync is on
	// and unpaused (§11.1). Checked before `expected`, as the instructions
	// sync does: turning automatic sync off re-configures the row, and that
	// must read as a skip, not as a warning-severity configuration change.
	// A skip writes nothing: the run did nothing.
	if (isAutomaticContextSyncTrigger(input.trigger)) {
		if (!sync.automatic) {
			return {
				kind: "result",
				result: {
					ok: false,
					error: null,
					skipped: "automatic_disabled",
				},
			};
		}
		if (sync.automaticPausedReason !== null) {
			return {
				kind: "result",
				result: { ok: false, error: null, skipped: "paused" },
			};
		}
	}
	if (
		input.expected !== undefined &&
		(input.expected.syncId !== sync.id ||
			input.expected.generation !== sync.generation)
	) {
		// Decided on a row that has since been replaced or re-configured. The
		// re-configure made the sync due now, so the next check starts the
		// run for the configuration that is current.
		return refuse(
			tx,
			sync,
			frozenFromConfiguration(input, sync, runKey),
			"CONFIGURATION_CHANGED",
		);
	}

	// The unfinished predecessors must be the ones described.
	const predecessors = (
		await listUnfinishedContextRepositorySyncRuns(
			sync.id,
			CONTEXT_SYNC_UNFINISHED_RUNS_LIMIT,
			tx,
		)
	)
		.map((run) => run.id)
		.filter((id) => id !== runKey);
	if (!sameIds(predecessors, pass.observedPredecessors)) {
		return { kind: "changed" };
	}

	let activeRunKey = sync.activeRunKey;
	let running = false;
	let undescribed = false;
	for (const predecessor of predecessors) {
		const state = pass.states.get(predecessor) ?? "unknown";
		if (state === "running") {
			running = true;
			continue;
		}
		if (state === "unknown") {
			undescribed = true;
			continue;
		}
		// Closed or not found: its execution can never record it.
		const lock = await getContextRepositorySyncRunForUpdate(
			tx,
			predecessor,
		);
		if (lock.status !== "ok") {
			// Cannot happen while lock 1 is held; refuse to write past state
			// this pass did not see.
			throw new BeginStateChanged();
		}
		await completeContextRepositorySyncRun(tx, predecessor, {
			status: "FAILED",
			error: "INTERRUPTED",
		});
		if (activeRunKey === predecessor) {
			await releaseContextRepositorySyncRunKey(tx, sync.id, predecessor);
			activeRunKey = null;
		}
	}

	const context = frozenFromConfiguration(input, sync, runKey);
	if (undescribed && !running && !pass.lastAttempt) {
		// Commit what was completed, then ask Temporal again after a
		// back-off: "unknown" is never "closed".
		return { kind: "undescribed" };
	}
	if (running || undescribed || activeRunKey !== null) {
		return refuse(tx, sync, context, "RUN_IN_PROGRESS");
	}

	const integration = await getContextSyncIntegration(tx, {
		repositoryIntegrationId: sync.repositoryIntegrationId,
		projectId: input.projectId,
	});
	if (!integration || integration.status !== "ACTIVE") {
		return refuse(
			tx,
			sync,
			context,
			"INTEGRATION_UNAVAILABLE",
			integration,
		);
	}
	if (
		!(await canCreateProjectContexts(
			input.projectId,
			context.actingUserId,
			tx,
		))
	) {
		return refuse(tx, sync, context, "PERMISSION_DENIED", integration);
	}

	const { inserted } = await insertContextRepositorySyncRun(tx, {
		id: runKey,
		syncId: sync.id,
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: context.actingUserId,
		generation: sync.generation,
		context: {
			ref: context.ref,
			paths: context.paths,
			repositoryIntegrationId: context.repositoryIntegrationId,
			actingUserId: context.actingUserId,
		},
		trigger: toStoredTrigger(context.trigger),
		startedAt: new Date(),
	});
	if (
		!inserted ||
		!(await acquireContextRepositorySyncRunKey(tx, sync.id, runKey))
	) {
		// Neither can happen under lock 1 after the checks above.
		throw new BeginStateChanged();
	}
	return { kind: "result", result: { ok: true, context } };
}

/**
 * A refusal: its receipt, inserted already finished, its scheduling effect
 * (§11.1: a lost integration backs off, a revoked member pauses an automatic
 * sync), and its completed audit row, in the lock's transaction. `sync` is
 * the row lock 1 holds; its generation is the refusal's.
 */
async function refuse(
	tx: Prisma.TransactionClient,
	sync: LockedContextRepositorySync,
	context: ContextSyncFrozenContext,
	error: ProjectContextSyncError,
	integration?: { repositoryOwner: string; repositoryName: string } | null,
): Promise<BeginPass> {
	// The database's clock, read by lock 1 (Fizzy #2683): the receipt and
	// the next check are dated on it, not on this worker's clock.
	const now = sync.now ?? new Date();
	await insertContextRepositorySyncRun(tx, {
		id: context.runKey,
		syncId: context.syncId,
		projectId: context.projectId,
		organizationId: context.organizationId,
		userId: context.actingUserId,
		generation: context.generation,
		context: {
			ref: context.ref,
			paths: context.paths,
			repositoryIntegrationId: context.repositoryIntegrationId,
			actingUserId: context.actingUserId,
		},
		trigger: toStoredTrigger(context.trigger),
		startedAt: now,
		finished: { at: now, status: "FAILED", error: toStoredError(error) },
	});
	await writeContextRepositorySyncScheduling(tx, {
		sync,
		generation: context.generation,
		effect: deriveContextSyncScheduling({
			trigger: context.trigger,
			status: "FAILED",
			error,
			commitSha: null,
		}),
		now,
	});
	const label =
		integration === undefined
			? await getContextSyncIntegration(tx, {
					repositoryIntegrationId: context.repositoryIntegrationId,
					projectId: context.projectId,
				})
			: integration;
	await recordContextSyncCompletedAudit(tx, {
		projectId: context.projectId,
		organizationId: context.organizationId,
		syncId: context.syncId,
		runKey: context.runKey,
		actingUserId: context.actingUserId,
		trigger: context.trigger,
		repository: label
			? `${label.repositoryOwner}/${label.repositoryName}`
			: null,
		status: "FAILED",
		error,
		commitSha: null,
		counts: EMPTY_CONTEXT_SYNC_RUN_COUNTS,
	});
	return { kind: "result", result: { ok: false, error, context } };
}

// ---------------------------------------------------------------------------
// sync (§5.3.1, §5.3.2)
// ---------------------------------------------------------------------------

/** The activity's start-to-close timeout, as the workflow proxies it (§5.2). */
const SYNC_START_TO_CLOSE_MS = 20 * 60 * 1000;
/** Kept back from the attempt's budget for the last transaction and the clean-up. */
const SYNC_BUDGET_RESERVE_MS = 60 * 1000;
/** The least budget an attempt starts with, however late it was scheduled. */
const SYNC_MIN_BUDGET_MS = 30 * 1000;
/** Planned keys per apply transaction; managed rows per prune transaction (§5.3.1 steps 7–8). */
const SYNC_BATCH_SIZE = 50;
/** Managed rows read per page, for the prune and for the index step. */
const SYNC_PAGE_SIZE = 200;
/** The one bounded attempt at a prune batch's vector cleanup (§5.3.1 step 8). */
const SYNC_DRAIN_ATTEMPT_MS = 30_000;

const CONTEXT_SYNC_GIT_LOG = {
	event: "context.sync.git_failed",
	message: "[ContextSync] git command failed",
} as const;

/**
 * A typed sync failure (§5.5): a fixed message, the code as `type`, and
 * `details[0]` holding the pinned commit and plain counts only — never a
 * path, a URL, stderr or content. Never a `cause`.
 */
function contextSyncFailure(
	code: ProjectContextSyncError,
	details: ContextSyncFailureDetails = {},
	nonRetryable?: boolean,
): ApplicationFailure {
	return ApplicationFailure.create({
		type: code,
		message: `Repository sync failed: ${code}`,
		details: [details],
		...(nonRetryable === undefined ? {} : { nonRetryable }),
	});
}

/** Heartbeat details: counters only. */
type SyncProgress = {
	phase: string;
	entries: number;
	kept: number;
	applied: number;
	removed: number;
	indexed: number;
};

/** One attempt's working state. */
type SyncAttempt = {
	context: ContextSyncFrozenContext;
	/** The attempt's budget and the activity's cancellation, shared by every git call. */
	signal: AbortSignal;
	progress: SyncProgress;
	/** What every failure carries: the pinned commit, once there is one. */
	details: ContextSyncFailureDetails;
	/** The credential, redacted out of anything this attempt logs. */
	secrets: readonly string[];
	env: NodeJS.ProcessEnv;
	dir: string;
	/** Storage keys the ledger has decided, as last read under the run lock. */
	decided: Set<string>;
	/** `CONTEXT_CREATE` re-checked in this attempt's first apply / prune batch. */
	applyPermissionChecked: boolean;
	prunePermissionChecked: boolean;
	userName: string | null;
};

/**
 * Apply the selected paths of ONE pinned commit into the project's Living
 * Memory (§5.3.1), as the member who pressed "Sync now":
 *
 *  1–2. re-read the integration (not `ACTIVE`, or a URL carrying a query or
 *       fragment → `INTEGRATION_UNAVAILABLE`), then a treeless clone through
 *       the shared clone-with-auth-recovery;
 *  3. pin HEAD once (a fenced `commitSha IS NULL` write); an earlier
 *     attempt's different winner is fetched and used instead;
 *  4–7 (planning). With no stored plan: inventory the selected paths
 *     (`PATHS_MISSING` when none is there), evaluate each folder's
 *     `.contextignore`, plan every entry, check out the candidates, measure
 *     (`too-large` from the size, never read) and classify them, and write
 *     the plan receipt once (`WHERE plan IS NULL`). A stored plan is the
 *     membership as it stands: its keys' content is re-derived from the
 *     pinned commit, and a key the commit cannot reproduce is `CLONE_FAILED`;
 *  7. apply the planned keys in fenced batches of 50, skipping keys the
 *     ledger decided — re-read under the run lock — and re-checking
 *     `CONTEXT_CREATE` in the attempt's first batch;
 *  8. prune managed rows neither planned nor protected, in fenced batches of
 *     50 that queue their vector cleanup, each followed by one bounded drain;
 *  9. start an embedding for every managed row still unindexed;
 *  10. publish the change, remove the clone, answer the commit.
 *
 * A retry repeats only what is left: decided keys are skipped, deleted rows
 * are gone, and the index step runs again (§5.3.2). The fences map to
 * `CONFIGURATION_CHANGED` / `SUPERSEDED`; database, queue and budget
 * failures to `STORE_FAILED`; a cancellation is rethrown as itself.
 */
export async function syncContextTreeFromRepository(
	context: ContextSyncFrozenContext,
): Promise<SyncContextTreeResult> {
	const progress: SyncProgress = {
		phase: "start",
		entries: 0,
		kept: 0,
		applied: 0,
		removed: 0,
		indexed: 0,
	};
	return withHeartbeatTicker<SyncContextTreeResult>(
		async () => {
			const signal = requestAbortSignal(remainingSyncBudgetMs());
			const integration = await storeStep({}, [], () =>
				getProjectRepoIntegration(
					context.repositoryIntegrationId,
					context.projectId,
				),
			);
			const url = integration
				? credentialFreeUrl(integration.repositoryUrl)
				: null;
			if (
				!integration ||
				integration.status !== "ACTIVE" ||
				url === null
			) {
				throw contextSyncFailure("INTEGRATION_UNAVAILABLE", {}, true);
			}
			const runDir = await createSyncRunDir();
			try {
				const dir = path.join(runDir, "repo");
				let cloned: { env: NodeJS.ProcessEnv; token: string };
				try {
					cloned = await cloneWithAuthRecovery({
						integrationId: context.repositoryIntegrationId,
						projectId: context.projectId,
						userId: context.actingUserId,
						organizationId: context.organizationId,
						ref: context.ref,
						provider: integration.provider,
						url,
						runDir,
						dir,
						signal,
						log: CONTEXT_SYNC_GIT_LOG,
						reauthReason:
							"Repository authentication failed during a Living Memory sync; reconnect required.",
						fail: (code, nonRetryable) =>
							contextSyncFailure(code, {}, nonRetryable),
					});
				} catch (error) {
					throwIfCancelled(signal);
					throw error;
				}
				progress.phase = "cloned";
				safeHeartbeat(progress);
				return await runSyncAttempt({
					context,
					signal,
					progress,
					details: {},
					secrets: [cloned.token],
					env: cloned.env,
					dir,
					decided: new Set(),
					applyPermissionChecked: false,
					prunePermissionChecked: false,
					userName: null,
				});
			} finally {
				await removeSyncRunDir(runDir).catch(() => {});
			}
		},
		{ details: progress },
	);
}

async function runSyncAttempt(
	run: SyncAttempt,
): Promise<SyncContextTreeResult> {
	const { context } = run;

	// 3. Pin, once per run.
	const head = await gitStep(run, () =>
		revParseHead({ dir: run.dir, env: run.env, signal: run.signal }),
	);
	const pinned = await fenced(run, async (tx, locked) => ({
		...(await pinContextRepositorySyncRunCommit(tx, context.runKey, head)),
		decided: Object.keys(locked.run.outcomes),
	}));
	const commitSha = pinned.commitSha;
	run.details = { commitSha };
	run.decided = new Set(pinned.decided);
	if (commitSha !== head) {
		// An earlier attempt pinned another head: the run applies that one.
		await gitStep(run, () =>
			fetchPinnedCommit({
				dir: run.dir,
				sha: commitSha,
				env: run.env,
				signal: run.signal,
			}),
		);
		const moved = await gitStep(run, () =>
			revParseHead({ dir: run.dir, env: run.env, signal: run.signal }),
		);
		if (moved !== commitSha) {
			throw contextSyncFailure("CLONE_FAILED", run.details);
		}
	}
	setPhase(run, "pinned");

	// 4–7, the planning half: the stored plan, or a new one written once.
	let plan = pinned.plan;
	let inventory: ContextInventoryEntry[] | null = null;
	let contentPaths: ReadonlyMap<string, string> = new Map();
	if (!plan) {
		inventory = await readInventory(run, commitSha);
		const planned = await planFromInventory(run, inventory);
		// If another attempt of this run wrote a plan first, that one is the
		// membership, whatever this attempt planned.
		plan = (
			await fenced(run, (tx) =>
				writeContextRepositorySyncRunPlan(
					tx,
					context.runKey,
					planned.plan,
				),
			)
		).plan;
		contentPaths = planned.contentPaths;
	}
	const pending = plan.keptKeys.filter((key) => !run.decided.has(key));
	if (pending.some((key) => !contentPaths.has(key))) {
		// A stored plan: its keys, not a recomputed set, are what this attempt
		// applies; their content comes from the pinned commit again (§4.3).
		inventory ??= await readInventory(run, commitSha);
		const paths = repositoryPathsForKeys(pending, inventory);
		if (!paths) {
			throw contextSyncFailure("CLONE_FAILED", run.details);
		}
		await checkout(run, [...paths.values()]);
		contentPaths = paths;
	}
	run.progress.kept = plan.keptCount;

	await applyPlannedKeys(run, pending, contentPaths);
	await pruneManagedRows(run, plan);
	await startPendingIndexing(run);

	// 10. The final refresh for an open Context tab.
	await publishContextChange(run, "updated");
	return { outcome: "applied", commitSha };
}

/** Step 4: the pinned commit's entries at or under the selected paths. */
async function readInventory(
	run: SyncAttempt,
	commitSha: string,
): Promise<ContextInventoryEntry[]> {
	const listed = await gitStep(run, () =>
		listContextInventory({
			dir: run.dir,
			sha: commitSha,
			paths: run.context.paths,
			env: run.env,
			signal: run.signal,
			maxEntries: MAX_INVENTORY_ENTRIES,
		}),
	);
	if (!listed.ok) {
		throw contextSyncFailure("LIMITS_EXCEEDED", {
			...run.details,
			counts: { entryLimit: MAX_INVENTORY_ENTRIES },
		});
	}
	run.progress.entries = listed.entries.length;
	setPhase(run, "inventoried");
	return listed.entries;
}

/**
 * Steps 4–7 before the plan receipt: presence, ignore policies, the entry
 * plan, then the candidates' sizes and bytes. Attention items found by
 * measuring (`too-large`, `binary`, `empty`) join the receipt, so every
 * reason a key was held back is recorded before the first mutation.
 * `contentPaths` maps each kept key to its checked-out repository path.
 */
async function planFromInventory(
	run: SyncAttempt,
	entries: readonly ContextInventoryEntry[],
): Promise<{
	plan: ContextSyncPlan;
	contentPaths: Map<string, string>;
}> {
	const { paths } = run.context;
	const shapes = selectedPathShapes(paths, entries);
	if (shapes.every((shape) => shape.kind === "missing")) {
		// The circuit breaker: nothing selected is there, so nothing is
		// planned and nothing is pruned; the previous content remains.
		throw contextSyncFailure("PATHS_MISSING", run.details);
	}
	const policies = await readIgnorePolicies(run, shapes, entries);
	const tree = planContextTree({ paths, entries, shapes, policies });
	if (tree.candidates.length > MAX_CONTEXT_SYNC_KEPT) {
		throw contextSyncFailure("LIMITS_EXCEEDED", {
			...run.details,
			counts: { kept: tree.candidates.length },
		});
	}
	await checkout(
		run,
		tree.candidates.map((candidate) => candidate.repoPath),
	);

	const attention = [...tree.attention];
	const protectedKeys = new Set(tree.protectedKeys);
	const holdBack = (key: string, reason: AttentionItem["reason"]) => {
		attention.push({ key, reason });
		protectedKeys.add(key);
	};
	// Sizes first, from the checkout: an oversized file is never read.
	const readable: ContextSyncCandidate[] = [];
	let totalBytes = 0;
	for (const candidate of tree.candidates) {
		const size = await checkedOutSize(run, candidate.repoPath);
		if (size > MAX_CONTEXT_FILE_BYTES) {
			holdBack(candidate.key, "too-large");
			continue;
		}
		totalBytes += size;
		readable.push(candidate);
	}
	if (totalBytes > MAX_CONTEXT_SYNC_TOTAL_BYTES) {
		throw contextSyncFailure("LIMITS_EXCEEDED", {
			...run.details,
			counts: { kept: readable.length, bytes: totalBytes },
		});
	}
	// Then the bytes, one file at a time; only the verdict is kept.
	const contentPaths = new Map<string, string>();
	for (const candidate of readable) {
		const verdict = classifyContextBytes(
			await readCheckedOut(run, candidate.repoPath),
		);
		if (!verdict.ok) {
			holdBack(candidate.key, verdict.reason);
			continue;
		}
		contentPaths.set(candidate.key, candidate.repoPath);
	}
	setPhase(run, "planned");
	return {
		plan: buildContextSyncPlan({
			keptKeys: [...contentPaths.keys()],
			excludedCount: tree.excludedCount,
			attention,
			protectedKeys,
			protectedPrefixes: tree.protectedPrefixes,
			missingPaths: tree.missingPaths,
		}),
		contentPaths,
	};
}

/**
 * Step 6: each present selected folder's `.contextignore`. A regular file of
 * at most 64 KiB that is UTF-8 is its policy; none is the defaults; anything
 * else (a symlink, a submodule, larger, not text) cannot be evaluated.
 */
async function readIgnorePolicies(
	run: SyncAttempt,
	shapes: readonly SelectedPathShape[],
	entries: readonly ContextInventoryEntry[],
): Promise<Map<string, ContextIgnorePolicy>> {
	const folderByIgnorePath = new Map<string, string>();
	for (const shape of shapes) {
		if (shape.kind === "folder") {
			folderByIgnorePath.set(
				contextIgnorePathFor(shape.path),
				shape.path,
			);
		}
	}
	const ignoreEntries = new Map<string, ContextInventoryEntry>();
	for (const entry of entries) {
		const folder = folderByIgnorePath.get(entry.path);
		if (folder !== undefined) {
			ignoreEntries.set(folder, entry);
		}
	}
	const policies = new Map<string, ContextIgnorePolicy>();
	for (const folder of folderByIgnorePath.values()) {
		const entry = ignoreEntries.get(folder);
		const policy = ignorePolicyForEntry(entry);
		if (policy !== "read" || !entry) {
			policies.set(
				folder,
				policy === "read" ? { kind: "unreadable" } : policy,
			);
			continue;
		}
		const bytes = await gitStep(run, () =>
			readBlobCapped({
				dir: run.dir,
				oid: entry.oid,
				env: run.env,
				signal: run.signal,
				maxBytes: MAX_CONTEXT_IGNORE_BYTES,
			}),
		);
		policies.set(folder, ignorePolicyFromBytes(bytes));
	}
	return policies;
}

/** Materialise exactly these files; nothing to check out is not a git call. */
async function checkout(
	run: SyncAttempt,
	repoPaths: readonly string[],
): Promise<void> {
	if (repoPaths.length === 0) {
		return;
	}
	await gitStep(run, () =>
		sparseCheckout({
			dir: run.dir,
			repoPaths,
			env: run.env,
			signal: run.signal,
		}),
	);
	setPhase(run, "checked_out");
}

/** A checked-out planned file's size; one the checkout did not produce is a broken clone. */
async function checkedOutSize(
	run: SyncAttempt,
	repoPath: string,
): Promise<number> {
	const stat = await lstat(path.join(run.dir, repoPath)).catch(() => null);
	if (!stat?.isFile()) {
		throw contextSyncFailure("CLONE_FAILED", run.details);
	}
	return stat.size;
}

async function readCheckedOut(
	run: SyncAttempt,
	repoPath: string,
): Promise<Buffer> {
	try {
		return await readFile(path.join(run.dir, repoPath));
	} catch {
		throw contextSyncFailure("CLONE_FAILED", run.details);
	}
}

/**
 * A planned key's content, re-derived from the checkout at apply time. The
 * plan classified this commit's bytes as storable already, so a file that
 * is now missing, oversized or not text is one the commit cannot reproduce.
 */
async function readPlannedFile(
	run: SyncAttempt,
	key: string,
	repoPath: string | undefined,
): Promise<RepositoryContextFile> {
	if (repoPath === undefined) {
		throw contextSyncFailure("CLONE_FAILED", run.details);
	}
	if ((await checkedOutSize(run, repoPath)) > MAX_CONTEXT_FILE_BYTES) {
		throw contextSyncFailure("CLONE_FAILED", run.details);
	}
	const verdict = classifyContextBytes(await readCheckedOut(run, repoPath));
	if (!verdict.ok) {
		throw contextSyncFailure("CLONE_FAILED", run.details);
	}
	return {
		storageKey: key,
		content: verdict.content,
		contentHash: hashContextContent(verdict.content),
	};
}

/**
 * Step 7, the write half: the planned keys still undecided, in fenced
 * batches of 50. Each batch re-reads the ledger under the run lock and skips
 * what it holds, so a key is decided once per run, and merges its own
 * outcomes in the same transaction.
 */
async function applyPlannedKeys(
	run: SyncAttempt,
	pending: readonly string[],
	contentPaths: ReadonlyMap<string, string>,
): Promise<void> {
	const { context } = run;
	setPhase(run, "applying");
	for (let start = 0; start < pending.length; start += SYNC_BATCH_SIZE) {
		throwIfStopped(run);
		const keys = pending
			.slice(start, start + SYNC_BATCH_SIZE)
			.filter((key) => !run.decided.has(key));
		if (keys.length === 0) {
			continue;
		}
		const files: RepositoryContextFile[] = [];
		for (const key of keys) {
			files.push(await readPlannedFile(run, key, contentPaths.get(key)));
		}
		const batch = await fenced(run, async (tx, locked) => {
			if (!run.applyPermissionChecked) {
				await requireContextCreate(run, tx);
			}
			const outcomes = await applyRepositoryContextBatch(tx, {
				projectId: context.projectId,
				organizationId: context.organizationId,
				syncId: context.syncId,
				actingUserId: context.actingUserId,
				files,
				decided: new Set(Object.keys(locked.run.outcomes)),
			});
			const ledger = await mergeContextRepositorySyncRunOutcomes(
				tx,
				context.runKey,
				outcomes,
			);
			return { outcomes, ledger };
		});
		run.applyPermissionChecked = true;
		run.decided = new Set(Object.keys(batch.ledger));
		const decidedNow = Object.values(batch.outcomes);
		run.progress.applied += decidedNow.length;
		if (
			decidedNow.some(
				(outcome) =>
					outcome === "created" ||
					outcome === "updated" ||
					outcome === "adopted",
			)
		) {
			await publishContextChange(run, "updated");
		}
	}
}

/**
 * Step 8: every managed row of this sync that the plan neither keeps nor
 * protects, paged by key and deleted in fenced batches of 50. No positional
 * ledger: a retry finds the rows an earlier attempt deleted already gone.
 */
async function pruneManagedRows(
	run: SyncAttempt,
	plan: ContextSyncPlan,
): Promise<void> {
	const { context } = run;
	setPhase(run, "pruning");
	const eligible = createPruneEligibility(plan);
	let afterKey: string | null = null;
	let batch: Array<{
		id: string;
		sourcePath: string;
		contentHash: string | null;
	}> = [];
	for (;;) {
		throwIfStopped(run);
		const page = await storeStep(run.details, run.secrets, () =>
			listPruneCandidates(
				{
					projectId: context.projectId,
					organizationId: context.organizationId,
				},
				context.syncId,
				{ afterKey, limit: SYNC_PAGE_SIZE },
			),
		);
		for (const row of page) {
			if (eligible(row.sourcePath)) {
				batch.push(row);
			}
		}
		while (batch.length >= SYNC_BATCH_SIZE) {
			await pruneBatch(run, batch.slice(0, SYNC_BATCH_SIZE));
			batch = batch.slice(SYNC_BATCH_SIZE);
		}
		const last = page.at(-1);
		if (page.length < SYNC_PAGE_SIZE || !last) {
			break;
		}
		afterKey = last.sourcePath;
	}
	if (batch.length > 0) {
		await pruneBatch(run, batch);
	}
}

async function pruneBatch(
	run: SyncAttempt,
	rows: Array<{ id: string; sourcePath: string; contentHash: string | null }>,
): Promise<void> {
	const { context } = run;
	throwIfStopped(run);
	const pruned = await fenced(run, async (tx) => {
		if (!run.prunePermissionChecked) {
			await requireContextCreate(run, tx);
		}
		const result = await pruneRepositoryContextBatch(tx, {
			projectId: context.projectId,
			organizationId: context.organizationId,
			syncId: context.syncId,
			runKey: context.runKey,
			actingUserId: context.actingUserId,
			rows,
		});
		await recordContextRepositorySyncPrune(tx, context.runKey, {
			removed: result.deletedIds.length,
			conflicts: result.conflicts,
		});
		return result;
	});
	run.prunePermissionChecked = true;
	run.progress.removed += pruned.deletedIds.length;
	if (pruned.cleanupId !== null) {
		await drainPruneCleanup(run, pruned.cleanupId, pruned.deletedIds);
	}
	if (pruned.deletedIds.length > 0) {
		await publishContextChange(run, "deleted");
	}
}

/**
 * After a prune batch commits: one bounded attempt at the vector cleanup it
 * queued, through the sweep's own drain. Drained → the record is gone;
 * failed or slow → the record stays for the scheduled sweep (or an abandoned
 * attempt that completes later clears it), and the run carries on. No
 * counter is kept: the record carries the run key, and the receipt counts
 * the run's records still queued, live, whoever drains them.
 */
async function drainPruneCleanup(
	run: SyncAttempt,
	cleanupId: string,
	contextIds: string[],
): Promise<void> {
	const { context } = run;
	// The record exactly as `createPendingVectorCleanup` wrote it: an
	// organization's record carries no user.
	const drain = drainPendingVectorCleanup({
		id: cleanupId,
		projectId: context.projectId,
		contextIds,
		userId: null,
		organizationId: context.organizationId,
	});
	// A drain still running when the bound passes finishes (or fails) on its
	// own; it must not surface as an unhandled rejection.
	drain.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			drain,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("drain attempt timed out")),
					SYNC_DRAIN_ATTEMPT_MS,
				);
			}),
		]);
	} catch {
		logger.info(
			{
				event: "context.sync.cleanup_deferred",
				projectId: context.projectId,
				contexts: contextIds.length,
			},
			"[ContextSync] vector cleanup left to the sweep",
		);
		return;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Step 9: one embedding start per managed row still unindexed, each awaited.
 * Every batch has committed; a failed start fails the attempt `STORE_FAILED`
 * and its retry repeats only this step.
 */
async function startPendingIndexing(run: SyncAttempt): Promise<void> {
	const { context } = run;
	setPhase(run, "indexing");
	const client = await storeStep(run.details, run.secrets, () =>
		getTemporalClient(),
	);
	let afterKey: string | null = null;
	for (;;) {
		throwIfStopped(run);
		const page = await storeStep(run.details, run.secrets, () =>
			listContextRepositorySyncAwaitingIndex(
				{
					projectId: context.projectId,
					organizationId: context.organizationId,
				},
				context.syncId,
				{ afterKey, limit: SYNC_PAGE_SIZE },
			),
		);
		for (const row of page) {
			await storeStep(run.details, run.secrets, () =>
				startContextEmbeddingWorkflow(client, {
					contextId: row.id,
					projectId: context.projectId,
					userId: context.actingUserId,
					organizationId: context.organizationId,
					sourcePath: row.sourcePath,
					title: row.title,
					reembed: true,
				}),
			);
			run.progress.indexed++;
		}
		const last = page.at(-1);
		if (page.length < SYNC_PAGE_SIZE || !last) {
			break;
		}
		afterKey = last.sourcePath;
	}
}

/** The acting member still holds `CONTEXT_CREATE`, read through the fence's transaction. */
async function requireContextCreate(
	run: SyncAttempt,
	tx: Prisma.TransactionClient,
): Promise<void> {
	if (
		!(await canCreateProjectContexts(
			run.context.projectId,
			run.context.actingUserId,
			tx,
		))
	) {
		// Thrown inside the fence: the batch rolls back with it.
		throw contextSyncFailure("PERMISSION_DENIED", run.details);
	}
}

/**
 * Step 10 (and after every batch that changed rows): refresh an open Context
 * tab. The event names the sync, not one row — a batch changes many, and
 * the tab refetches its list on any `context_change`.
 */
async function publishContextChange(
	run: SyncAttempt,
	action: "updated" | "deleted",
): Promise<void> {
	if (run.userName === null) {
		run.userName = await getUserById(run.context.actingUserId).then(
			(user) => user?.name || "Anonymous",
			() => "Anonymous",
		);
	}
	await emitContextChange({
		projectId: run.context.projectId,
		contextId: run.context.syncId,
		action,
		userId: run.context.actingUserId,
		userName: run.userName,
		contextType: "TEXT",
	});
}

/**
 * One fenced transaction (§4.5) around `fn`: the fence's typed answers
 * become `CONFIGURATION_CHANGED` / `SUPERSEDED`, a typed failure `fn` threw
 * (`PERMISSION_DENIED`) passes through, anything else is `STORE_FAILED`.
 * Every answer carries the pinned commit.
 */
async function fenced<T>(
	run: SyncAttempt,
	fn: (
		tx: Prisma.TransactionClient,
		locked: { run: ContextRepositorySyncRunLedger },
	) => Promise<T>,
): Promise<T> {
	const { context } = run;
	const result = await storeStep(run.details, run.secrets, () =>
		withContextRepositorySyncRunFence(
			{
				syncId: context.syncId,
				generation: context.generation,
				runKey: context.runKey,
				projectId: context.projectId,
				organizationId: context.organizationId,
			},
			fn,
		),
	);
	if (result.status === "configuration-changed") {
		throw contextSyncFailure("CONFIGURATION_CHANGED", run.details);
	}
	if (result.status === "superseded") {
		throw contextSyncFailure("SUPERSEDED", run.details);
	}
	return result.value;
}

/** A database or queue step: its failure is `STORE_FAILED`; a typed failure passes. */
async function storeStep<T>(
	details: ContextSyncFailureDetails,
	secrets: readonly string[],
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		logStoreFailure(error, secrets);
		throw contextSyncFailure("STORE_FAILED", details);
	}
}

/**
 * The error's class and code only: a database error's message can quote
 * the values it was given, and those are repository content.
 */
function logStoreFailure(
	error: unknown,
	secrets: readonly string[] = [],
): void {
	const code = (error as { code?: unknown } | null)?.code;
	logger.warn(
		{
			event: "context.sync.store_failed",
			error: redactSecrets(
				error instanceof Error ? error.name : typeof error,
				secrets,
			),
			code: typeof code === "string" ? code : undefined,
		},
		"[ContextSync] a database or queue step failed",
	);
}

/** A git step after the clone: the watchdog is a limit, anything else a failed fetch. */
async function gitStep<T>(run: SyncAttempt, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throwIfCancelled(run.signal);
		logGitFailure(error, run.secrets, CONTEXT_SYNC_GIT_LOG);
		throw contextSyncFailure(gitStepFailureCode(error), run.details);
	}
}

/** A cancelled activity stops as cancelled, never as a sync failure. */
function throwIfCancelled(signal: AbortSignal): void {
	if (signal.aborted && signal.reason instanceof CancelledFailure) {
		throw signal.reason;
	}
}

/** Between batches: cancelled → rethrown; the attempt's budget spent → `STORE_FAILED`. */
function throwIfStopped(run: SyncAttempt): void {
	if (!run.signal.aborted) {
		return;
	}
	throwIfCancelled(run.signal);
	throw contextSyncFailure("STORE_FAILED", run.details);
}

function setPhase(run: SyncAttempt, phase: string): void {
	run.progress.phase = phase;
	safeHeartbeat(run.progress);
}

/**
 * What is left of this attempt's start-to-close timeout, less a reserve for
 * the last transaction and the clean-up: git must die before Temporal gives
 * up on the attempt.
 */
function remainingSyncBudgetMs(): number {
	let deadline = Date.now() + SYNC_START_TO_CLOSE_MS;
	try {
		const info = activityInfo();
		const scheduled = info.currentAttemptScheduledTimestampMs;
		const timeout = info.startToCloseTimeoutMs;
		if (
			Number.isFinite(scheduled) &&
			Number.isFinite(timeout) &&
			timeout > 0
		) {
			deadline = scheduled + timeout;
		}
	} catch {
		// Outside an activity (unit tests): the workflow's timeout from now.
	}
	return Math.max(
		SYNC_MIN_BUDGET_MS,
		deadline - Date.now() - SYNC_BUDGET_RESERVE_MS,
	);
}

// ---------------------------------------------------------------------------
// record (§5.4)
// ---------------------------------------------------------------------------

type RecordTarget = { runKey: string; syncId: string; begun: boolean };

/**
 * Complete the run's receipt once (§5.4), in one transaction, lock order
 * §4.5: lock 1 when the configuration still exists (a disconnect deletes
 * it; the receipt survives), then the run row, which must be unfinished —
 * otherwise the stored verdict is returned and NOTHING is written, so a
 * second delivery is a no-op.
 *
 * The status comes from the ledger (`deriveContextSyncRunVerdict`). On
 * EVERY terminal outcome the key is released when it names this run. When
 * the run wrote a plan and pinned a commit, and still holds the
 * configuration at its generation, the configuration names it as last
 * applied. While the configuration is still at the run's generation, the
 * verdict's scheduling effect (`deriveContextSyncScheduling`, §11.1) is
 * written under the same lock, as the instructions sync's completion does.
 * The completed audit row, with the run's own trigger, commits with the
 * receipt.
 *
 * Without a context (`begin` threw, or its answer was lost to a
 * cancellation, possibly after its receipt committed) the run key is rebuilt
 * from the current configuration's id and the workflow's run id. The receipt
 * outlives its configuration (no foreign key, Fizzy #2672), so "no receipt
 * under the current configuration" is not "nothing to record": when the
 * configuration is gone, or was replaced by one of another id, the receipt is
 * found by the workflow run id alone and completed `FAILED` /
 * `CONFIGURATION_CHANGED`, with no scheduling effect and its completed audit
 * row, as the instructions sync's `record` does. "Gone" is decided under the
 * lock: lock 1 on the receipt's own configuration finds no row. No receipt at
 * all (NOT_CONFIGURED, a skipped automatic run, another organization's run)
 * means nothing to record, and a finished one is left as it is.
 */
export async function recordContextRepositorySyncRun(
	input: RecordContextSyncRunInput,
): Promise<RecordContextSyncRunResult> {
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	const target = await recordTarget(input);
	if (!target) {
		return { recorded: false, status: null, error: null };
	}

	const written = await db.$transaction(
		(tx) => recordUnderLock(tx, input, target),
		{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
	);
	if (written) {
		return written;
	}
	// Finished already (or not this tenant's): answer from what is stored.
	const stored = await getContextRepositorySyncRun(target.runKey, scope);
	return {
		recorded: false,
		status: stored?.status ?? null,
		error: stored?.error ? fromStoredError(stored.error) : null,
	};
}

async function recordTarget(
	input: RecordContextSyncRunInput,
): Promise<RecordTarget | null> {
	if (input.context) {
		return {
			runKey: input.context.runKey,
			syncId: input.context.syncId,
			begun: true,
		};
	}
	if (!input.workflowRunId) {
		return null;
	}
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	// The current configuration's receipt for this run: one exact read.
	const sync = await getContextRepositorySync(
		input.projectId,
		input.organizationId,
	);
	if (sync) {
		const runKey = contextSyncRunKey(sync.id, input.workflowRunId);
		if (await getContextRepositorySyncRun(runKey, scope)) {
			return { runKey, syncId: sync.id, begun: false };
		}
	}
	// None there: begun under a configuration since switched off or
	// replaced, or never inserted.
	const receipt = await findContextRepositorySyncRunReceiptByWorkflowRunId(
		input.workflowRunId,
		scope,
	);
	if (!receipt) {
		return null;
	}
	return { runKey: receipt.id, syncId: receipt.syncId, begun: false };
}

async function recordUnderLock(
	tx: Prisma.TransactionClient,
	input: RecordContextSyncRunInput,
	target: RecordTarget,
): Promise<RecordContextSyncRunResult | null> {
	// Lock 1 when the configuration exists, then lock 3 (§4.5).
	const sync = await getContextRepositorySyncForUpdate(tx, target.syncId, {
		projectId: input.projectId,
		organizationId: input.organizationId,
	});
	const lock = await getContextRepositorySyncRunForUpdate(tx, target.runKey);
	if (lock.status !== "ok") {
		return null;
	}
	const run = lock.run;
	if (
		run.syncId !== target.syncId ||
		run.projectId !== input.projectId ||
		run.organizationId !== input.organizationId
	) {
		return null;
	}

	const counts = tallyContextSyncRun(run);
	// Without a context, a receipt whose configuration is gone (lock 1 found
	// no row by the receipt's own sync id) is CONFIGURATION_CHANGED, as when
	// `begin` itself reports it; whatever else the workflow saw is moot.
	const configurationGone = !target.begun && !sync;
	const verdict = deriveContextSyncRunVerdict({
		begun: target.begun,
		error: configurationGone ? "CONFIGURATION_CHANGED" : input.error,
		cancelled: configurationGone ? false : input.cancelled,
		counts,
	});
	const commitSha = run.commitSha ?? input.commitSha;
	const trigger = fromStoredTrigger(run.trigger);

	// Dated on the database's clock lock 1 read, when the configuration is
	// still there (Fizzy #2683); the scheduling write below reads the same.
	const completed = await completeContextRepositorySyncRun(tx, run.id, {
		status: verdict.status,
		error: verdict.error ? toStoredError(verdict.error) : null,
		...(sync?.now ? { now: sync.now } : {}),
	});

	if (sync) {
		// Last applied first: it is fenced on the key this run still holds.
		if (run.plan && run.commitSha && sync.generation === run.generation) {
			await recordContextRepositorySyncLastApplied(tx, {
				syncId: sync.id,
				generation: run.generation,
				runKey: run.id,
				commitSha: run.commitSha,
			});
		}
		// The schedule, fenced on the generation alone: no lease, because a
		// finishing run writes the real outcome whichever check started it.
		await writeContextRepositorySyncScheduling(tx, {
			sync,
			generation: run.generation,
			effect: deriveContextSyncScheduling({
				trigger,
				status: verdict.status,
				error: verdict.error,
				commitSha,
			}),
		});
		if (sync.activeRunKey === run.id) {
			await releaseContextRepositorySyncRunKey(tx, sync.id, run.id);
		}
	}

	const integration = await getContextSyncIntegration(tx, {
		repositoryIntegrationId: run.context.repositoryIntegrationId,
		projectId: run.projectId,
	});
	await recordContextSyncCompletedAudit(tx, {
		projectId: run.projectId,
		organizationId: run.organizationId,
		syncId: run.syncId,
		runKey: run.id,
		actingUserId: run.userId,
		trigger,
		repository: integration
			? `${integration.repositoryOwner}/${integration.repositoryName}`
			: null,
		status: verdict.status,
		error: verdict.error,
		commitSha,
		counts,
	});
	return {
		recorded: completed.completed,
		status: verdict.status,
		error: verdict.error,
	};
}
