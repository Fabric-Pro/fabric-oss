/**
 * Living Memory repository sync (design 2026-09-23 §4, §5, Fizzy #2657): the
 * configuration row, the run receipts and their ledger, the fence every run
 * mutation goes through, and the sync's writer — the only code that writes a
 * `ProjectContext` row with `repositorySyncId` set.
 *
 * # Identity and fences (§4.5)
 *
 * Configuration identity is `(syncId, generation)`; run identity is the run
 * key `<syncId>:<workflow run id>`. Lock order EVERYWHERE is:
 *
 *   1. the configuration row (`project_context_repository_sync`, FOR UPDATE);
 *   2. then the run row (`project_context_repository_sync_run`, FOR UPDATE).
 *
 * `withContextRepositorySyncRunFence` takes both in that order and checks the
 * pair and the key before it runs its callback. Every helper below that takes
 * a transaction client and writes a run's ledger or its rows ASSUMES its
 * caller holds both locks, in that order — in practice, that it is called
 * inside the fence's callback. None of them takes a lock itself, and none of
 * them may be called with a lock order the other way round: a configure or
 * disable that locks the configuration row and then touches run rows would
 * deadlock against it.
 *
 * No transaction here calls Temporal or any network (§4.5).
 */

import { db, type Prisma } from "../../client";
import type {
	ProjectContextSyncPause,
	ProjectContextSyncTrigger,
} from "../../generated/client";
import { createPendingVectorCleanup } from "./pending-vector-cleanup";
import {
	buildSyncedContextCreateData,
	buildSyncedContextReplaceData,
	storedSyncedContextTitle,
	syncedContextTitle,
} from "./synced-context-write";

// =============================================================================
// Vocabulary
// =============================================================================

/**
 * What started a run: the run row's `trigger` enum
 * (`ProjectContextSyncTrigger` in schema.prisma), derived rather than
 * restated, as `InstructionSyncTrigger` is. MANUAL is "Sync now"; POLL and
 * WEBHOOK are the automatic triggers (design §11.1, Fizzy #2673).
 */
export type ContextSyncTrigger = ProjectContextSyncTrigger;
/** Why automatic sync stopped until a re-configure (design §11.1). */
export type ContextSyncPause = ProjectContextSyncPause;
export type ContextSyncRunStatus =
	| "SUCCEEDED"
	| "PARTIAL"
	| "UNCHANGED"
	| "FAILED";
/** The closed failure vocabulary (§5.5). */
export type ContextSyncError =
	| "NOT_CONFIGURED"
	| "INTEGRATION_UNAVAILABLE"
	| "PERMISSION_DENIED"
	| "RUN_IN_PROGRESS"
	| "REF_MISSING"
	| "PATHS_MISSING"
	| "LIMITS_EXCEEDED"
	| "CLONE_FAILED"
	| "STORE_FAILED"
	| "CONFIGURATION_CHANGED"
	| "SUPERSEDED"
	| "INTERRUPTED";

/** What one apply batch decided for one storage key (§4.3, §5.3.1 step 7). */
export type ContextSyncApplyOutcome =
	| "created"
	| "updated"
	| "adopted"
	| "unchanged"
	| "conflict"
	| "path-in-use";

const APPLY_OUTCOMES: ReadonlySet<string> = new Set<ContextSyncApplyOutcome>([
	"created",
	"updated",
	"adopted",
	"unchanged",
	"conflict",
	"path-in-use",
]);

/** The apply ledger: one decision per storage key, at most 5 000 keys. */
export type ContextSyncOutcomes = Record<string, ContextSyncApplyOutcome>;

/** Keys whose managed row a prune could not delete, bounded (§4.3). */
export interface ContextSyncPruneConflicts {
	/** Distinct storage keys, at most `CONTEXT_SYNC_MAX_PRUNE_CONFLICT_KEYS`. */
	keys: string[];
	/**
	 * Conflicts observed once `keys` was full. Not deduplicated (the keys are
	 * not stored), so a retry that re-observes one counts it again.
	 */
	overflow: number;
}

/** The context `begin` freezes on the run row (§4.2). */
export interface ContextSyncRunContext {
	ref: string;
	paths: string[];
	repositoryIntegrationId: string;
	actingUserId: string;
}

/** Why a key needs a member's attention (§7.3). */
export type ContextSyncAttentionReason =
	| "path-in-use"
	| "too-large"
	| "binary"
	| "empty"
	| "invalid-path"
	| "conflict"
	| "prune-conflict"
	| "path-missing"
	| "ignore-policy-unreadable";

/**
 * The plan receipt (§4.3), written once before a run's first mutation. The
 * sync's activity (T3) owns its contents; this layer stores it once and
 * hands the stored one back. `keptKeys` is the frozen apply membership a
 * retry applies instead of re-planning; `protectedKeys` and
 * `protectedPrefixes` are what the prune must not touch.
 */
export interface ContextSyncPlan {
	keptCount: number;
	excludedCount: number;
	attentionCount: number;
	/** At most 100 entries, keys at most 200 characters. */
	attention: Array<{ key: string; reason: ContextSyncAttentionReason }>;
	protectedPrefixes: string[];
	missingPaths: string[];
	keptKeys: string[];
	protectedKeys: string[];
}

/** Every transaction a run or a configuration change opens (§5.3.1, §8). */
export const CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS = 30_000;
/** The apply ledger's bound, equal to the kept-files bound (§8). */
export const CONTEXT_SYNC_MAX_OUTCOMES = 5_000;
/** `pruneConflicts.keys` bound (§4.3). */
export const CONTEXT_SYNC_MAX_PRUNE_CONFLICT_KEYS = 100;
/** How many unfinished predecessors `begin` and reconciliation read (§5.3.0). */
export const CONTEXT_SYNC_UNFINISHED_RUNS_LIMIT = 20;

function isUniqueViolation(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "P2002";
}

// =============================================================================
// Configuration
// =============================================================================

const syncViewSelect = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	repositoryIntegrationId: true,
	ref: true,
	paths: true,
	generation: true,
	activeRunKey: true,
	lastAppliedCommitSha: true,
	lastAppliedRunId: true,
	automatic: true,
	automaticPausedReason: true,
	automaticPausedAt: true,
	nextCheckAt: true,
	failureCount: true,
	createdAt: true,
	updatedAt: true,
	user: { select: { id: true, name: true } },
	repositoryIntegration: {
		select: {
			id: true,
			provider: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
			status: true,
		},
	},
} satisfies Prisma.ProjectContextRepositorySyncSelect;

export type ContextRepositorySyncView =
	Prisma.ProjectContextRepositorySyncGetPayload<{
		select: typeof syncViewSelect;
	}>;

/**
 * A project's sync configuration with its integration summary, or `null`.
 * Tenant-scoped: the organization is the caller's resolved one, never a
 * value the request supplied. No lock.
 */
export function getContextRepositorySync(
	projectId: string,
	organizationId: string,
): Promise<ContextRepositorySyncView | null> {
	return db.projectContextRepositorySync.findFirst({
		where: { projectId, organizationId },
		select: syncViewSelect,
	});
}

/** The configuration row as lock 1 reads it. */
export interface LockedContextRepositorySync {
	id: string;
	projectId: string;
	organizationId: string;
	userId: string;
	repositoryIntegrationId: string;
	ref: string;
	paths: string[];
	generation: number;
	activeRunKey: string | null;
	/** `begin` refuses an automatic run while this is off (design §11.1). */
	automatic: boolean;
	/** `begin` refuses an automatic run while this is set. */
	automaticPausedReason: ContextSyncPause | null;
	/** Backoff counts from this, read under the same lock as the write. */
	failureCount: number;
	/**
	 * The re-check request a push or a poll left while a run was open
	 * (`recordPendingContextSyncHead`), which the run's scheduling write
	 * folds in under this lock.
	 */
	pendingCommitSha: string | null;
	/**
	 * The database's clock, read by the lock statement (Fizzy #2683): a
	 * completion or a refusal dates its receipt and next check from it.
	 */
	now: Date;
}

