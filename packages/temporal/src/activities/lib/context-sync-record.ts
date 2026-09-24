/**
 * How a Living Memory sync run is completed (design 2026-09-23 §5.4, Fizzy
 * #2657): the status table over a run's ledger, and the one audit row every
 * completed receipt gets. Used by `record` and by `begin`'s refusals, which
 * insert their receipt already finished.
 *
 * Not in the activity module on purpose: every export there is a
 * schedulable activity.
 */
import {
	type ContextSyncOutcomes,
	type ContextSyncPlan,
	type ContextSyncPruneConflicts,
	type Prisma,
	recordAuditTx,
} from "@repo/database";
import type {
	ContextSyncRunStatus,
	ProjectContextSyncError,
} from "../../lib/context-sync-types";

/** A run's ledger as tallies: what the audit row and the status table read. */
export interface ContextSyncRunCounts {
	created: number;
	updated: number;
	adopted: number;
	unchanged: number;
	/** Apply-time: a guarded write that matched nothing. */
	conflict: number;
	/** Apply-time: an unowned row with other content holds the path. */
	pathInUse: number;
	removed: number;
	/** Distinct keys a prune could not delete, plus the overflow count. */
	pruneConflicts: number;
	/** The plan receipt's attention count (planning-time reasons). */
	attention: number;
}

export function tallyContextSyncRun(ledger: {
	plan: ContextSyncPlan | null;
	outcomes: ContextSyncOutcomes;
	removedCount: number;
	pruneConflicts: ContextSyncPruneConflicts;
}): ContextSyncRunCounts {
	const counts: ContextSyncRunCounts = {
		created: 0,
		updated: 0,
		adopted: 0,
		unchanged: 0,
		conflict: 0,
		pathInUse: 0,
		removed: ledger.removedCount,
		pruneConflicts:
			ledger.pruneConflicts.keys.length + ledger.pruneConflicts.overflow,
		attention: ledger.plan?.attentionCount ?? 0,
	};
	for (const outcome of Object.values(ledger.outcomes)) {
		if (outcome === "path-in-use") {
			counts.pathInUse++;
		} else {
			counts[outcome]++;
		}
	}
	return counts;
}

/** The counts of a run that never reached its ledger. */
export const EMPTY_CONTEXT_SYNC_RUN_COUNTS: ContextSyncRunCounts = {
	created: 0,
	updated: 0,
	adopted: 0,
	unchanged: 0,
	conflict: 0,
	pathInUse: 0,
	removed: 0,
	pruneConflicts: 0,
	attention: 0,
};

/**
 * The status table (§5.4), first match wins:
 *
 *  1. `begin` never handed the run a context (it threw, or its answer was
 *     lost to a cancellation after its receipt committed) → `FAILED`, with
 *     the typed error, else `INTERRUPTED` for a cancellation, else
 *     `STORE_FAILED` — such a run cannot have written anything;
 *  2. a typed failure or a `begin` refusal → `FAILED` with it;
 *  3. cancelled → `FAILED` / `INTERRUPTED`: the run stopped before it
 *     finished, the verdict reconciliation gives an execution that stopped
 *     (§5.3.0 step 3). Deriving it from a partial ledger would report a run
 *     that never pruned or indexed as applied;
 *  4. anything needing attention — the plan's attention count, apply
 *     conflicts and paths in use, prune conflicts → `PARTIAL`;
 *  5. anything written — created, updated, adopted, removed → `SUCCEEDED`;
 *  6. `UNCHANGED`.
 */
export function deriveContextSyncRunVerdict(input: {
	begun: boolean;
	error: ProjectContextSyncError | null;
	cancelled: boolean;
	counts: ContextSyncRunCounts;
}): { status: ContextSyncRunStatus; error: ProjectContextSyncError | null } {
	if (!input.begun) {
		return {
			status: "FAILED",
			error:
				input.error ??
				(input.cancelled ? "INTERRUPTED" : "STORE_FAILED"),
		};
	}
	if (input.error) {
		return { status: "FAILED", error: input.error };
	}
	if (input.cancelled) {
		return { status: "FAILED", error: "INTERRUPTED" };
	}
	const { counts } = input;
	if (
		counts.attention +
			counts.conflict +
			counts.pathInUse +
			counts.pruneConflicts >
		0
	) {
		return { status: "PARTIAL", error: null };
	}
	if (counts.created + counts.updated + counts.adopted + counts.removed > 0) {
		return { status: "SUCCEEDED", error: null };
	}
	return { status: "UNCHANGED", error: null };
}

/**
 * `project.context.repository_sync_completed`, in the caller's transaction so
 * it commits with the receipt it describes. Attributed to the member the run
 * acted as. Status, error, commit and counts — never a path, a key, a URL or
 * content.
 */
export async function recordContextSyncCompletedAudit(
	tx: Prisma.TransactionClient,
	input: {
		projectId: string;
		organizationId: string;
		syncId: string;
		runKey: string;
		actingUserId: string;
		/** `owner/name`, when the integration still exists. */
		repository: string | null;
		status: ContextSyncRunStatus;
		error: ProjectContextSyncError | null;
		commitSha: string | null;
		counts: ContextSyncRunCounts;
	},
): Promise<void> {
	const failed = input.status === "FAILED";
	await recordAuditTx(tx, {
		action: "project.context.repository_sync_completed",
		category: "project",
		severity: failed ? "warning" : "info",
		outcome: failed ? "failure" : "success",
		actor: { type: "user", userId: input.actingUserId },
		organizationId: input.organizationId,
		projectId: input.projectId,
		resource: {
			type: "project_context_repository_sync",
			id: input.syncId,
			name: input.repository,
		},
		metadata: {
			runId: input.runKey,
			trigger: "MANUAL",
			status: input.status,
			error: input.error,
			commitSha: input.commitSha,
			counts: { ...input.counts },
		},
	});
}
