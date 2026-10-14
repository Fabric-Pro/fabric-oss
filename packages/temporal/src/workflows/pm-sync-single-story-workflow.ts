/**
 * PM Sync Single Item Workflow
 *
 * Thin fire-and-forget wrapper around `syncWorkItemToPM` for the
 * manual-edit / retry paths. Mirrors the catch + finally guard from
 * `backlogApplyChangesWorkflow` so a failed activity persists FAILED on
 * the hierarchy row and a stuck PENDING row never leaks.
 *
 * Workflow name retained as `pmSyncSingleStoryWorkflow` for compat with
 * existing in-flight workflows; input now generalizes to any hierarchy
 * item type (story/bug/feature/epic) via `itemType`.
 *
 * Attempts: the enqueue stamps the row PENDING with a fresh attempt id and
 * passes it as `pmSyncAttemptId`. Every status write of the run is scoped to
 * that attempt. The workflow id is one per item with USE_EXISTING, so an
 * enqueue that stamps attempt B while this run syncs attempt A attaches to
 * this run instead of starting one; A's writes and A's PENDING clear then
 * skip the row, and B stays PENDING. The run does not sync again for B: it
 * cannot know B's destination, MCP config, actor or force flag. The
 * stuck-sync watchdog retries B once its PENDING is past the retry threshold
 * (`retryStuckPmSyncActivity`): it re-resolves the target through the same
 * enqueue as the project owner and never sets `pushAnyway`, so the drift
 * check stays on. (It does pass `forceInitialPush`, which lets an unlinked
 * row be pushed; see the orphan exception below.) So the run schedules
 * exactly the commands it always has (sync, failure stamp on a throw, PENDING
 * clear); only the activity arguments carry the attempt, and arguments are
 * not part of the replay check.
 *
 * The one exception is an orphaned create (`create_orphan`: a ticket was
 * created but is not linked). B's PENDING must not survive it, because the
 * watchdog would retry B against an unlinked row and create a second ticket.
 * So after that outcome the clear removes any PENDING on the row, whichever
 * attempt stamped it, as it did before attempts existed.
 *
 * `create_unconfirmed` (this run sent no create because the row's claim was
 * held, or its create got no definite answer) does not widen the clear. Its
 * FAILED stamp already overrode any PENDING present when it was written
 * (`recordCreateUnconfirmed`), so a PENDING on the row afterwards was stamped
 * later, by a newer push. That push may follow a link the claim holder wrote
 * meanwhile, so its PENDING must survive; while the claim is still held its
 * own create is refused by the claim, not by this clear.
 */

import { log, proxyActivities } from "@temporalio/workflow";

import type {
	syncWorkItemToPM as SyncWorkItemToPMFn,
	WorkItemType,
} from "../activities/pm-integration/hierarchy-sync";
import type {
	clearPmSyncPendingIfLeaked as ClearPmSyncPendingIfLeakedFn,
	recordPmSyncFailure as RecordPmSyncFailureFn,
} from "../activities/pm-integration/record-pm-sync-state";
import { PM_SYNC_SINGLE_STORY_SYNC_ACTIVITY_OPTIONS } from "./pm-create-activity-options";
import { unwrapPmSyncError } from "./pm-sync-error-unwrap";

export interface PmSyncSingleStoryWorkflowInput {
	itemId: string;
	itemType: WorkItemType;
	projectId: string;
	/**
	 * `null` ONLY on the GitLab REST fallback path (no MCPConfig pinned).
	 * In that case `mcpServerId` must be set so the activity can resolve
	 * the REST source. Non-null for every other PM tool — the resolver in
	 * `enqueuePmSync` skips itself for REST.
	 */
	mcpConfigId: string | null;
	mcpServerId?: string;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	pushAnyway?: boolean;
	triggerSource: "manual-edit" | "retry";
	/**
	 * The attempt id the enqueue stamped on the row before starting this run
	 * (`lastPmSyncAttemptId`). Optional so histories started before it was
	 * passed replay unchanged; those runs' status writes skip a row that is
	 * PENDING for an attempt and are otherwise by id (`writePmSyncRunStatus`).
	 */
	pmSyncAttemptId?: string;
}