/**
 * Lock 1 (§4.5): the configuration row by id, `FOR UPDATE`, bound to the
 * project and organization the caller resolved so a stray `syncId` never
 * locks — or reads — another tenant's configuration. `null` when absent,
 * which a run reads as `CONFIGURATION_CHANGED`.
 */
export async function getContextRepositorySyncForUpdate(
	tx: Prisma.TransactionClient,
	syncId: string,
	scope: { projectId: string; organizationId: string },
): Promise<LockedContextRepositorySync | null> {
	const rows = await tx.$queryRaw<LockedContextRepositorySync[]>`
		SELECT "id", "projectId", "organizationId", "userId",
			"repositoryIntegrationId", "ref", "paths", "generation", "activeRunKey",
			"automatic", "automaticPausedReason", "failureCount", "pendingCommitSha",
			(clock_timestamp() AT TIME ZONE 'UTC') AS "now"
		FROM "project_context_repository_sync"
		WHERE "id" = ${syncId}
			AND "projectId" = ${scope.projectId}
			AND "organizationId" = ${scope.organizationId}
		FOR UPDATE
	`;
	return rows[0] ?? null;
}

/** Lock 1 by project, for the configuration changes that start from it. */
async function lockContextRepositorySyncByProject(
	tx: Prisma.TransactionClient,
	scope: { projectId: string; organizationId: string },
): Promise<LockedContextRepositorySync | null> {
	const rows = await tx.$queryRaw<LockedContextRepositorySync[]>`
		SELECT "id", "projectId", "organizationId", "userId",
			"repositoryIntegrationId", "ref", "paths", "generation", "activeRunKey",
			"automatic", "automaticPausedReason", "failureCount", "pendingCommitSha",
			(clock_timestamp() AT TIME ZONE 'UTC') AS "now"
		FROM "project_context_repository_sync"
		WHERE "projectId" = ${scope.projectId}
			AND "organizationId" = ${scope.organizationId}
		FOR UPDATE
	`;
	return rows[0] ?? null;
}

/** The tenant every read of a sync's managed rows is scoped to. */
type ManagedContextScope = { projectId: string; organizationId: string };

/**
 * How many rows a sync manages, in the tenant. Pass the transaction client
 * of a caller that holds lock 1 when the count decides a write (configure,
 * disable): the sync's writer holds the same lock, so no managed row can
 * appear between the count and the write.
 */
export function countManagedContexts(
	client: Prisma.TransactionClient,
	scope: ManagedContextScope,
	syncId: string,
): Promise<number> {
	return client.projectContext.count({
		where: {
			projectId: scope.projectId,
			organizationId: scope.organizationId,
			repositorySyncId: syncId,
		},
	});
}

/**
 * Managed rows not yet indexed (`embeddedAt IS NULL`), in the tenant, for
 * the tab (§5.1).
 */
export function countAwaitingIndexContexts(
	scope: ManagedContextScope,
	syncId: string,
): Promise<number> {
	return db.projectContext.count({
		where: {
			projectId: scope.projectId,
			organizationId: scope.organizationId,
			repositorySyncId: syncId,
			embeddedAt: null,
		},
	});
}

/**
 * One page of a sync's managed rows not yet indexed (`embeddedAt IS NULL`),
 * by storage key (§5.3.1 step 9): rows whose `sourcePath` sorts after
 * `afterKey`, so the next page starts from the last key returned. Each comes
 * with the title its embedding is started under (`metadata.title`, else the
 * file name). No lock: the index step writes nothing here, it only starts
 * embeddings, and an embedding re-reads its row.
 */
export async function listContextRepositorySyncAwaitingIndex(
	scope: ManagedContextScope,
	syncId: string,
	page: { afterKey?: string | null; limit: number },
): Promise<Array<{ id: string; sourcePath: string; title: string }>> {
	const rows = await db.projectContext.findMany({
		where: {
			projectId: scope.projectId,
			organizationId: scope.organizationId,
			repositorySyncId: syncId,
			embeddedAt: null,
			sourcePath:
				page.afterKey === undefined || page.afterKey === null
					? { not: null }
					: { gt: page.afterKey },
		},
		orderBy: { sourcePath: "asc" },
		take: page.limit,
		select: { id: true, sourcePath: true, metadata: true },
	});
	return rows.flatMap((row) =>
		row.sourcePath === null
			? []
			: [
					{
						id: row.id,
						sourcePath: row.sourcePath,
						title: storedSyncedContextTitle(
							row.metadata,
							row.sourcePath,
						),
					},
				],
	);
}

export type UpsertContextRepositorySyncResult =
	| {
			status: "configured";
			sync: {
				id: string;
				generation: number;
				repositoryIntegrationId: string;
				ref: string;
				paths: string[];
				automatic: boolean;
			};
			/** What the configuration said before, or `null` on first configure. */
			previous: {
				repositoryIntegrationId: string;
				ref: string;
				paths: string[];
			} | null;
	  }
	/**
	 * The configuration reads from another integration and still manages
	 * rows. Nothing was written. Changing the repository requires a
	 * disconnect first (§2).
	 */
	| {
			status: "repository-change-requires-disconnect";
			managedCount: number;
			currentRepositoryIntegrationId: string;
	  }
	/**
	 * The integration is not this project's, or is not `ACTIVE`. The
	 * procedure validates both first; this is the same check at the write.
	 */
	| { status: "integration-unavailable" };

/**
 * `configure` (§5.1): one transaction under lock 1. Re-reads the stored
 * integration and the managed-row count INSIDE the lock, refuses a
 * repository change while managed rows exist (a typed result, not a throw),
 * then creates or updates the configuration. The caller always becomes its
 * `userId`, and `activeRunKey` is always left alone. Paths are stored as
 * given; the procedure canonicalizes them.
 *
 * What the update does depends on whether it changes what is synced, which
 * is decided under the lock against the stored row (Fizzy #2713):
 *
 *  - The repository integration, the branch or the paths change: the
 *    configuration is re-pointed. `generation` is bumped, so an in-flight
 *    run is fenced (`CONFIGURATION_CHANGED`) rather than released;
 *    `lastApplied*` is cleared, since that run applied another selection;
 *    and the whole automatic schedule is reset as
 *    `upsertInstructionRepositorySync` resets it — pause, suppression, poll
 *    cursor, re-check request and failure count cleared, due now — so the
 *    next poll tick evaluates the new configuration.
 *  - None of them changes (the "Automatic sync" toggle, "Re-enable" after a
 *    pause, a re-save of the same settings): only `automatic` (kept when
 *    omitted), the pause and the failure count are written, and the sync is
 *    made due now. `generation`, `lastApplied*`, the generation-bound
 *    cursors (`lastEvaluated*`, `suppressed*`) and the re-check request are
 *    kept: the managed files the last run applied are still the ones the
 *    configuration selects, an open run's plan is unaffected and it
 *    finishes normally (its completion consumes the re-check request), and
 *    a head this configuration already evaluated or suppressed is not
 *    re-run. The due time is the database's clock the lock read, which no
 *    lease a poll check holds can equal: without a generation bump, moving
 *    `nextCheckAt` is what ends such a lease, as the lease fence's writer
 *    contract requires (`repositorySyncLeaseFenceSql`, Fizzy #2689).
 *
 * `automatic` is `false` on insert when omitted.
 *
 * Two first configures of one project race on the `projectId` unique index;
 * the loser re-runs once and updates the winner's row.
 */
