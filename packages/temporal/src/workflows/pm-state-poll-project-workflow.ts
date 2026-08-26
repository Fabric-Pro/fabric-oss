/**
 * PM State Poll — Project Child Workflow
 *
 * Polls PM tool work item states for a single project and reconciles
 * terminal state changes into PendingPmStateChange entries.
 */

import {
	log,
	patched,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";

import type {
	fetchAdoWorkItemStates as FetchAdoWorkItemStatesFn,
	reconcileAdoStates as ReconcileAdoStatesFn,
	reconcileMissingTickets as ReconcileMissingTicketsFn,
	updateProjectPollTimestamp as UpdateProjectPollTimestampFn,
} from "../activities/pm-integration/pm-state-poll";

// =============================================================================
// Types
// =============================================================================

export interface AdoStatePollProjectInput {
	projectId: string;
	mcpConfigId: string | null;
	mcpServerId?: string;
	sourceKind?: "mcp" | "rest-gitlab";
	pmTool?: string | null;
	containerId: string;
	containerName: string | null;
	lastAdoStatePollAt: Date | null;
	userId: string;
	organizationId?: string;
}

export interface AdoStatePollProjectOutput {
	projectId: string;
	success: boolean;
	itemsChecked?: number;
	pendingChangesCreated?: number;
	storiesAutoHidden?: number;
	error?: string;
}

// =============================================================================
// Activity Proxies
// =============================================================================

const { fetchAdoWorkItemStates } = proxyActivities<{
	fetchAdoWorkItemStates: typeof FetchAdoWorkItemStatesFn;
}>({
	startToCloseTimeout: "5 minutes",
	// Server-side liveness backstop (#1741). Root cause of the frozen poll was
	// NOT starvation but an oversized activity return: the fetch used to pack
	// title+description for every linked card, exceeding Temporal's 4 MB gRPC
	// limit so RespondActivityTaskCompleted was rejected and reconcile never
	// ran. That is fixed by the slim verdict (title/description no longer cross
	// the boundary). heartbeatTimeout is kept as a general backstop: the
	// activity heartbeats every 10s during each MCP call AND is throttled
	// through the post-fetch content-drift loop (every 20 items), so 60s
	// cannot false-positive on a healthy-but-slow poll or a large drift backlog.
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "5s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { reconcileAdoStates } = proxyActivities<{
	reconcileAdoStates: typeof ReconcileAdoStatesFn;
}>({
	// 3m (was 1m): the first successful poll after the payload-size freeze
	// applies the whole backed-up terminal backlog in one call (#1741 DEC-5).
	startToCloseTimeout: "3 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { reconcileMissingTickets } = proxyActivities<{
	reconcileMissingTickets: typeof ReconcileMissingTicketsFn;
}>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { updateProjectPollTimestamp } = proxyActivities<{
	updateProjectPollTimestamp: typeof UpdateProjectPollTimestampFn;
}>({
	startToCloseTimeout: "10 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// =============================================================================
// Workflow
// =============================================================================

export async function adoStatePollProjectWorkflow(
	input: AdoStatePollProjectInput,
): Promise<AdoStatePollProjectOutput> {
	const { projectId } = input;

	try {
		log.info("Starting ADO state poll for project", { projectId });

		const fetched = await fetchAdoWorkItemStates({
			projectId: input.projectId,
			mcpConfigId: input.mcpConfigId,
			mcpServerId: input.mcpServerId,
			sourceKind: input.sourceKind,
			pmTool: input.pmTool,
			containerId: input.containerId,
			containerName: input.containerName,
			lastAdoStatePollAt: input.lastAdoStatePollAt,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		const reconcileResult = await reconcileAdoStates({
			projectId,
			items: fetched.items,
			pmTool: input.pmTool,
			terminalStatusesHash: fetched.terminalStatusesHash,
		});
		const { pendingChangesCreated, storiesAutoHidden } = reconcileResult;
		// Version-skew safety (Codex round-1): a pre-#1741 reconcile result recorded
		// without settingsStable (old code applied ungated → effectively stable) must
		// default to true, or resuming/replaying it under new code would freeze the
		// watermark on a complete poll for no settings reason.
		const settingsStable = reconcileResult.settingsStable ?? true;

		// FLAG_MISSING producer (#1360). Source-scoped to the active server, so
		// it needs mcpServerId; poll projects always have one (getAdoActiveProjects
		// requires projectManagementMcpServerId not-null), but guard for the type.
		// This child workflow is a FRESH execution per scheduled tick (the parent
		// `adoStatePollWorkflow` fans out `executeChild(... uuid4())` hourly), so
		// `workflowInfo().runId` is unique per poll cycle — the correct
		// idempotency token for the missing-streak (review Fix C). Only DEFINITE
		// not-found ids feed detection (review Fix A).
		// Gate the FLAG_MISSING producer (#1360) behind a Temporal patch so
		// pre-existing histories — recorded before this activity existed — replay
		// deterministically (they skip it); only new executions run it. Call
		// patched() unconditionally so the marker is recorded the same way every
		// run, independent of mcpServerId.
		const flagMissingEnabled = patched("pm-flag-missing-producer-v1");
		let missingFlags = 0;
		if (flagMissingEnabled && input.mcpServerId) {
			missingFlags = await reconcileMissingTickets({
				projectId,
				activeServerId: input.mcpServerId,
				pollRunId: workflowInfo().runId,
				seenExternalIds: fetched.seenExternalIds,
				notFoundIds: fetched.notFoundIds,
				totalLinked: fetched.totalLinked,
			});
		}

		// #1741 DEC-6: advance the changed-date watermark only when the fetch fully
		// observed the board AND settings/story-state were stable across
		// fetch→reconcile. A mid-run change (settingsStable:false) holds the
		// watermark so the next poll re-classifies every card cleanly.
		await updateProjectPollTimestamp(
			projectId,
			fetched.complete && settingsStable,
		);

		log.info("ADO state poll completed for project", {
			projectId,
			itemsChecked: fetched.items.length,
			pendingChangesCreated: pendingChangesCreated + missingFlags,
			storiesAutoHidden,
		});

		return {
			projectId,
			success: true,
			itemsChecked: fetched.items.length,
			pendingChangesCreated: pendingChangesCreated + missingFlags,
			storiesAutoHidden,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		log.error("ADO state poll failed for project", {
			projectId,
			error: errorMessage,
		});

		return {
			projectId,
			success: false,
			error: errorMessage,
		};
	}
}
