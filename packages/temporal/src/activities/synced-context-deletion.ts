/**
 * Synced context deletion activities (Fizzy #2636): the three steps of the
 * compare-and-set delete behind `fabric context push --prune`, run in order
 * by `syncedContextDeletionWorkflow`, and the publish that follows a delete.
 *
 *  1. `claimSyncedContextForDeletion` — the path still holds the named
 *     version: mark it unindexed (`embeddedAt: null`) in the same guarded
 *     write, or answer `absent` / `conflict` and change nothing.
 *  2. `deleteSyncedContextVectors` — remove the row's points, strictly.
 *  3. `deleteSyncedContextRow` — delete the row under the claim's guard.
 *  4. `publishSyncedContextDeleted` — only after step 3 deleted the row: the
 *     realtime events the Context tab's delete emits.
 *
 * They are separate activities so each is retried on its own and the
 * workflow's history records which ones finished: a worker that dies between
 * the vector delete and the row delete resumes at the row delete instead of
 * leaving a row that claims an index it no longer has (which is what the
 * synchronous version could do).
 *
 * Every one is safe to repeat, because Temporal retries them:
 *  - the claim is an `updateMany` keyed on the version; a repeat matches the
 *    same row and writes the same null;
 *  - the vector delete is `deleteProjectContext(..., { strict: true })`, a
 *    filter delete plus a delete of point ids. Qdrant answers a filter that
 *    matches nothing, and point ids that do not exist, with success, and the
 *    collection is ensured before either, so a repeat after a delete that
 *    landed succeeds with nothing left to remove;
 *  - the row delete and its audit row commit in one transaction, keyed by
 *    the operation id; a repeat after an attempt that committed matches
 *    nothing, finds that receipt, and answers `deleted` without writing a
 *    second row (see `deleteSyncedContextRow`);
 *  - the publish only emits events; a repeat emits them again, which a
 *    subscriber takes as one more refresh of a list that no longer holds the
 *    row.
 *
 * `organizationId` is the project's hosting organization, resolved by the
 * API from the caller's live access before the workflow was started; these
 * activities re-check nothing about the caller. The queries' guards scope
 * every read and write to that organization and project.
 *
 * Answers are plain JSON: a Date becomes a string in Temporal's payload
 * converter, so dates are sent as ISO strings on purpose rather than
 * arriving as strings typed as Dates.
 */

import {
	claimSyncedContextRowForDeletion,
	deleteClaimedSyncedContextRow,
	getUserById,
	type SyncedContextContentStamp,
	type SyncedContextDeletionAuditContext,
	type SyncedContextRow,
} from "@repo/database";
import { deleteProjectContext } from "@repo/rag";
import { emitActivity, emitContextChange } from "@repo/utils/realtime-emit";
import { activityLogger } from "./lib/activity-logger";

/** The version a delete names, under the project's hosting organization. */
export interface SyncedContextDeletionActivityInput {
	projectId: string;
	/** Normalized, as stored. */
	sourcePath: string;
	/** Lower-case sha256 hex of the version to delete. */
	expectedContentHash: string;
	userId: string;
	organizationId: string;
}

/**
 * Step 3's input: the claimed row, and what its audit row records — the
 * delete's operation id (the receipt's key), the name the claim read, and the
 * request it came from.
 */
export interface DeleteSyncedContextRowInput
	extends SyncedContextDeletionActivityInput {
	contextId: string;
	title: string;
	operationId: string;
	audit: SyncedContextDeletionAuditContext;
}

/**
 * Step 4's input: the row that was deleted, as the realtime events name it.
 * The user's display name is not here: it is read at publish time, so it is
 * not kept in the workflow's history.
 */
export interface PublishSyncedContextDeletedInput {
	/** The project's hosting organization, under which the row was deleted. */
	organizationId: string;
	projectId: string;
	contextId: string;
	/** Normalized, as it was stored. */
	sourcePath: string;
	userId: string;
	contextType: string;
	contextName: string;
}

/** The version stored instead of the named one. Never its content. */
export interface SyncedContextStoredVersion {
	contextId: string;
	contentHash: string | null;
	/** ISO 8601. */
	contentUpdatedAt: string | null;
	contentUpdatedByUserId: string | null;
}

/** A claimed row: what the vector delete needs, and what the API reports. */
export interface ClaimedSyncedContext {
	contextId: string;
	qdrantId: string | null;
	type: string;
	title: string;
}

/** A row whose points were removed but which was not deleted: rebuild it. */
export interface SyncedContextReindexTarget {
	contextId: string;
	sourcePath: string;
	title: string;
}

export type ClaimSyncedContextForDeletionOutput =
	| { status: "claimed"; context: ClaimedSyncedContext }
	| { status: "absent" }
	| { status: "conflict"; current: SyncedContextStoredVersion };

export type DeleteSyncedContextRowOutput =
	| { status: "deleted" }
	| { status: "absent"; reindex: SyncedContextReindexTarget | null }
	| {
			status: "conflict";
			current: SyncedContextStoredVersion;
			reindex: SyncedContextReindexTarget;
	  };

/**
 * The name a synced row goes by: its stored title, else its path's basename.
 * The same rule as `storedSyncedContextTitle` in
 * `packages/api/modules/projects/lib/upsert-synced-context.ts`, which this
 * package cannot import; change the two together.
 */