export async function upsertContextRepositorySync(input: {
	projectId: string;
	organizationId: string;
	userId: string;
	repositoryIntegrationId: string;
	ref: string;
	paths: string[];
	automatic?: boolean;
}): Promise<UpsertContextRepositorySyncResult> {
	try {
		return await runUpsertContextRepositorySync(input);
	} catch (error) {
		if (!isUniqueViolation(error)) {
			throw error;
		}
		return await runUpsertContextRepositorySync(input);
	}
}

function runUpsertContextRepositorySync(input: {
	projectId: string;
	organizationId: string;
	userId: string;
	repositoryIntegrationId: string;
	ref: string;
	paths: string[];
	automatic?: boolean;
}): Promise<UpsertContextRepositorySyncResult> {
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	return db.$transaction(
		async (tx): Promise<UpsertContextRepositorySyncResult> => {
			const existing = await lockContextRepositorySyncByProject(
				tx,
				scope,
			);

			const integration = await tx.projectRepositoryIntegration.findFirst(
				{
					where: {
						id: input.repositoryIntegrationId,
						projectId: input.projectId,
					},
					select: { status: true },
				},
			);
			if (!integration || integration.status !== "ACTIVE") {
				return { status: "integration-unavailable" };
			}

			if (
				existing &&
				existing.repositoryIntegrationId !==
					input.repositoryIntegrationId
			) {
				const managedCount = await countManagedContexts(
					tx,
					scope,
					existing.id,
				);
				if (managedCount > 0) {
					return {
						status: "repository-change-requires-disconnect",
						managedCount,
						currentRepositoryIntegrationId:
							existing.repositoryIntegrationId,
					};
				}
			}

			const select = {
				id: true,
				generation: true,
				repositoryIntegrationId: true,
				ref: true,
				paths: true,
				automatic: true,
			} as const;
			const previous = existing
				? {
						repositoryIntegrationId:
							existing.repositoryIntegrationId,
						ref: existing.ref,
						paths: existing.paths,
					}
				: null;

			if (existing && !changesWhatIsSynced(existing, input)) {
				const sync = await tx.projectContextRepositorySync.update({
					where: { id: existing.id },
					data: {
						userId: input.userId,
						automatic: input.automatic ?? existing.automatic,
						automaticPausedReason: null,
						automaticPausedAt: null,
						failureCount: 0,
						nextCheckAt: existing.now ?? new Date(),
					},
					select,
				});
				return { status: "configured", sync, previous };
			}

			// The scheduling reset `upsertInstructionRepositorySync` applies:
			// a new configuration is evaluated afresh, now.
			const reset = {
				automaticPausedReason: null,
				automaticPausedAt: null,
				suppressedCommitSha: null,
				suppressedGeneration: null,
				lastEvaluatedCommitSha: null,
				lastEvaluatedGeneration: null,
				pendingCommitSha: null,
				failureCount: 0,
				nextCheckAt: new Date(),
			};
			const sync = existing
				? await tx.projectContextRepositorySync.update({
						where: { id: existing.id },
						data: {
							userId: input.userId,
							repositoryIntegrationId:
								input.repositoryIntegrationId,
							ref: input.ref,
							paths: input.paths,
							automatic: input.automatic ?? existing.automatic,
							generation: { increment: 1 },
							lastAppliedCommitSha: null,
							lastAppliedRunId: null,
							...reset,
						},
						select,
					})
				: await tx.projectContextRepositorySync.create({
						data: {
							projectId: input.projectId,
							organizationId: input.organizationId,
							userId: input.userId,
							repositoryIntegrationId:
								input.repositoryIntegrationId,
							ref: input.ref,
							paths: input.paths,
							automatic: input.automatic ?? false,
							...reset,
						},
						select,
					});
			return { status: "configured", sync, previous };
		},
		{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
	);
}

/**
 * Whether a configure changes what the sync reads (Fizzy #2713): the
 * repository integration, the branch or the paths. Both path lists are
 * canonical (sorted, deduplicated) when the procedure wrote them, so they are
 * compared in order; a list that differs only in order counts as a change,
 * which fences more than it must but never less.
 */
function changesWhatIsSynced(
	stored: { repositoryIntegrationId: string; ref: string; paths: string[] },
	next: { repositoryIntegrationId: string; ref: string; paths: string[] },
): boolean {
	return (
		stored.repositoryIntegrationId !== next.repositoryIntegrationId ||
		stored.ref !== next.ref ||
		stored.paths.length !== next.paths.length ||
		stored.paths.some((path, i) => path !== next.paths[i])
	);
}

export interface DeleteContextRepositorySyncResult {
	deleted: boolean;
	syncId: string | null;
	/** Rows the configuration managed, released (not deleted) by the delete. */
	managedCount: number;
	repositoryIntegrationId: string | null;
	/** The run that held the configuration, if any; it is fenced from now on. */
	activeRunKey: string | null;
}

/**
 * `disable` (§5.1): under lock 1, count the managed rows and delete the
 * configuration. The foreign key's `ON DELETE SET NULL` releases every
 * managed row as an ordinary synced file in the same transaction; run
 * receipts carry no foreign key and survive. Allowed during a run: the run's
 * next fenced transaction finds no configuration (`CONFIGURATION_CHANGED`).
 */
export function deleteContextRepositorySync(input: {
	projectId: string;
	organizationId: string;
}): Promise<DeleteContextRepositorySyncResult> {
	return db.$transaction(
		async (tx): Promise<DeleteContextRepositorySyncResult> => {
			const existing = await lockContextRepositorySyncByProject(
				tx,
				input,
			);
			if (!existing) {
				return {
					deleted: false,
					syncId: null,
					managedCount: 0,
					repositoryIntegrationId: null,
					activeRunKey: null,
				};
			}
			const managedCount = await countManagedContexts(
				tx,
				{
					projectId: input.projectId,
					organizationId: input.organizationId,
				},
				existing.id,
			);
			await tx.projectContextRepositorySync.delete({
				where: { id: existing.id },
			});
			return {
				deleted: true,
				syncId: existing.id,
				managedCount,
				repositoryIntegrationId: existing.repositoryIntegrationId,
				activeRunKey: existing.activeRunKey,
			};
		},
		{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
	);
}

// =============================================================================
// Run receipts and the ledger
// =============================================================================

/**
 * Insert a run's receipt (§5.3.0 step 3), with ON CONFLICT DO NOTHING
 * semantics: `inserted` is false when a row with this run key exists. A
 * refusal's receipt is inserted already finished (`finished`), so history
 * shows it. Called by `begin` inside its lock-1 transaction.
 */
export async function insertContextRepositorySyncRun(
	client: Prisma.TransactionClient,
	input: {
		id: string;
		syncId: string;
		projectId: string;
		organizationId: string;
		userId: string;
		generation: number;
		context: ContextSyncRunContext;
		trigger: ContextSyncTrigger;
		startedAt: Date;
		finished?: { at: Date; status: "FAILED"; error: ContextSyncError };
	},
): Promise<{ inserted: boolean }> {
	const { finished, context, ...columns } = input;
	const { count } = await client.projectContextRepositorySyncRun.createMany({
		data: [
			{
				...columns,
				context: { ...context },
				...(finished
					? {
							finishedAt: finished.at,
							status: finished.status,
							error: finished.error,
						}
					: {}),
			},
		],
		skipDuplicates: true,
	});
	return { inserted: count === 1 };
}

/** The run row as lock 3 reads it. */
export interface LockedContextRepositorySyncRun {
	id: string;
	syncId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	generation: number;
	finishedAt: Date | null;
}

/** An unfinished run's ledger, read under lock 3. */
export interface ContextRepositorySyncRunLedger {
	id: string;
	syncId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	generation: number;
	context: ContextSyncRunContext;
	trigger: ContextSyncTrigger;
	startedAt: Date;
	commitSha: string | null;
	plan: ContextSyncPlan | null;
	outcomes: ContextSyncOutcomes;
	removedCount: number;
	pruneConflicts: ContextSyncPruneConflicts;
}

export type ContextRepositorySyncRunLock =
	| { status: "ok"; run: ContextRepositorySyncRunLedger }
	/** No such run, or it is finished: nothing may be written for it. */
	| { status: "superseded"; run: LockedContextRepositorySyncRun | null };

const ledgerSelect = {
	id: true,
	syncId: true,
	projectId: true,
	organizationId: true,
	userId: true,
	generation: true,
	context: true,
	trigger: true,
	startedAt: true,
	commitSha: true,
	plan: true,
	outcomes: true,
	removedCount: true,
	pruneConflicts: true,
} satisfies Prisma.ProjectContextRepositorySyncRunSelect;

/**
 * Lock 3 (§4.5): the run row by key, `FOR UPDATE`, requiring
 * `finishedAt IS NULL` — a finished receipt, or none, is `superseded`, never
 * a throw. Returns the ledger read after the lock, so a batch's "which keys
 * are decided" is read under the same lock as its write. The caller must
 * already hold lock 1.
 */
export async function getContextRepositorySyncRunForUpdate(
	tx: Prisma.TransactionClient,
	runKey: string,
): Promise<ContextRepositorySyncRunLock> {
	const rows = await tx.$queryRaw<LockedContextRepositorySyncRun[]>`
		SELECT "id", "syncId", "projectId", "organizationId", "userId",
			"generation", "finishedAt"
		FROM "project_context_repository_sync_run"
		WHERE "id" = ${runKey}
		FOR UPDATE
	`;
	const locked = rows[0];
	if (!locked || locked.finishedAt !== null) {
		return { status: "superseded", run: locked ?? null };
	}
	const row = await tx.projectContextRepositorySyncRun.findUniqueOrThrow({
		where: { id: runKey },
		select: ledgerSelect,
	});
	return {
		status: "ok",
		run: {
			...row,
			context: row.context as unknown as ContextSyncRunContext,
			trigger: row.trigger as ContextSyncTrigger,
			plan: (row.plan as unknown as ContextSyncPlan | null) ?? null,
			outcomes: parseOutcomes(row.outcomes),
			pruneConflicts: parsePruneConflicts(row.pruneConflicts),
		},
	};
}

/**
 * A sync's unfinished receipts, oldest first (§5.3.0 step 1, §5.6): what
 * `begin` and reconciliation describe before they lock. No lock of its own;
 * pass the transaction client of a caller holding lock 1 to re-read the same
 * set under the lock (the revalidation step).
 */
export function listUnfinishedContextRepositorySyncRuns(
	syncId: string,
	limit: number = CONTEXT_SYNC_UNFINISHED_RUNS_LIMIT,
	client: Prisma.TransactionClient = db,
) {
	return client.projectContextRepositorySyncRun.findMany({
		where: { syncId, finishedAt: null },
		orderBy: [{ startedAt: "asc" }, { id: "asc" }],
		take: limit,
		select: {
			id: true,
			syncId: true,
			projectId: true,
			organizationId: true,
			userId: true,
			generation: true,
			startedAt: true,
			removedCount: true,
			outcomes: true,
			pruneConflicts: true,
		},
	});
}

const receiptSelect = {
	id: true,
	syncId: true,
	projectId: true,
	organizationId: true,
	userId: true,
	generation: true,
	trigger: true,
	startedAt: true,
	finishedAt: true,
	status: true,
	error: true,
	commitSha: true,
	plan: true,
	outcomes: true,
	removedCount: true,
	pruneConflicts: true,
} satisfies Prisma.ProjectContextRepositorySyncRunSelect;

/**
 * Complete a receipt once (`WHERE finishedAt IS NULL`) and read it back.
 * Idempotent: a second call completes nothing (`completed: false`) and
 * returns the receipt as the first call left it. The caller holds locks 1
 * (when the configuration still exists) and 3; clearing `activeRunKey` and
 * `lastApplied*` is the caller's, under lock 1 (§5.4).
 */
export async function completeContextRepositorySyncRun(
	tx: Prisma.TransactionClient,
	runKey: string,
	result: {
		status: ContextSyncRunStatus;
		error: ContextSyncError | null;
		now?: Date;
	},
) {
	const { count } = await tx.projectContextRepositorySyncRun.updateMany({
		where: { id: runKey, finishedAt: null },
		data: {
			finishedAt: result.now ?? new Date(),
			status: result.status,
			error: result.error,
		},
	});
	const run = await tx.projectContextRepositorySyncRun.findUnique({
		where: { id: runKey },
		select: receiptSelect,
	});
	return { completed: count === 1, run };
}

/**
 * Pin the run's commit once (§5.3.1 step 3): write `commitSha` only while it
 * is NULL, then read the stored one — the winner's, when an earlier attempt
 * pinned another head — with the stored plan. Caller holds locks 1 and 3.
 */
export async function pinContextRepositorySyncRunCommit(
	tx: Prisma.TransactionClient,
	runKey: string,
	commitSha: string,
): Promise<{
	commitSha: string;
	pinnedByThisCall: boolean;
	plan: ContextSyncPlan | null;
}> {
	const { count } = await tx.projectContextRepositorySyncRun.updateMany({
		where: { id: runKey, commitSha: null, finishedAt: null },
		data: { commitSha },
	});
	const run = await tx.projectContextRepositorySyncRun.findUniqueOrThrow({
		where: { id: runKey },
		select: { commitSha: true, plan: true },
	});
	if (run.commitSha === null) {
		throw new Error(
			`context sync run ${runKey} could not be pinned: it is finished`,
		);
	}
	return {
		commitSha: run.commitSha,
		pinnedByThisCall: count === 1,
		plan: (run.plan as unknown as ContextSyncPlan | null) ?? null,
	};
}

/**
 * Write the plan receipt once (§4.3): `WHERE plan IS NULL`, then read the
 * stored one. When an earlier attempt wrote a plan, that one is returned and
 * is the run's membership. Caller holds locks 1 and 3.
 */
export async function writeContextRepositorySyncRunPlan(
	tx: Prisma.TransactionClient,
	runKey: string,
	plan: ContextSyncPlan,
): Promise<{ plan: ContextSyncPlan; writtenByThisCall: boolean }> {
	const written = await tx.$executeRaw`
		UPDATE "project_context_repository_sync_run"
		SET "plan" = ${JSON.stringify(plan)}::jsonb
		WHERE "id" = ${runKey}
			AND "plan" IS NULL
			AND "finishedAt" IS NULL
	`;
	const run = await tx.projectContextRepositorySyncRun.findUniqueOrThrow({
		where: { id: runKey },
		select: { plan: true },
	});
	if (run.plan === null) {
		throw new Error(
			`context sync run ${runKey} has no plan and cannot take one: it is finished`,
		);
	}
	return {
		plan: run.plan as unknown as ContextSyncPlan,
		writtenByThisCall: written === 1,
	};
}

function parseOutcomes(value: Prisma.JsonValue): ContextSyncOutcomes {
	const entries: Array<[string, ContextSyncApplyOutcome]> = [];
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, outcome] of Object.entries(value)) {
			if (typeof outcome === "string" && APPLY_OUTCOMES.has(outcome)) {
				entries.push([key, outcome as ContextSyncApplyOutcome]);
			}
		}
	}
	// `fromEntries` defines own properties, so a key such as `__proto__`
	// stays a key rather than reaching the prototype.
	return Object.fromEntries(entries);
}

