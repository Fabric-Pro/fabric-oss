/**
 * Synced Context Deletion Workflow (Fizzy #2636)
 *
 * The durable compare-and-set delete behind `fabric context push --prune`
 * and `projects.contexts.deleteSyncedFile`: delete the synced file at a path,
 * but only the version the caller names. The API starts it and waits for the
 * answer (`packages/api/modules/projects/lib/delete-synced-context.ts`).
 *
 *  1. `claimSyncedContextForDeletion` — `absent` or `conflict` end it here,
 *     with nothing changed. `claimed` marks the row unindexed.
 *  2. `deleteSyncedContextVectors` — the row's points, strictly.
 *  3. `deleteSyncedContextRow` — the row, under the claim's guard, and its
 *     audit row in the same transaction, keyed by `input.operationId`: the
 *     delete is recorded even when the request that started this workflow
 *     has gone. If the row changed or moved after the claim, it survives,
 *     nothing is recorded, and since step 2 removed its points, the
 *     embedding workflow is started for it (`reembed: true`) before
 *     answering `conflict` or `absent`.
 *  4. `publishSyncedContextDeleted` — only after step 3 deleted the row: the
 *     realtime events the Context tab's delete emits. Here rather than in the
 *     request, so a delete that finishes after the request answered
 *     `in-progress`, or whose request died, is still seen. Best effort: the
 *     delete is committed and recorded by then, so a publish whose retries
 *     are spent is logged and the answer is still `deleted`.
 *
 * Why a workflow: run in the request, a process that died between step 2
 * and step 3 left a row that said it was indexed and had no points, and
 * nothing came back for it. Here the history records which steps finished,
 * and a restarted worker carries on from the next one. Each activity is safe
 * to repeat (see `activities/synced-context-deletion.ts`).
 *
 * A step whose retries are spent fails the workflow with an
 * `ApplicationFailure` typed per step (`SYNCED_CONTEXT_DELETION_FAILURE`),
 * so the API can say what was done; nothing after that step runs, so a row
 * is never deleted while its points could not be removed.
 *
 * Deterministic: no I/O, clocks, randomness or environment reads. The child
 * workflow's id is derived from this run's id, which replays identically.
 */

import {
	ApplicationFailure,
	log,
	ParentClosePolicy,
	proxyActivities,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type { SyncedContextReindexTarget } from "../activities/synced-context-deletion";
import {
	SYNCED_CONTEXT_DELETION_FAILURE,
	SYNCED_CONTEXT_DELETION_TASK_QUEUE,
	type SyncedContextDeletionWorkflowInput,
	type SyncedContextDeletionWorkflowOutput,
} from "../lib/synced-context-deletion-contract";
import type { ContextEmbeddingWorkflowInput } from "./context-embedding";

// Quick database operations: the Temporal standard's "quick" profile.
const { claimSyncedContextForDeletion, deleteSyncedContextRow } =
	proxyActivities<typeof activities>({
		startToCloseTimeout: "30s",
		retry: {
			maximumAttempts: 5,
		},
	});

// One call to the vector store: the standard's "medium" (API call) profile.
const { deleteSyncedContextVectors } = proxyActivities<typeof activities>({
	startToCloseTimeout: "2m",
	retry: {
		initialInterval: "5s",
		maximumAttempts: 3,
	},
});

// Two event emits after a user lookup: the "quick" profile, with fewer
// attempts, since the request waits on this step for its answer and a
// failed publish changes nothing that was done.
const { publishSyncedContextDeleted } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	retry: {
		maximumAttempts: 3,
	},
});

type FailureType =
	(typeof SYNCED_CONTEXT_DELETION_FAILURE)[keyof typeof SYNCED_CONTEXT_DELETION_FAILURE];

/** Run one step; once its retries are spent, fail typed for the API. */
async function step<T>(type: FailureType, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		throw ApplicationFailure.create({
			message: `${type}: ${error instanceof Error ? error.message : String(error)}`,
			type,
			nonRetryable: true,
			cause: error instanceof Error ? error : undefined,
		});
	}
}

/**
 * Start the embedding workflow for a row whose points step 2 removed but
 * which step 3 did not delete. Abandoned, so it outlives this workflow, and
 * on the queue the upsert starts embeddings on, with the same input shape.
 */
async function rebuildIndex(
	input: SyncedContextDeletionWorkflowInput,
	target: SyncedContextReindexTarget,
): Promise<void> {
	const embedding: ContextEmbeddingWorkflowInput = {
		contextId: target.contextId,
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
		// Synced files are TEXT rows; the upsert embeds them as such.
		type: "TEXT",
		metadata: {
			filename: target.sourcePath,
			sourceTitle: target.title,
			sourcePath: target.sourcePath,
		},
		// Delete-first, hash-guarded: rebuilds whatever version the row
		// holds by the time it runs.
		reembed: true,
	};
	// One rebuild per run at most, so an id carrying this run's id cannot
	// collide; replay does not start it again.
	await startChild("contextEmbeddingWorkflow", {
		workflowId: `context-embedding-${target.contextId}-${workflowInfo().runId}`,
		taskQueue: SYNCED_CONTEXT_DELETION_TASK_QUEUE,
		args: [embedding],
		parentClosePolicy: ParentClosePolicy.ABANDON,
	});
}

export async function syncedContextDeletionWorkflow(
	input: SyncedContextDeletionWorkflowInput,
): Promise<SyncedContextDeletionWorkflowOutput> {
	// The version, alone: the claim needs nothing else, and the audit
	// context rides only to the step that writes the audit row.
	const target = {
		projectId: input.projectId,
		sourcePath: input.sourcePath,
		expectedContentHash: input.expectedContentHash,
		userId: input.userId,
		organizationId: input.organizationId,
	};
	const claim = await step(SYNCED_CONTEXT_DELETION_FAILURE.claim, () =>
		claimSyncedContextForDeletion(target),
	);
	if (claim.status !== "claimed") {
		return claim;
	}
	const { context } = claim;

	await step(SYNCED_CONTEXT_DELETION_FAILURE.indexCleanup, () =>
		deleteSyncedContextVectors({
			contextId: context.contextId,
			organizationId: input.organizationId,
			qdrantId: context.qdrantId,
		}),
	);

	const removed = await step(SYNCED_CONTEXT_DELETION_FAILURE.rowDelete, () =>
		deleteSyncedContextRow({
			...target,
			contextId: context.contextId,
			title: context.title,
			operationId: input.operationId,
			audit: input.audit,
		}),
	);
	if (removed.status === "deleted") {
		try {
			await publishSyncedContextDeleted({
				organizationId: input.organizationId,
				projectId: input.projectId,
				contextId: context.contextId,
				sourcePath: input.sourcePath,
				userId: input.userId,
				contextType: context.type,
				contextName: context.title,
			});
		} catch (error) {
			// Deleted and recorded already: an open tab refreshes on its next
			// load instead. Never a reason to answer anything but `deleted`.
			log.warn("Could not publish the deletion of a synced context", {
				contextId: context.contextId,
				projectId: input.projectId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return { status: "deleted", context };
	}

	if (removed.reindex) {
		await rebuildIndex(input, removed.reindex);
	}
	return removed.status === "conflict"
		? { status: "conflict", current: removed.current }
		: { status: "absent" };
}
