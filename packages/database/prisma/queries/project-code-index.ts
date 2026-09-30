/**
 * Project Code Index Queries
 *
 * CRUD for the ProjectCodeIndex model — one row per connected repository
 * (keyed by projectId + repositoryIntegrationId + branch), mirroring
 * AtlasAnalysis. `repositoryIntegrationId = null` is a legacy/default-repo row.
 */

import { db } from "../client";
import type { CodeIndexStatus, Prisma } from "../generated/client";

/** Identifies one repo's index row within a project. */
export interface CodeIndexRepoKey {
	projectId: string;
	repositoryIntegrationId: string | null;
	/** Defaults to "main". */
	branch?: string;
}

/**
 * The indexing chain a run-scoped write comes from: the chain's first run id
 * (`workflowInfo().firstExecutionRunId`, the same in every continueAsNew
 * continuation) and the Temporal start time of the run making the write.
 *
 * The indexing workflow id is stable per repo, and a re-index starts with
 * TERMINATE_EXISTING — which does not stop an activity the terminated run
 * already has in flight. That activity can land after the successor has
 * claimed the row. A write carrying an owner therefore lands only when the row
 * is unclaimed, is this chain's own, or was claimed by a run that started no
 * later (see `ownedByWhere` for ties); a write that lands claims the row.
 * Start times all come from the one Temporal server clock, and every run of a
 * chain — continuations included — starts before the TERMINATE_EXISTING
 * successor that replaced it, so any run of the successor is no earlier than
 * any run of the chain it replaced.
 *
 * This fences the index row, which is per branch. The Job Hub row is per repo
 * and carries its own fence (`BackgroundJobKey.runId`).
 */
export interface CodeIndexOwner {
	runId: string;
	startedAt: Date | string;
}

/**
 * What an owned terminal write did: `written` — it landed; `superseded` — the
 * row belongs to a newer chain and was left untouched; `absent` — no row
 * exists for the key. A write without an owner is never `superseded`.
 */
export type CodeIndexWriteOutcome = "written" | "superseded" | "absent";

export interface UpsertCodeIndexInput extends CodeIndexRepoKey {
	userId: string;
	organizationId?: string | null;
	commitSha: string;
	status?: CodeIndexStatus;
	workflowId?: string;
	/** Omitted: the unconditional pre-ownership write (see CodeIndexOwner). */
	owner?: CodeIndexOwner;
}

export interface UpdateCodeIndexStatsInput extends CodeIndexRepoKey {
	filesIndexed: number;
	chunksCreated: number;
	summariesCreated: number;
	indexDurationMs: number;
	fileManifest?: unknown;
	redactionManifest?: unknown;
	/**
	 * Incremental runs only re-embed the changed files, so their per-run chunk /
	 * summary counts are NOT the index totals. When true, the existing totals are
	 * preserved and `lastIncrementalAt` is stamped instead of `lastFullIndexAt`.
	 */
	incremental?: boolean;
	/** Omitted: the unconditional pre-ownership write (see CodeIndexOwner). */
	owner?: CodeIndexOwner;
}

/** Where-clause for one repo's row (Prisma renders a null id as `IS NULL`). */
function repoWhere(key: CodeIndexRepoKey) {
	return {
		projectId: key.projectId,
		repositoryIntegrationId: key.repositoryIntegrationId,
		branch: key.branch ?? "main",
	};
}

/**
 * The rows `owner` may write: unclaimed, claimed by a run that started no
 * later, or its own chain's. Part of the UPDATE's own WHERE, so Postgres
 * re-checks it against the latest committed row version when a concurrent
 * claim holds the row lock.
 *
 * `lte`, not `lt`: the column keeps milliseconds, so a successor that started
 * within the same millisecond as the terminated chain's latest run compares
 * equal. With `lt` every arm would reject the legitimate successor — its init
 * and finalize silently skipped, the row stranded in the old run's state
 * (INDEXING forever). On an exact tie both chains may write instead, which is
 * the last-writer-wins behavior from before ownership existed; the Job Hub row
 * stays protected by its own run-id fence.
 */
function ownedByWhere(owner: CodeIndexOwner) {
	return {
		OR: [
			{ ownerRunStartedAt: null },
			{ ownerRunStartedAt: { lte: new Date(owner.startedAt) } },
			{ ownerRunId: owner.runId },
		],
	};
}

/** The columns a landed owned write sets, claiming the row for its chain. */
function ownerClaim(owner: CodeIndexOwner) {
	return {
		ownerRunId: owner.runId,
		ownerRunStartedAt: new Date(owner.startedAt),
	};
}