function parsePruneConflicts(
	value: Prisma.JsonValue,
): ContextSyncPruneConflicts {
	const record =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as { keys?: unknown; overflow?: unknown })
			: {};
	const keys = Array.isArray(record.keys)
		? record.keys.filter((key): key is string => typeof key === "string")
		: [];
	const overflow =
		typeof record.overflow === "number" && record.overflow > 0
			? Math.floor(record.overflow)
			: 0;
	return { keys, overflow };
}

/**
 * Merge an apply batch's outcomes into the ledger (§4.3) and return the
 * merged ledger. A key already present keeps its first decision: a key is
 * decided once per run, and a recorded `conflict` or `path-in-use` is final
 * for it. Caller holds locks 1 and 3 and passed the keys the ledger held
 * under those locks as the batch's `decided` set.
 */
export async function mergeContextRepositorySyncRunOutcomes(
	tx: Prisma.TransactionClient,
	runKey: string,
	outcomes: ContextSyncOutcomes,
): Promise<ContextSyncOutcomes> {
	const run = await tx.projectContextRepositorySyncRun.findUniqueOrThrow({
		where: { id: runKey },
		select: { outcomes: true },
	});
	const merged = new Map(Object.entries(parseOutcomes(run.outcomes)));
	let added = 0;
	for (const [key, outcome] of Object.entries(outcomes)) {
		if (!merged.has(key) && APPLY_OUTCOMES.has(outcome)) {
			merged.set(key, outcome);
			added++;
		}
	}
	if (merged.size > CONTEXT_SYNC_MAX_OUTCOMES) {
		throw new Error(
			`context sync run ${runKey} would decide ${merged.size} keys; the ledger holds at most ${CONTEXT_SYNC_MAX_OUTCOMES}`,
		);
	}
	const result: ContextSyncOutcomes = Object.fromEntries(merged);
	if (added > 0) {
		await tx.projectContextRepositorySyncRun.update({
			where: { id: runKey },
			data: { outcomes: result },
		});
	}
	return result;
}

