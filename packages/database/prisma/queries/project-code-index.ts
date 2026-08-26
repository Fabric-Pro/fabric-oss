/**
 * Project Code Index Queries
 *
 * CRUD for the ProjectCodeIndex model — one row per connected repository
 * (keyed by projectId + repositoryIntegrationId + branch), mirroring
 * AtlasAnalysis. `repositoryIntegrationId = null` is a legacy/default-repo row.
 */

import { db } from "../client";
import type { CodeIndexStatus } from "../generated/client";

/** Identifies one repo's index row within a project. */
export interface CodeIndexRepoKey {
	projectId: string;
	repositoryIntegrationId: string | null;
	/** Defaults to "main". */
	branch?: string;
}

export interface UpsertCodeIndexInput extends CodeIndexRepoKey {
	userId: string;
	organizationId?: string | null;
	commitSha: string;
	status?: CodeIndexStatus;
	workflowId?: string;
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
 */
export async function upsertProjectCodeIndex(input: UpsertCodeIndexInput) {
	const { userId, organizationId, commitSha, status, workflowId } = input;

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

	const existing = await db.projectCodeIndex.findFirst({
		where: repoWhere(input),
		select: { id: true },
	});
	if (existing) {
		return db.projectCodeIndex.update({
			where: { id: existing.id },
			data: updateData,
		});
	}
	try {
		return await db.projectCodeIndex.create({
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
			},
		});
	} catch (error) {
		// A concurrent run created the row between our findFirst and create
		// (unique violation on the composite key) — re-find and update instead.
		const raced = await db.projectCodeIndex.findFirst({
			where: repoWhere(input),
			select: { id: true },
		});
		if (raced) {
			return db.projectCodeIndex.update({
				where: { id: raced.id },
				data: updateData,
			});
		}
		throw error;
	}
}

/** Update one repo's index status (e.g., INDEXING -> READY, or -> FAILED). */
export async function updateCodeIndexStatus(
	key: CodeIndexRepoKey,
	status: CodeIndexStatus,
	error?: string,
) {
	return db.projectCodeIndex.updateMany({
		where: repoWhere(key),
		data: {
			status,
			error: error ?? null,
			...(status === "READY" ? { lastFullIndexAt: new Date() } : {}),
		},
	});
}

/** Update one repo's index stats after a successful run. */
export async function updateCodeIndexStats(input: UpdateCodeIndexStatsInput) {
	const now = new Date();
	return db.projectCodeIndex.updateMany({
		where: repoWhere(input),
		data: {
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
	});
}

/**
 * Best-effort live-progress update for one repo's index row, written per embed
 * batch so the Settings UI can render a determinate progress bar while INDEXING.
 * A no-op `updateMany` (row not yet created) is harmless; callers wrap this in
 * try/catch so a progress write never breaks the embedding loop.
 */
export async function updateCodeIndexProgress(
	key: CodeIndexRepoKey,
	progress: { indexedFileCount: number; totalFileCount: number | null },
) {
	return db.projectCodeIndex.updateMany({
		where: repoWhere(key),
		data: {
			indexedFileCount: progress.indexedFileCount,
			totalFileCount: progress.totalFileCount,
		},
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
