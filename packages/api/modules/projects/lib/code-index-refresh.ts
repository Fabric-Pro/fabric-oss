/**
 * Bringing a repository's code index up to its branch HEAD, re-embedding only
 * the files that changed. Shared by the manual "incremental" re-index and the
 * scheduled refresh (spec 2026-10-29 code-index-sync), so both diff the
 * indexed commit against HEAD the same way.
 */

import {
	canEditProject,
	db,
	getProjectCodeIndexes,
	getProjectRepoIntegration,
	markCodeIndexStale,
	recordCodeIndexRefreshCheck,
} from "@repo/database";
import { resolveFreshRepoToken } from "@repo/integrations";
import { isCodeIndexingEnabled } from "./code-indexing-enabled";
import { startCodeIndexingForProject } from "./code-indexing-trigger";
import {
	compareIndexedCommitToHead,
	type RepoCompareRef,
} from "./repo-compare";

/** How a requested incremental re-index should actually run. */
export type IncrementalPlan =
	| { kind: "up-to-date" }
	| { kind: "incremental"; changedFiles: string[] }
	| {
			kind: "full-fallback";
			reason: "no-baseline" | "no-token" | "compare-failed" | "truncated";
	  };

/**
 * Decide how an incremental re-index should run for one repo: compute the changed
 * files from the indexed commit → branch HEAD, or fall back to a full index when
 * there is no baseline / the compare is unusable, or report already up to date.
 */
export async function planIncrementalReindex(params: {
	projectId: string;
	integrationId: string;
	repo: RepoCompareRef;
	userId: string;
	organizationId: string | null | undefined;
}): Promise<IncrementalPlan> {
	const indexes = await getProjectCodeIndexes(params.projectId);
	const index = indexes
		.filter((i) => i.repositoryIntegrationId === params.integrationId)
		.sort(
			(a, b) =>
				(b.indexedAt?.getTime() ?? 0) - (a.indexedAt?.getTime() ?? 0),
		)[0];

	// Never fully indexed (no row, a placeholder commit, or no branch) — an
	// incremental run needs a real baseline, so rebuild fully instead.
	if (
		!index ||
		!index.commitSha ||
		index.commitSha === "pending" ||
		!index.branch
	) {
		return { kind: "full-fallback", reason: "no-baseline" };
	}

	const { token } = await resolveFreshRepoToken({
		integrationId: params.integrationId,
		projectId: params.projectId,
		userId: params.userId,
		organizationId: params.organizationId,
	});
	// No usable token → can't diff. Fall back to full, which surfaces the
	// no-credentials error via the shared trigger if the token is genuinely gone.
	if (!token) {
		return { kind: "full-fallback", reason: "no-token" };
	}

	const compare = await compareIndexedCommitToHead({
		repo: params.repo,
		token,
		base: index.commitSha,
		head: index.branch,
	});

	// Compare failed (expired access, rewritten history), or the provider capped
	// the changed-file list — a diff-only run off a partial list would miss
	// files, so rebuild fully.
	if (compare.status === "unknown") {
		return { kind: "full-fallback", reason: "compare-failed" };
	}
	if (compare.truncated) {
		return { kind: "full-fallback", reason: "truncated" };
	}
	// No new commits / nothing changed — don't start a no-op run.
	if (compare.aheadBy === 0 || compare.changedFiles.length === 0) {
		return { kind: "up-to-date" };
	}
	return { kind: "incremental", changedFiles: compare.changedFiles };
}

export type ScheduledRefreshOutcome =
	| "up-to-date"
	| "started"
	| "needs-full-reindex"
	| "no-credentials"
	| "compare-failed"
	| "not-indexable";

/** What the code index panel shows for a check that could not refresh. */
const REFRESH_ERRORS: Partial<Record<ScheduledRefreshOutcome, string>> = {
	"needs-full-reindex":
		"Too many changes to update file by file; run a full re-index",
	"no-credentials": "No usable credentials for this repository; reconnect it",
	"compare-failed":
		"Could not compare the indexed commit with the branch (access expired or history rewritten); reconnect the repository or run a full re-index",
	"not-indexable":
		"The project's code search is not RAG, the repository is left out of code search, or it is gone",
};

/**
 * One scheduled check of one repository index: compare its commit with the
 * branch HEAD and, when files changed, start an incremental run for exactly
 * those files. Never starts a full rebuild on its own — that is expensive and
 * stays a person's decision; the index is marked stale with the reason
 * instead. The check's outcome is recorded on the index row.
 */
export async function refreshCodeIndexOnSchedule(params: {
	codeIndexId: string;
	now?: Date;
}): Promise<ScheduledRefreshOutcome> {
	const checkedAt = params.now ?? new Date();
	const index = await db.projectCodeIndex.findUnique({
		where: { id: params.codeIndexId },
		select: {
			id: true,
			projectId: true,
			repositoryIntegrationId: true,
			userId: true,
		},
	});
	const outcome = await refreshOne(index);
	if (index) {
		await recordCodeIndexRefreshCheck({
			id: index.id,
			checkedAt,
			error: REFRESH_ERRORS[outcome] ?? null,
		});
		if (outcome === "needs-full-reindex") {
			await markCodeIndexStale(
				index.projectId,
				index.repositoryIntegrationId,
			);
		}
	}
	return outcome;
}