/**
 * Record a committed prune batch (§4.3, §5.3.1 step 8), in the batch's own
 * transaction: `removedCount += removed`, and each conflicting key into
 * `pruneConflicts` once (at most 100 keys, then `overflow`). The batch's
 * vector cleanup record carries the run key itself
 * (`pruneRepositoryContextBatch`), so nothing here counts it. Caller holds
 * locks 1 and 3.
 */
export async function recordContextRepositorySyncPrune(
	tx: Prisma.TransactionClient,
	runKey: string,
	batch: { removed: number; conflicts: string[] },
): Promise<{
	removedCount: number;
	pruneConflicts: ContextSyncPruneConflicts;
}> {
	const run = await tx.projectContextRepositorySyncRun.findUniqueOrThrow({
		where: { id: runKey },
		select: { pruneConflicts: true },
	});
	const current = parsePruneConflicts(run.pruneConflicts);
	const keys = new Set(current.keys);
	let overflow = current.overflow;
	for (const key of batch.conflicts) {
		if (keys.has(key)) {
			continue;
		}
		if (keys.size < CONTEXT_SYNC_MAX_PRUNE_CONFLICT_KEYS) {
			keys.add(key);
		} else {
			overflow++;
		}
	}
	const pruneConflicts = { keys: [...keys], overflow };
	const updated = await tx.projectContextRepositorySyncRun.update({
		where: { id: runKey },
		data: {
			removedCount: { increment: batch.removed },
			pruneConflicts,
		},
		select: { removedCount: true },
	});
	return { ...updated, pruneConflicts };
}

// =============================================================================
// The fence
// =============================================================================

/** What a run captured at `begin`, and every fenced transaction re-checks. */
export interface ContextSyncRunFence {
	syncId: string;
	generation: number;
	runKey: string;
	projectId: string;
	organizationId: string;
}

export type ContextSyncFenceResult<T> =
	| { status: "ok"; value: T }
	/**
	 * The configuration is gone, or `generation` moved (re-configured or
	 * disconnected). Nothing was written. The run maps it to
	 * `CONFIGURATION_CHANGED`.
	 */
	| { status: "configuration-changed" }
	/**
	 * The configuration no longer names this run as its active one, or the
	 * run's receipt is finished (reconciliation completed it) or missing.
	 * Nothing was written. The run maps it to `SUPERSEDED`.
	 */
	| { status: "superseded" };

/**
 * The fence every mutation of a run goes through (§4.5). Opens ONE
 * transaction with a 30-second timeout and, in this order:
 *
 *  1. locks the configuration row (lock 1); absent, or a `generation` other
 *     than the run's → `configuration-changed`;
 *  2. requires `activeRunKey = runKey`, else → `superseded`;
 *  3. locks the run row (lock 3); finished or missing, or captured under
 *     another configuration → `superseded`;
 *  4. runs `fn` with the transaction client and the locked state, and
 *     commits what it wrote.
 *
 * Typed results, never throws, for 1–3. An error `fn` throws rolls back
 * everything it wrote and propagates. `fn` must not call Temporal or any
 * network: both locks are held while it runs.
 */