/**
 * Classify an owned conditional update that matched no row: the row exists
 * (so a newer chain holds it) or there is no row for the key at all.
 */
async function missOutcome(
	key: CodeIndexRepoKey,
): Promise<"superseded" | "absent"> {
	const row = await db.projectCodeIndex.findFirst({
		where: repoWhere(key),
		select: { id: true },
	});
	return row ? "superseded" : "absent";
}

/**
 * Run one repo-row update, conditional on ownership when `owner` is given.
 * Without an owner this is the unconditional pre-ownership write.
 */
async function writeRepoRow(
	key: CodeIndexRepoKey,
	data: Prisma.ProjectCodeIndexUpdateManyMutationInput,
	owner: CodeIndexOwner | undefined,
): Promise<CodeIndexWriteOutcome> {
	if (!owner) {
		const { count } = await db.projectCodeIndex.updateMany({
			where: repoWhere(key),
			data,
		});
		return count > 0 ? "written" : "absent";
	}
	const { count } = await db.projectCodeIndex.updateMany({
		where: { ...repoWhere(key), ...ownedByWhere(owner) },
		data: { ...data, ...ownerClaim(owner) },
	});
	return count > 0 ? "written" : missOutcome(key);
}

/**
 * Get one repo's code index row. Defaults to the legacy/default-repo row when no
 * integration id is given.
 */
export async function getProjectCodeIndex(
	projectId: string,
	repositoryIntegrationId: string | null = null,
	branch = "main",
) {
	return db.projectCodeIndex.findFirst({
		where: { projectId, repositoryIntegrationId, branch },
	});
}

/** All code-index rows for a project — one per connected repo. */
export async function getProjectCodeIndexes(projectId: string) {
	return db.projectCodeIndex.findMany({
		where: { projectId },
		orderBy: { createdAt: "asc" },
	});
}

/**
 * Rank of each index status by "how queryable the codebase is" (lower wins).
 * Typed as a full `Record<CodeIndexStatus, …>`, so a newly added status is a
 * compile error until it's ranked here — no status can silently fall through.
 */
const CODE_INDEX_STATUS_RANK: Record<CodeIndexStatus, number> = {
	READY: 0,
	STALE: 1,
	INDEXING: 2,
	PENDING: 3,
	FAILED: 4,
};

/**
 * Collapse a project's per-repo index rows into one status: the most-available
 * status across repos (a READY repo makes the codebase queryable even while
 * another is still INDEXING). Null when there are no rows.
 */
export function aggregateCodeIndexStatus(
	indexes: Array<{ status: CodeIndexStatus }>,
): CodeIndexStatus | null {
	let best: CodeIndexStatus | null = null;
	for (const { status } of indexes) {
		if (
			best === null ||
			CODE_INDEX_STATUS_RANK[status] < CODE_INDEX_STATUS_RANK[best]
		) {
			best = status;
		}
	}
	return best;
}

/**
 * Create or update one repo's code index row. Used at the start of a repo's
 * indexing run to set status to INDEXING.
 *
 * With an `owner`, this is the chain's claim on the row: an update lands only
 * under the ownership rule (see CodeIndexOwner) and a create records the
 * owner. `superseded` means a newer chain holds the row and nothing was written.
 */
export async function upsertProjectCodeIndex(
	input: UpsertCodeIndexInput,
): Promise<CodeIndexWriteOutcome> {
	const { userId, organizationId, commitSha, status, workflowId, owner } =
		input;

	// A fresh (non-continuation) run starts at 0 files with an unknown total —
	// the embed loop fills these in per batch. Resetting here means a re-index
	// never shows the previous run's stale progress bar.
	const updateData = {
		commitSha,
		status: status ?? "INDEXING",
		indexedAt: new Date(),
		error: null,
		workflowId,
		indexedFileCount: 0,
		totalFileCount: null,
	};

	const updateExisting = async (
		id: string,
	): Promise<CodeIndexWriteOutcome> => {
		if (!owner) {
			await db.projectCodeIndex.update({
				where: { id },
				data: updateData,
			});
			return "written";
		}
		const { count } = await db.projectCodeIndex.updateMany({
			where: { id, ...ownedByWhere(owner) },
			data: { ...updateData, ...ownerClaim(owner) },
		});
		return count > 0 ? "written" : missOutcome(input);
	};

	const existing = await db.projectCodeIndex.findFirst({
		where: repoWhere(input),
		select: { id: true },
	});
	if (existing) {
		return updateExisting(existing.id);
	}
	try {
		await db.projectCodeIndex.create({
			data: {
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
				branch: input.branch ?? "main",
				userId,
				organizationId,
				commitSha,
				status: status ?? "PENDING",
				indexedAt: new Date(),
				workflowId,
				indexedFileCount: 0,
				totalFileCount: null,
				...(owner ? ownerClaim(owner) : {}),
			},
		});
		return "written";
	} catch (error) {
		// A concurrent run created the row between our findFirst and create
		// (unique violation on the composite key) — re-find and update instead,
		// under the same ownership rule.
		const raced = await db.projectCodeIndex.findFirst({
			where: repoWhere(input),
			select: { id: true },
		});
		if (raced) {
			return updateExisting(raced.id);
		}
		throw error;
	}
}