export type ContextPathsReindexOutcome =
	| "started"
	| "no-index"
	| "indexing"
	| "needs-full-reindex"
	| "not-indexable";

/**
 * Living Memory took files into Context, or let them go: re-run the code
 * index for exactly those paths, so a file Living Memory keeps leaves the
 * code index and a file it let go comes back (`listContextCoveredCodePaths`
 * decides which, per batch). The run also takes any commits the index has not
 * seen yet: an incremental run moves the index to HEAD, so it must carry
 * every file changed since. While a run is in flight it decides the same
 * way for every batch still ahead, so nothing is started over it.
 */
export async function reindexContextCoveredPaths(params: {
	projectId: string;
	repositoryIntegrationId: string;
	paths: string[];
}): Promise<ContextPathsReindexOutcome> {
	if (params.paths.length === 0) {
		return "not-indexable";
	}
	const integration = await getProjectRepoIntegration(
		params.repositoryIntegrationId,
		params.projectId,
	);
	if (!integration?.includedInCodeSearch) {
		return "not-indexable";
	}
	const project = await db.project.findUnique({
		where: { id: params.projectId },
		select: {
			organizationId: true,
			ragSettings: { select: { codeSearchMode: true } },
		},
	});
	if (!isCodeIndexingEnabled(project?.ragSettings?.codeSearchMode)) {
		return "not-indexable";
	}
	const index = (await getProjectCodeIndexes(params.projectId))
		.filter(
			(i) => i.repositoryIntegrationId === params.repositoryIntegrationId,
		)
		.sort(
			(a, b) =>
				(b.indexedAt?.getTime() ?? 0) - (a.indexedAt?.getTime() ?? 0),
		)[0];
	// No index yet: its first full run will leave the files out by itself.
	if (!index) {
		return "no-index";
	}
	if (index.status === "INDEXING" || index.status === "PENDING") {
		return "indexing";
	}
	// The run acts as the index's creator: only while they may still edit
	// the project.
	if (!(await canEditProject(params.projectId, index.userId))) {
		return "not-indexable";
	}
	const plan = await planIncrementalReindex({
		projectId: params.projectId,
		integrationId: params.repositoryIntegrationId,
		repo: integration,
		userId: index.userId,
		organizationId: project?.organizationId ?? null,
	});
	if (plan.kind === "full-fallback") {
		await markCodeIndexStale(
			params.projectId,
			params.repositoryIntegrationId,
		);
		return "needs-full-reindex";
	}
	const changedFiles = [
		...new Set([
			...params.paths,
			...(plan.kind === "incremental" ? plan.changedFiles : []),
		]),
	];
	const result = await startCodeIndexingForProject({
		projectId: params.projectId,
		userId: index.userId,
		organizationId: project?.organizationId ?? null,
		repositoryIntegrationId: params.repositoryIntegrationId,
		incremental: true,
		changedFiles,
	});
	if (result.disabledReason) {
		return "not-indexable";
	}
	return result.started > 0 ? "started" : "needs-full-reindex";
}

async function refreshOne(
	index: {
		projectId: string;
		repositoryIntegrationId: string | null;
		userId: string;
	} | null,
): Promise<ScheduledRefreshOutcome> {
	if (!index?.repositoryIntegrationId) {
		return "not-indexable";
	}
	const integration = await getProjectRepoIntegration(
		index.repositoryIntegrationId,
		index.projectId,
	);
	if (!integration?.includedInCodeSearch) {
		return "not-indexable";
	}
	// The tenant comes from the project, never from the scheduler's request.
	const project = await db.project.findUnique({
		where: { id: index.projectId },
		select: {
			organizationId: true,
			ragSettings: { select: { codeSearchMode: true } },
		},
	});
	// Checked before any provider call: only RAG keeps an index current.
	if (!isCodeIndexingEnabled(project?.ragSettings?.codeSearchMode)) {
		return "not-indexable";
	}
	// The check acts as the index's creator, with their repository access:
	// only while they may still edit the project.
	if (!(await canEditProject(index.projectId, index.userId))) {
		return "no-credentials";
	}
	const plan = await planIncrementalReindex({
		projectId: index.projectId,
		integrationId: index.repositoryIntegrationId,
		repo: integration,
		userId: index.userId,
		organizationId: project?.organizationId ?? null,
	});
	if (plan.kind === "up-to-date") {
		return "up-to-date";
	}
	if (plan.kind === "full-fallback") {
		if (plan.reason === "no-token") {
			return "no-credentials";
		}
		// A failed compare is retried at the next check; only a diff too large
		// to list (or no baseline) means the index needs a full rebuild.
		return plan.reason === "compare-failed"
			? "compare-failed"
			: "needs-full-reindex";
	}
	const result = await startCodeIndexingForProject({
		projectId: index.projectId,
		userId: index.userId,
		organizationId: project?.organizationId ?? null,
		repositoryIntegrationId: index.repositoryIntegrationId,
		incremental: true,
		changedFiles: plan.changedFiles,
	});
	if (result.disabledReason) {
		return "not-indexable";
	}
	return result.started > 0 ? "started" : "no-credentials";
}