function syncedContextTitle(
	metadata: SyncedContextRow["metadata"],
	sourcePath: string,
): string {
	const title =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as { title?: unknown }).title
			: undefined;
	return typeof title === "string" && title.trim()
		? title
		: sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
}

function toStoredVersion(
	stamp: SyncedContextContentStamp,
): SyncedContextStoredVersion {
	return {
		contextId: stamp.contextId,
		contentHash: stamp.contentHash,
		contentUpdatedAt: stamp.contentUpdatedAt
			? stamp.contentUpdatedAt.toISOString()
			: null,
		contentUpdatedByUserId: stamp.contentUpdatedByUserId,
	};
}

function toReindexTarget(
	row: SyncedContextRow,
	fallbackPath: string,
): SyncedContextReindexTarget {
	const sourcePath = row.sourcePath ?? fallbackPath;
	return {
		contextId: row.id,
		sourcePath,
		title: syncedContextTitle(row.metadata, sourcePath),
	};
}

/** Step 1: compare, and claim the named version. */
export async function claimSyncedContextForDeletion(
	input: SyncedContextDeletionActivityInput,
): Promise<ClaimSyncedContextForDeletionOutput> {
	const result = await claimSyncedContextRowForDeletion(input);
	if (result.status === "absent") {
		return { status: "absent" };
	}
	if (result.status === "conflict") {
		return { status: "conflict", current: toStoredVersion(result.current) };
	}
	const { context } = result;
	return {
		status: "claimed",
		context: {
			contextId: context.id,
			qdrantId: context.qdrantId,
			type: context.type,
			title: syncedContextTitle(context.metadata, input.sourcePath),
		},
	};
}

/**
 * Step 2: remove the claimed row's points. Strict: a failure throws, and
 * Temporal retries it; nothing after it runs until it succeeds.
 */
export async function deleteSyncedContextVectors(input: {
	contextId: string;
	organizationId: string;
	qdrantId: string | null;
}): Promise<void> {
	await deleteProjectContext(
		input.contextId,
		input.organizationId,
		input.qdrantId ?? undefined,
		{ strict: true },
	);
}

/**
 * Step 3: delete the claimed row, only while it still holds the named version
 * at the named path, and record it: the query writes the audit row in the
 * delete's own transaction, so the delete is recorded even when the request
 * that asked for it is long gone.
 *
 * When the row is no longer there at all, the query's receipt check tells the
 * two causes apart: this operation's audit row means an earlier attempt of
 * this activity committed before its answer was lost (`deleted`); none means
 * somebody else deleted the row after the claim (`absent`). The attempt
 * number cannot: attempt 1 may have failed before it committed, and another
 * caller deleted the row before the retry.
 */
export async function deleteSyncedContextRow(
	input: DeleteSyncedContextRowInput,
): Promise<DeleteSyncedContextRowOutput> {
	const result = await deleteClaimedSyncedContextRow(input);
	switch (result.status) {
		case "deleted":
			return { status: "deleted" };
		case "gone":
			activityLogger.warn(
				"Synced context was deleted by somebody else after it was claimed",
				{ contextId: input.contextId, projectId: input.projectId },
			);
			return { status: "absent", reindex: null };
		case "absent":
			activityLogger.warn(
				"Synced context moved after it was claimed; rebuilding its index",
				{ contextId: input.contextId, projectId: input.projectId },
			);
			return {
				status: "absent",
				reindex: toReindexTarget(result.reindex, input.sourcePath),
			};
		case "conflict":
			activityLogger.warn(
				"Synced context changed after it was claimed; rebuilding its index",
				{ contextId: input.contextId, projectId: input.projectId },
			);
			return {
				status: "conflict",
				current: toStoredVersion(result.current),
				reindex: toReindexTarget(result.reindex, input.sourcePath),
			};
	}
}

/**
 * Step 4, only after step 3 deleted the row: publish the delete with the two
 * events `delete-context.ts` emits, so an open Context tab and the project's
 * activity feed see it as they see the tab's own delete. It runs in the
 * workflow, not in the request that started it, because that request may
 * have answered `in-progress` or died before the delete finished, and a
 * retry of it answers `absent` without emitting anything.
 *
 * Idempotent in effect: it writes nothing, and a repeat (a retry, or a
 * replayed schedule) emits the same events again, which a subscriber takes
 * as one more refresh of a list that no longer holds the row. A duplicate
 * event is harmless. The emitters never throw (a Redis outage degrades to
 * the next refresh); a failed user lookup throws so Temporal retries it.
 */
export async function publishSyncedContextDeleted(
	input: PublishSyncedContextDeletedInput,
): Promise<void> {
	const user = await getUserById(input.userId);
	// As the request labelled it: the name, or "Anonymous".
	const userName = user?.name || "Anonymous";
	await Promise.all([
		emitContextChange({
			projectId: input.projectId,
			contextId: input.contextId,
			action: "deleted",
			userId: input.userId,
			userName,
			contextType: input.contextType,
			contextName: input.contextName,
		}),
		emitActivity({
			projectId: input.projectId,
			userId: input.userId,
			userName,
			activityType: "context_deleted",
			resourceType: "context",
			resourceId: input.contextId,
			resourceName: input.contextName,
			timestamp: new Date().toISOString(),
		}),
	]);
	activityLogger.info("Published the deletion of a synced context", {
		contextId: input.contextId,
		projectId: input.projectId,
		organizationId: input.organizationId,
	});
}
