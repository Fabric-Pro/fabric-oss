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
}

export interface PmSyncSingleStoryWorkflowOutput {
	status: "SUCCESS" | "CONFLICT" | "FAILED";
	errorClass?: string;
	message?: string;
}

const { syncWorkItemToPM } = proxyActivities<{
	syncWorkItemToPM: typeof SyncWorkItemToPMFn;
}>({
	startToCloseTimeout: "60 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
		nonRetryableErrorTypes: [
			"PmAuthError",
			"PmNotFoundError",
			"PmCapabilitiesError",
			"PmCreateError",
			"PmUpdateError",
			"PmStampError",
		],
	},
});

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
	} = input;

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
			});

			if (result.status === "SUCCESS") {
				return { status: "SUCCESS" };
			}
			if (result.status === "FAILED") {
				// `syncWorkItemToPM` has already stamped lastPmSyncStatus =
				// FAILED via `recordPmSyncFailure({ errorClass: "create_orphan" })`
				// before returning, so we DON'T re-stamp here (would clobber its
				// detailed message). Just propagate the outcome to the caller so
				// the procedure surfaces an honest FAILED toast instead of a
				// misleading CONFLICT toast.
				return {
					status: "FAILED",
					errorClass: "create_orphan",
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
			});
			return {
				status: "FAILED",
				errorClass,
				message: errorMessage,
			};
		}
	} finally {
		await clearPmSyncPendingIfLeaked({ itemId, itemType });
	}
}