export interface PmSyncSingleStoryWorkflowOutput {
	status: "SUCCESS" | "CONFLICT" | "FAILED";
	errorClass?: string;
	message?: string;
}

const { syncWorkItemToPM } = proxyActivities<{
	syncWorkItemToPM: typeof SyncWorkItemToPMFn;
}>(PM_SYNC_SINGLE_STORY_SYNC_ACTIVITY_OPTIONS);

const { recordPmSyncFailure, clearPmSyncPendingIfLeaked } = proxyActivities<{
	recordPmSyncFailure: typeof RecordPmSyncFailureFn;
	clearPmSyncPendingIfLeaked: typeof ClearPmSyncPendingIfLeakedFn;
}>({
	startToCloseTimeout: "10 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export async function pmSyncSingleStoryWorkflow(
	input: PmSyncSingleStoryWorkflowInput,
): Promise<PmSyncSingleStoryWorkflowOutput> {
	const {
		itemId,
		itemType,
		projectId,
		mcpConfigId,
		mcpServerId,
		containerId,
		containerName,
		additionalContext,
		userId,
		organizationId,
		pushAnyway,
		triggerSource,
		pmSyncAttemptId,
	} = input;

	// Set only when the sync reports an orphaned create (`create_orphan`);
	// widens the final clear. `create_unconfirmed` leaves it false.
	let createOrphaned = false;
	try {
		try {
			const result = await syncWorkItemToPM({
				itemType,
				itemId,
				projectId,
				mcpConfigId,
				mcpServerId,
				containerId,
				containerName,
				additionalContext,
				userId,
				organizationId,
				action: "update",
				triggerSource,
				pushAnyway,
				pmSyncAttemptId,
			});

			if (result.status === "SUCCESS") {
				return { status: "SUCCESS" };
			}
			if (result.status === "FAILED") {
				// `syncWorkItemToPM` has already stamped lastPmSyncStatus =
				// FAILED via `recordPmSyncFailure` (`create_orphan`, or
				// `create_unconfirmed` when the create was not sent or got no
				// definite answer) before returning, so we DON'T re-stamp here
				// (would clobber its detailed message). Just propagate the
				// outcome to the caller so the procedure surfaces an honest
				// FAILED toast instead of a misleading CONFLICT toast. Only
				// `create_orphan` (this run created a ticket it could not
				// link) widens the PENDING clear below; see the header.
				// A result without a class predates `create_unconfirmed` and
				// is an orphan.
				const errorClass = result.errorClass ?? "create_orphan";
				createOrphaned = errorClass === "create_orphan";
				return {
					status: "FAILED",
					errorClass,
					message: result.error,
				};
			}
			// CONFLICT is the only remaining variant of SyncWorkItemResult.
			return { status: "CONFLICT" };
		} catch (error) {
			const { message: errorMessage, errorClass } =
				unwrapPmSyncError(error);
			log.warn("pm.sync.single-item.failed", {
				itemId,
				itemType,
				errorClass,
				message: errorMessage,
			});
			await recordPmSyncFailure({
				itemId,
				itemType,
				errorMessage,
				errorClass,
				triggerSource,
				onlyIfAttempt: pmSyncAttemptId,
			});
			return {
				status: "FAILED",
				errorClass,
				message: errorMessage,
			};
		}
	} finally {
		// Normally only this run's own PENDING (or, without an attempt id, a
		// PENDING no attempt owns): a newer attempt's PENDING is left for the
		// watchdog. After an orphaned create (`create_orphan` only, not
		// `create_unconfirmed`), any PENDING, so the watchdog
		// cannot retry an attached attempt into a second ticket. Residual: an
		// enqueue that stamps after this clear but before the run closes
		// stays PENDING and is retried by the watchdog against the unlinked
		// row. (A fresh push after an orphan creates a second ticket too; that
		// is not specific to this path.)
		await clearPmSyncPendingIfLeaked({
			itemId,
			itemType,
			attemptId: pmSyncAttemptId,
			...(createOrphaned ? { anyAttempt: true } : {}),
		});
	}
}