export async function withContextRepositorySyncRunFence<T>(
	fence: ContextSyncRunFence,
	fn: (
		tx: Prisma.TransactionClient,
		locked: {
			sync: LockedContextRepositorySync;
			run: ContextRepositorySyncRunLedger;
		},
	) => Promise<T>,
): Promise<ContextSyncFenceResult<T>> {
	return await db.$transaction(
		async (tx): Promise<ContextSyncFenceResult<T>> => {
			const sync = await getContextRepositorySyncForUpdate(
				tx,
				fence.syncId,
				{
					projectId: fence.projectId,
					organizationId: fence.organizationId,
				},
			);
			if (!sync || sync.generation !== fence.generation) {
				return { status: "configuration-changed" };
			}
			if (sync.activeRunKey !== fence.runKey) {
				return { status: "superseded" };
			}
			const lock = await getContextRepositorySyncRunForUpdate(
				tx,
				fence.runKey,
			);
			if (
				lock.status !== "ok" ||
				lock.run.syncId !== fence.syncId ||
				lock.run.projectId !== fence.projectId ||
				lock.run.organizationId !== fence.organizationId ||
				lock.run.generation !== fence.generation
			) {
				return { status: "superseded" };
			}
			return {
				status: "ok",
				value: await fn(tx, { sync, run: lock.run }),
			};
		},
		{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
	);
}

// =============================================================================
// The writer: apply and prune
// =============================================================================

/** One planned file, with the content the pinned commit holds for it. */
export interface RepositoryContextFile {
	/** `normalizeContextSourcePath` of the repository path. */
	storageKey: string;
	content: string;
	/** sha256 hex of `content`, as `hashContextContent` computes it. */
	contentHash: string;
	/** Defaults to the file name. */
	title?: string | null;
}

const APPLY_ROW_SELECT = {
	id: true,
	organizationId: true,
	contentHash: true,
	repositorySyncId: true,
	metadata: true,
} satisfies Prisma.ProjectContextSelect;

/**
 * Apply one batch of planned files (§5.3.1 step 7). Caller holds locks 1 and
 * 3 (it runs inside the fence) and passes the ledger's decided keys, read
 * under those locks, as `decided`: those keys, and a key repeated in
 * `files`, are skipped and absent from the answer. Per key:
 *
 *  - no row at the path → insert with `repositorySyncId` → `created`. No
 *    project-wide duplicate-by-hash refusal: identical content at two paths
 *    is allowed for repository writes (§2). An insert that loses the path to
 *    a concurrent writer does not abort the batch (ON CONFLICT DO NOTHING);
 *    the key is decided from the row that won;
 *  - managed by this sync, same hash → `unchanged` (nothing written);
 *  - managed by this sync, different hash → UPDATE guarded on the id, the
 *    project, the tenant, the path, the hash read and `repositorySyncId =
 *    syncId` → `updated`, or `conflict` when it matched nothing;
 *  - unowned, same hash → adopt: set `repositorySyncId`, guarded on the id,
 *    the project, the tenant, the path, the hash and `repositorySyncId IS
 *    NULL` → `adopted`, or `conflict` when it matched nothing (the row was
 *    changed, moved, adopted or deleted since the read);
 *  - unowned with different content, another tenant's row, or another
 *    sync's → `path-in-use`, never touched.
 *
 * Content writes use the row shape `upsertContextBySourcePath` uses
 * (`synced-context-write.ts`), stamped with the acting user. No embedding is
 * started here; the run's index step does that once (§5.3.1 step 9).
 */
export async function applyRepositoryContextBatch(
	tx: Prisma.TransactionClient,
	input: {
		projectId: string;
		organizationId: string;
		syncId: string;
		actingUserId: string;
		files: RepositoryContextFile[];
		decided: ReadonlySet<string>;
	},
): Promise<ContextSyncOutcomes> {
	const outcomes = new Map<string, ContextSyncApplyOutcome>();
	for (const file of input.files) {
		if (
			input.decided.has(file.storageKey) ||
			outcomes.has(file.storageKey)
		) {
			continue;
		}
		outcomes.set(file.storageKey, await applyOne(tx, input, file));
	}
	return Object.fromEntries(outcomes);
}

async function applyOne(
	tx: Prisma.TransactionClient,
	input: {
		projectId: string;
		organizationId: string;
		syncId: string;
		actingUserId: string;
	},
	file: RepositoryContextFile,
): Promise<ContextSyncApplyOutcome> {
	const { projectId, organizationId, syncId } = input;
	const sourcePath = file.storageKey;
	const title = syncedContextTitle(file.title, sourcePath);
	const now = new Date();
	// Read by project and path alone — the path's unique key — so a row the
	// tenant filter would hide is still seen as occupying the path.
	const readRow = () =>
		tx.projectContext.findFirst({
			where: { projectId, sourcePath },
			select: APPLY_ROW_SELECT,
		});

	let row = await readRow();
	if (!row) {
		const { count } = await tx.projectContext.createMany({
			data: [
				buildSyncedContextCreateData({
					projectId,
					sourcePath,
					content: file.content,
					contentHash: file.contentHash,
					title,
					userId: input.actingUserId,
					organizationId,
					repositorySyncId: syncId,
					now,
				}),
			],
			skipDuplicates: true,
		});
		if (count === 1) {
			return "created";
		}
		row = await readRow();
		if (!row) {
			// Won by a row that is gone again already; the next run decides.
			return "conflict";
		}
	}

	if (row.organizationId !== organizationId) {
		return "path-in-use";
	}

	if (row.repositorySyncId === syncId) {
		if (row.contentHash === file.contentHash) {
			return "unchanged";
		}
		const { count } = await tx.projectContext.updateMany({
			where: {
				id: row.id,
				projectId,
				organizationId,
				sourcePath,
				contentHash: row.contentHash,
				repositorySyncId: syncId,
			},
			data: buildSyncedContextReplaceData({
				storedMetadata: row.metadata,
				sourcePath,
				content: file.content,
				contentHash: file.contentHash,
				title,
				userId: input.actingUserId,
				now,
			}),
		});
		return count === 1 ? "updated" : "conflict";
	}

	if (row.repositorySyncId !== null || row.contentHash !== file.contentHash) {
		return "path-in-use";
	}

	const { count } = await tx.projectContext.updateMany({
		where: {
			id: row.id,
			projectId,
			organizationId,
			sourcePath,
			contentHash: file.contentHash,
			repositorySyncId: null,
		},
		data: { repositorySyncId: syncId },
	});
	return count === 1 ? "adopted" : "conflict";
}

/**
 * One page of a sync's managed rows, by storage key (§5.3.1 step 8): rows
 * whose `sourcePath` sorts after `afterKey`, in the database's order, so the
 * next page starts from the last key returned. The caller drops planned and
 * protected keys. No lock: every delete re-checks under the fence.
 */
export async function listPruneCandidates(
	scope: ManagedContextScope,
	syncId: string,
	page: { afterKey?: string | null; limit: number },
): Promise<
	Array<{ id: string; sourcePath: string; contentHash: string | null }>
> {
	const rows = await db.projectContext.findMany({
		where: {
			projectId: scope.projectId,
			organizationId: scope.organizationId,
			repositorySyncId: syncId,
			sourcePath:
				page.afterKey === undefined || page.afterKey === null
					? { not: null }
					: { gt: page.afterKey },
		},
		orderBy: { sourcePath: "asc" },
		take: page.limit,
		select: { id: true, sourcePath: true, contentHash: true },
	});
	return rows.flatMap((row) =>
		row.sourcePath === null
			? []
			: [
					{
						id: row.id,
						sourcePath: row.sourcePath,
						contentHash: row.contentHash,
					},
				],
	);
}

/**
 * Prune one batch of managed rows (§5.3.1 step 8). Caller holds locks 1 and
 * 3. Each row is deleted by a DELETE guarded on its id, the project, the
 * tenant, its path, `repositorySyncId = syncId` and the hash the caller read;
 * a row that matched nothing is a conflict (its key is returned). The ids
 * deleted get ONE `createPendingVectorCleanup` record in the same
 * transaction, stamped with the run key, so no row is gone while its points
 * are unrecorded and the run's receipt can count the record until some
 * drain clears it (`countContextRepositorySyncRunCleanupPending`). The
 * caller records the batch with `recordContextRepositorySyncPrune` in the
 * same transaction, and after commit attempts one bounded drain of
 * `cleanupId`.
 */
export async function pruneRepositoryContextBatch(
	tx: Prisma.TransactionClient,
	input: {
		projectId: string;
		organizationId: string;
		syncId: string;
		/** The run pruning: stamped on the batch's cleanup record. */
		runKey: string;
		actingUserId: string;
		rows: Array<{
			id: string;
			sourcePath: string;
			contentHash: string | null;
		}>;
	},
): Promise<{
	deletedIds: string[];
	deletedKeys: string[];
	conflicts: string[];
	cleanupId: string | null;
}> {
	const deletedIds: string[] = [];
	const deletedKeys: string[] = [];
	const conflicts: string[] = [];
	for (const row of input.rows) {
		const { count } = await tx.projectContext.deleteMany({
			where: {
				id: row.id,
				projectId: input.projectId,
				organizationId: input.organizationId,
				sourcePath: row.sourcePath,
				repositorySyncId: input.syncId,
				contentHash: row.contentHash,
			},
		});
		if (count === 1) {
			deletedIds.push(row.id);
			deletedKeys.push(row.sourcePath);
		} else {
			conflicts.push(row.sourcePath);
		}
	}
	const cleanupId =
		deletedIds.length === 0
			? null
			: await createPendingVectorCleanup(tx, {
					projectId: input.projectId,
					contextIds: deletedIds,
					tenant: {
						userId: input.actingUserId,
						organizationId: input.organizationId,
					},
					syncRunKey: input.runKey,
				});
	return { deletedIds, deletedKeys, conflicts, cleanupId };
}

// =============================================================================
// Receipts for the tab (§5.1 `get`)
// =============================================================================

const receiptViewSelect = {
	...receiptSelect,
	user: { select: { name: true } },
} satisfies Prisma.ProjectContextRepositorySyncRunSelect;

type ReceiptViewRow = Prisma.ProjectContextRepositorySyncRunGetPayload<{
	select: typeof receiptViewSelect;
}>;

/** A run receipt as the tab reads it, its JSON columns parsed. */
export interface ContextRepositorySyncRunReceipt {
	id: string;
	syncId: string;
	projectId: string;
	organizationId: string;
	generation: number;
	trigger: ContextSyncTrigger;
	startedAt: Date;
	finishedAt: Date | null;
	status: ContextSyncRunStatus | null;
	error: ContextSyncError | null;
	commitSha: string | null;
	plan: ContextSyncPlan | null;
	outcomes: ContextSyncOutcomes;
	removedCount: number;
	pruneConflicts: ContextSyncPruneConflicts;
	/** The acting member's display name; never their id. */
	userName: string | null;
}

function toReceipt(row: ReceiptViewRow): ContextRepositorySyncRunReceipt {
	return {
		id: row.id,
		syncId: row.syncId,
		projectId: row.projectId,
		organizationId: row.organizationId,
		generation: row.generation,
		trigger: row.trigger as ContextSyncTrigger,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		status: (row.status as ContextSyncRunStatus | null) ?? null,
		error: (row.error as ContextSyncError | null) ?? null,
		commitSha: row.commitSha,
		plan: (row.plan as unknown as ContextSyncPlan | null) ?? null,
		outcomes: parseOutcomes(row.outcomes),
		removedCount: row.removedCount,
		pruneConflicts: parsePruneConflicts(row.pruneConflicts),
		userName: row.user?.name ?? null,
	};
}

/**
 * The newest receipt of a configuration (finished or not), or `null`. Bound
 * to the project and organization the caller resolved as well as the sync
 * id, so a stray id never reads another tenant's history. No lock.
 */
export async function getNewestContextRepositorySyncRun(
	syncId: string,
	scope: { projectId: string; organizationId: string },
): Promise<ContextRepositorySyncRunReceipt | null> {
	const row = await db.projectContextRepositorySyncRun.findFirst({
		where: {
			syncId,
			projectId: scope.projectId,
			organizationId: scope.organizationId,
		},
		orderBy: [{ startedAt: "desc" }, { id: "desc" }],
		select: receiptViewSelect,
	});
	return row ? toReceipt(row) : null;
}

/**
 * One receipt by its run key — the tab reads the one named by
 * `lastAppliedRunId` — bound to the caller's project and organization.
 * No lock.
 */
export async function getContextRepositorySyncRun(
	runKey: string,
	scope: { projectId: string; organizationId: string },
): Promise<ContextRepositorySyncRunReceipt | null> {
	const row = await db.projectContextRepositorySyncRun.findFirst({
		where: {
			id: runKey,
			projectId: scope.projectId,
			organizationId: scope.organizationId,
		},
		select: receiptViewSelect,
	});
	return row ? toReceipt(row) : null;
}

/**
 * The receipt a workflow execution's `begin` inserted, found by that
 * execution's run id alone (§5.4, Fizzy #2672): its key is
 * `<syncId>:<workflowRunId>`, and `record` without a frozen context may no
 * longer have the configuration whose id is the key's first half — a
 * disable or disconnect deleted it, or a re-configure after one replaced it
 * with a row of another id — while the receipt survives either. Bound to the
 * caller's project and organization, and to the exact key shape, so a stray
 * run id never reaches another tenant's receipt or a poll check's
 * `<syncId>:<pollRunId>:<generation>` one. `null` unless exactly one matches.
 * No lock.
 */
export async function findContextRepositorySyncRunReceiptByWorkflowRunId(
	workflowRunId: string,
	scope: { projectId: string; organizationId: string },
): Promise<{ id: string; syncId: string } | null> {
	if (workflowRunId.length === 0) {
		return null;
	}
	const rows = await db.projectContextRepositorySyncRun.findMany({
		where: {
			projectId: scope.projectId,
			organizationId: scope.organizationId,
			id: { endsWith: `:${workflowRunId}` },
		},
		select: { id: true, syncId: true },
	});
	const exact = rows.filter(
		(row) => row.id === `${row.syncId}:${workflowRunId}`,
	);
	return exact.length === 1 && exact[0] ? exact[0] : null;
}

/**
 * How many of a run's queued vector cleanups are still queued, counted LIVE
 * from the queue (§5.3.1 step 8): the records its prune batches stamped with
 * its run key that no drain has cleared yet — the run's own bounded drain, a
 * drain it abandoned that completed later, or the scheduled sweep. Scoped by
 * the run's project and organization as well as the key, so a stray key
 * never counts another tenant's records, and a record another delete queued
 * (no run key, or another run's) is never counted. It reaches 0 once the
 * run's records have drained. One indexed count by `syncRunKey`.
 */
export async function countContextRepositorySyncRunCleanupPending(run: {
	id: string;
	projectId: string;
	organizationId: string;
}): Promise<number> {
	return await db.projectContextPendingVectorCleanup.count({
		where: {
			syncRunKey: run.id,
			projectId: run.projectId,
			organizationId: run.organizationId,
		},
	});
}

// =============================================================================
// Reconciliation (§5.6, the lock half of §5.3.0 steps 3–4)
// =============================================================================

export type CompleteInterruptedContextRepositorySyncRunsResult =
	/** The configuration is gone. Nothing was written. */
	| { status: "not-configured" }
	/**
	 * The unfinished receipts under lock 1 are not the set the caller read
	 * before its describes (one vanished, was completed, or a new one
	 * appeared). Nothing was written; read and describe again.
	 */
	| { status: "changed" }
	| {
			status: "ok";
			/** Run keys completed `FAILED` / `INTERRUPTED` by this call. */
			completed: string[];
			/** `activeRunKey` as this transaction leaves it. */
			activeRunKey: string | null;
	  };

/** Thrown inside the transaction to roll back a pass that found moved state. */
class ReconcileStateChanged extends Error {}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	const set = new Set(a);
	return b.every((id) => set.has(id));
}