/**
 * Update one repo's index status (e.g., INDEXING -> READY, or -> FAILED).
 * With an `owner`, lands only under the ownership rule (see CodeIndexOwner).
 */
export async function updateCodeIndexStatus(
	key: CodeIndexRepoKey,
	status: CodeIndexStatus,
	error?: string,
	owner?: CodeIndexOwner,
): Promise<CodeIndexWriteOutcome> {
	return writeRepoRow(
		key,
		{
			status,
			error: error ?? null,
			...(status === "READY" ? { lastFullIndexAt: new Date() } : {}),
		},
		owner,
	);
}

/**
 * Update one repo's index stats after a successful run. With an `owner`, lands
 * only under the ownership rule (see CodeIndexOwner).
 */
export async function updateCodeIndexStats(
	input: UpdateCodeIndexStatsInput,
): Promise<CodeIndexWriteOutcome> {
	const now = new Date();
	return writeRepoRow(
		input,
		{
			// filesIndexed + manifest are the full current file set in both modes.
			filesIndexed: input.filesIndexed,
			indexDurationMs: input.indexDurationMs,
			fileManifest: input.fileManifest as any,
			redactionManifest: input.redactionManifest as any,
			status: "READY",
			...(input.incremental
				? // Incremental: keep the last full index's chunk/summary totals
					// (this run only re-embedded a few files) and stamp the
					// incremental time.
					{ lastIncrementalAt: now }
				: // Full: refresh the totals and stamp the full-index time.
					{
						chunksCreated: input.chunksCreated,
						summariesCreated: input.summariesCreated,
						lastFullIndexAt: now,
					}),
		},
		input.owner,
	);
}

/**
 * Best-effort live-progress update for one repo's index row, written per embed
 * batch so the Settings UI can render a determinate progress bar while INDEXING.
 * A no-op `updateMany` (row not yet created) is harmless; callers wrap this in
 * try/catch so a progress write never breaks the embedding loop. With an
 * `owner`, a superseded chain's batch leaves the successor's progress alone.
 */
export async function updateCodeIndexProgress(
	key: CodeIndexRepoKey,
	progress: { indexedFileCount: number; totalFileCount: number | null },
	owner?: CodeIndexOwner,
) {
	const data = {
		indexedFileCount: progress.indexedFileCount,
		totalFileCount: progress.totalFileCount,
	};
	return db.projectCodeIndex.updateMany({
		where: owner
			? { ...repoWhere(key), ...ownedByWhere(owner) }
			: repoWhere(key),
		data: owner ? { ...data, ...ownerClaim(owner) } : data,
	});
}

/**
 * Mark READY index rows STALE (e.g., after a push). Scoped to one repo when a
 * repositoryIntegrationId is given, else all of the project's repos.
 */
export async function markCodeIndexStale(
	projectId: string,
	repositoryIntegrationId?: string | null,
) {
	return db.projectCodeIndex.updateMany({
		where: {
			projectId,
			status: "READY",
			...(repositoryIntegrationId !== undefined
				? { repositoryIntegrationId }
				: {}),
		},
		data: { status: "STALE" },
	});
}

/**
 * Delete code index rows. Scoped to one repo when a repositoryIntegrationId is
 * given (repo unlink), else all of the project's repos (project delete).
 */
export async function deleteProjectCodeIndex(
	projectId: string,
	repositoryIntegrationId?: string | null,
) {
	return db.projectCodeIndex.deleteMany({
		where: {
			projectId,
			...(repositoryIntegrationId !== undefined
				? { repositoryIntegrationId }
				: {}),
		},
	});
}
