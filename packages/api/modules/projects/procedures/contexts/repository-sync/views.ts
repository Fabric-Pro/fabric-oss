/**
 * What the Context tab is shown of a Living Memory repository sync (design
 * 2026-09-23 §5.1, §7): shapes shared by the procedures, never a database
 * row returned as-is. Members appear by display name only; no credential,
 * token or internal fence value (`activeRunKey`, `generation`) leaves here.
 */
import type {
	ContextRepositorySyncRunReceipt,
	ContextRepositorySyncView,
	ContextSyncApplyOutcome,
} from "@repo/database";

/** How many apply-time attention keys a receipt view carries (§8). */
const MAX_APPLY_ATTENTION = 100;

type ApplyTallies = Record<ContextSyncApplyOutcome, number>;

/** A run receipt as the tab renders it. */
export function toContextSyncRunView(run: ContextRepositorySyncRunReceipt) {
	const tallies: ApplyTallies = {
		created: 0,
		updated: 0,
		adopted: 0,
		unchanged: 0,
		conflict: 0,
		"path-in-use": 0,
	};
	const applyAttention: Array<{
		key: string;
		reason: "conflict" | "path-in-use";
	}> = [];
	for (const [key, outcome] of Object.entries(run.outcomes)) {
		tallies[outcome]++;
		if (
			(outcome === "conflict" || outcome === "path-in-use") &&
			applyAttention.length < MAX_APPLY_ATTENTION
		) {
			applyAttention.push({ key, reason: outcome });
		}
	}
	applyAttention.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return {
		id: run.id,
		trigger: run.trigger,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		status: run.status,
		error: run.error,
		commitSha: run.commitSha,
		userName: run.userName,
		counts: {
			created: tallies.created,
			updated: tallies.updated,
			adopted: tallies.adopted,
			unchanged: tallies.unchanged,
			conflict: tallies.conflict,
			pathInUse: tallies["path-in-use"],
			removed: run.removedCount,
			pruneConflicts:
				run.pruneConflicts.keys.length + run.pruneConflicts.overflow,
		},
		/**
		 * The plan receipt's summary and its capped attention sample. The
		 * full kept and protected key sets stay server-side.
		 */
		plan: run.plan
			? {
					keptCount: run.plan.keptCount,
					excludedCount: run.plan.excludedCount,
					attentionCount: run.plan.attentionCount,
					attention: run.plan.attention,
					missingPaths: run.plan.missingPaths,
					protectedPrefixes: run.plan.protectedPrefixes,
				}
			: null,
		/** Keys the apply step left alone, at most 100, sorted. */
		applyAttention,
		/** Keys a prune could not delete, at most 100, plus the overflow. */
		pruneConflicts: {
			keys: run.pruneConflicts.keys,
			overflow: run.pruneConflicts.overflow,
		},
	};
}

/**
 * The configuration minus internals, with its integration summary and its
 * automatic-sync state (§11.1): whether the poll and the push webhook start
 * runs, why they stopped if they did, when the poll next looks, and how
 * many checks in a row have failed. The cursors stay server-side.
 */
export function toContextSyncConfigurationView(
	sync: ContextRepositorySyncView,
) {
	return {
		syncId: sync.id,
		repositoryIntegrationId: sync.repositoryIntegrationId,
		ref: sync.ref,
		paths: sync.paths,
		automatic: sync.automatic,
		automaticPausedReason: sync.automaticPausedReason,
		automaticPausedAt: sync.automaticPausedAt,
		nextCheckAt: sync.nextCheckAt,
		failureCount: sync.failureCount,
		lastAppliedCommitSha: sync.lastAppliedCommitSha,
		configuredByName: sync.user.name,
		createdAt: sync.createdAt,
		updatedAt: sync.updatedAt,
		integration: {
			provider: sync.repositoryIntegration.provider,
			repositoryOwner: sync.repositoryIntegration.repositoryOwner,
			repositoryName: sync.repositoryIntegration.repositoryName,
			status: sync.repositoryIntegration.status,
		},
	};
}