/**
 * The lock half of reconciliation (§5.6, §5.3.0 step 3). The caller has read
 * the configuration's unfinished receipts (`observedUnfinished`, via
 * `listUnfinishedContextRepositorySyncRuns`) and described each one's exact
 * execution OUTSIDE any transaction; `closed` are the ones Temporal answered
 * closed or not found. One transaction, lock order §4.5:
 *
 *  1. lock 1 (the configuration row) — absent → `not-configured`;
 *  2. re-read the unfinished receipts under that lock; a set other than
 *     `observedUnfinished` → `changed`, nothing written;
 *  3. for each `closed` key, lock 3 (its run row) and complete it once as
 *     `FAILED` / `INTERRUPTED` (its ledger counts stay as they are), clearing
 *     `activeRunKey` when it names that run;
 *  4. an `activeRunKey` that names no unfinished receipt at all (finished or
 *     missing) is cleared too: nothing else could ever clear it, and a
 *     finished receipt's run is fenced (`superseded`) whatever the key says.
 *
 * Returns the key as it leaves it: non-null means a run still holds the
 * configuration. A receipt described running or unknown is simply not in
 * `closed`, so it is left alone — never a takeover. No Temporal or network
 * call happens under the locks.
 */
export async function completeInterruptedContextRepositorySyncRuns(input: {
	syncId: string;
	projectId: string;
	organizationId: string;
	observedUnfinished: readonly string[];
	closed: readonly string[];
	now?: Date;
}): Promise<CompleteInterruptedContextRepositorySyncRunsResult> {
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	try {
		return await db.$transaction(
			async (
				tx,
			): Promise<CompleteInterruptedContextRepositorySyncRunsResult> => {
				const sync = await getContextRepositorySyncForUpdate(
					tx,
					input.syncId,
					scope,
				);
				if (!sync) {
					return { status: "not-configured" };
				}
				const unfinished = (
					await listUnfinishedContextRepositorySyncRuns(
						input.syncId,
						CONTEXT_SYNC_UNFINISHED_RUNS_LIMIT,
						tx,
					)
				).map((run) => run.id);
				if (!sameIdSet(unfinished, input.observedUnfinished)) {
					return { status: "changed" };
				}

				const unfinishedSet = new Set(unfinished);
				const now = input.now ?? new Date();
				let activeRunKey = sync.activeRunKey;
				const completed: string[] = [];
				for (const runKey of new Set(input.closed)) {
					if (!unfinishedSet.has(runKey)) {
						continue;
					}
					const lock = await getContextRepositorySyncRunForUpdate(
						tx,
						runKey,
					);
					if (lock.status !== "ok") {
						// Cannot happen while lock 1 is held (`record` takes
						// it first); refuse rather than write past a state
						// this pass did not see.
						throw new ReconcileStateChanged();
					}
					await completeContextRepositorySyncRun(tx, runKey, {
						status: "FAILED",
						error: "INTERRUPTED",
						now,
					});
					completed.push(runKey);
					if (activeRunKey === runKey) {
						await releaseContextRepositorySyncRunKey(
							tx,
							input.syncId,
							runKey,
						);
						activeRunKey = null;
					}
				}

				if (activeRunKey !== null && !unfinishedSet.has(activeRunKey)) {
					// Not among the (at most 20) unfinished receipts read:
					// look at its own row before deciding.
					const lock = await getContextRepositorySyncRunForUpdate(
						tx,
						activeRunKey,
					);
					if (lock.status !== "ok") {
						await releaseContextRepositorySyncRunKey(
							tx,
							input.syncId,
							activeRunKey,
						);
						activeRunKey = null;
					}
				}
				return { status: "ok", completed, activeRunKey };
			},
			{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
		);
	} catch (error) {
		if (error instanceof ReconcileStateChanged) {
			return { status: "changed" };
		}
		throw error;
	}
}

// =============================================================================
// Run lifecycle on the configuration row (§5.3.0 `begin`, §5.4 `record`)
// =============================================================================

/**
 * Take the configuration for `runKey` (§5.3.0 step 3): set `activeRunKey`
 * only while no run holds it. `false` when one does. Caller holds lock 1,
 * so the answer cannot go stale before its transaction commits.
 */
export async function acquireContextRepositorySyncRunKey(
	tx: Prisma.TransactionClient,
	syncId: string,
	runKey: string,
): Promise<boolean> {
	const { count } = await tx.projectContextRepositorySync.updateMany({
		where: { id: syncId, activeRunKey: null },
		data: { activeRunKey: runKey },
	});
	return count === 1;
}

/**
 * Clear `activeRunKey` only while it still names `runKey` (§5.4, §5.6): a
 * run never releases a key another run holds. `false` when it named
 * something else, or the configuration is gone. Caller holds lock 1.
 */
export async function releaseContextRepositorySyncRunKey(
	tx: Prisma.TransactionClient,
	syncId: string,
	runKey: string,
): Promise<boolean> {
	const { count } = await tx.projectContextRepositorySync.updateMany({
		where: { id: syncId, activeRunKey: runKey },
		data: { activeRunKey: null },
	});
	return count === 1;
}

/**
 * Name the run the Context tab reports as last applied (§5.4): write
 * `lastAppliedCommitSha` / `lastAppliedRunId` only under the run's fence —
 * the configuration still at the run's `generation` and still held by
 * `runKey` (§4.5) — so a run fenced out by a re-configure or by another run
 * never overwrites what the tab shows. Call it BEFORE releasing the key.
 * `false` when the fence did not hold. Caller holds lock 1.
 */
export async function recordContextRepositorySyncLastApplied(
	tx: Prisma.TransactionClient,
	input: {
		syncId: string;
		generation: number;
		runKey: string;
		commitSha: string;
	},
): Promise<boolean> {
	const { count } = await tx.projectContextRepositorySync.updateMany({
		where: {
			id: input.syncId,
			generation: input.generation,
			activeRunKey: input.runKey,
		},
		data: {
			lastAppliedCommitSha: input.commitSha,
			lastAppliedRunId: input.runKey,
		},
	});
	return count === 1;
}

/**
 * The integration a configuration reads from, scoped to the project: `begin`
 * checks its status under lock 1 (§5.3.0 step 3) and `record` names the
 * repository in its audit row. `null` when it is not this project's.
 */
export function getContextSyncIntegration(
	client: Prisma.TransactionClient,
	input: { repositoryIntegrationId: string; projectId: string },
) {
	return client.projectRepositoryIntegration.findFirst({
		where: {
			id: input.repositoryIntegrationId,
			projectId: input.projectId,
		},
		select: { status: true, repositoryOwner: true, repositoryName: true },
	});
}

// =============================================================================
// Disconnect (§5.1: "repository-integrations/disconnect.ts gains the same delete")
// =============================================================================

export interface ReleasedContextRepositorySync {
	syncId: string;
	organizationId: string;
	/** Rows the configuration managed, released (not deleted) by the delete. */
	managedCount: number;
	activeRunKey: string | null;
}

/**
 * When `integrationId` is the project's Living Memory sync source, delete
 * the configuration under lock 1 and report what it managed; otherwise do
 * nothing. Takes the caller's transaction so the release commits with the
 * integration delete and with the coding-instructions release — one
 * transaction for every sync that reads from the integration
 * (`deleteRepoIntegrationReleasingSyncs` in
 * `./repository-integration-disconnect`). The foreign key's
 * `ON DELETE SET NULL` releases the managed rows as ordinary synced files;
 * receipts survive. Without the explicit release the FK cascade would still
 * remove the configuration, but nothing would count what it managed for the
 * audit row.
 */
export async function releaseContextRepositorySyncForIntegration(
	tx: Prisma.TransactionClient,
	input: { integrationId: string; projectId: string },
): Promise<ReleasedContextRepositorySync | null> {
	const candidate = await tx.projectContextRepositorySync.findFirst({
		where: {
			projectId: input.projectId,
			repositoryIntegrationId: input.integrationId,
		},
		select: { id: true, organizationId: true },
	});
	if (!candidate) {
		return null;
	}
	const locked = await getContextRepositorySyncForUpdate(tx, candidate.id, {
		projectId: input.projectId,
		organizationId: candidate.organizationId,
	});
	// Re-pointed at another integration (possible only with no managed rows)
	// or deleted between the read and the lock: not this integration's.
	if (!locked || locked.repositoryIntegrationId !== input.integrationId) {
		return null;
	}
	const managedCount = await countManagedContexts(
		tx,
		{ projectId: input.projectId, organizationId: locked.organizationId },
		locked.id,
	);
	await tx.projectContextRepositorySync.delete({ where: { id: locked.id } });
	return {
		syncId: locked.id,
		organizationId: locked.organizationId,
		managedCount,
		activeRunKey: locked.activeRunKey,
	};
}
