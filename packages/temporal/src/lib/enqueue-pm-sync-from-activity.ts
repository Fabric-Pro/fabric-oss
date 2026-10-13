import { db, isProjectReadOnly } from "@repo/database";
import {
	GitLabPmOriginMismatchError,
	resolveProjectPMConfigForUser,
} from "@repo/integrations/gitlab";
import { logger } from "@repo/logs";
import {
	rethrowIfDispatchStopped,
	throwIfDispatchStopped,
} from "@repo/utils/dispatch-guard";
import type { Client as TemporalClient } from "@temporalio/client";
import {
	compensatePmSyncStart,
	newPmSyncPendingStamp,
	PM_SYNC_START_POLICIES,
	pmSyncWorkflowId,
	settleFailedPmSyncStart,
} from "./pm-sync-start";

export type PmSyncItemType = "epic" | "feature" | "story" | "bug";

export interface EnqueuePmSyncFromActivityInput {
	itemId: string;
	itemType: PmSyncItemType;
	projectId: string;
	userId: string;
	organizationId?: string | null;
	temporalClient: TemporalClient;
	triggerSource: "auto-push" | "agent-create";
}

export interface EnqueuePmSyncFromActivityResult {
	enqueued: boolean;
	reason?:
		| "no-external-id"
		| "no-pm-config"
		| "item-not-found"
		| "project-not-found"
		| "read-only-mode"
		/** No running workflow under the id; the attempt was marked FAILED. */
		| "temporal-error"
		/**
		 * The start threw but may have gone through, and Temporal could not
		 * say: the item is left PENDING for the stuck-sync watchdog.
		 */
		| "start-uncertain"
		| "db-error";
	workflowId?: string;
}

// `user_story` is the only work-item table — the Epic/Feature folder tables
// were dropped. Legacy epic/feature item types are no-ops in the markers
// below (no row to stamp).

/**
 * Stamps the item PENDING: the first write of a PM sync. Inside an Advisor
 * chat turn the turn's stop is checked synchronously immediately before it,
 * so a stopped turn never begins the sync. Once this stamp is written the
 * workflow start is part of the same operation and is not checked again
 * (see `enqueuePmSyncFromActivity`). Returns the attempt id the stamp wrote,
 * which scopes a failed start's FAILED write to this attempt.
 */
async function markPending(
	itemType: PmSyncItemType,
	itemId: string,
): Promise<string | null> {
	if (itemType !== "story" && itemType !== "bug") {
		return null;
	}
	const stamp = newPmSyncPendingStamp();
	// No await between this check and the write. A no-op outside a turn.
	throwIfDispatchStopped();
	await db.userStory.update({
		where: { id: itemId },
		data: stamp.data,
	});
	return stamp.attemptId;
}

/**
 * Activity-side counterpart of `@repo/api`'s `enqueuePmSync`. Use this from
 * Temporal activities (e.g. the `fabric_create_story` built-in tool) that need
 * to kick off an initial PM-sync workflow for a row they just created.
 *
 * Differences vs. `@repo/api/enqueuePmSync`:
 *   - The caller passes the already-resolved Temporal client (activities have
 *     one in their dependencies; new clients here would leak handles).
 *   - No `withCorrelationMemo` wrapper — Temporal already establishes a
 *     parent/child correlation when one workflow starts another from an
 *     activity-side `client.workflow.start`.
 *   - `forceInitialPush` is implicit (the only useful mode here is "the row
 *     was just created and has no externalId yet").
 *
 * Same external behavior:
 *   - Returns `{ enqueued, reason?, workflowId? }`.
 *   - Stamps `lastPmSyncStatus = PENDING` (with a fresh attempt id) before
 *     starting the workflow, under the same per-item workflow id and
 *     policies (`pmSyncWorkflowId`, `PM_SYNC_START_POLICIES`).
 *   - Settles a start that throws with `settleFailedPmSyncStart`: it
 *     describes the workflow id; FAILED for this attempt only when Temporal
 *     has no running workflow under it, PENDING while one is running or
 *     Temporal cannot say.
 *   - Silently skips when the project has no PM tool configured or the calling
 *     user lacks resolvable MCP credentials (mirrors `enqueuePmSync`).
 *
 * Inside an Advisor chat turn (the ambient dispatch guard), the turn's stop
 * is checked immediately before the PENDING stamp, after every await that
 * precedes it; a stop found there is thrown, never returned as a `reason`,
 * and nothing is written or started. The stamp and the workflow start are
 * one operation: once the stamp is written the start is issued even if the
 * turn stops meanwhile — nothing after `markPending` checks the stop
 * (`__tests__/turn-stop-write-adjacency.test.ts`) — so a stop cannot leave
 * a PENDING stamp with no start behind it. A failed start is handled as it
 * is outside a turn.
 */
export async function enqueuePmSyncFromActivity(
	input: EnqueuePmSyncFromActivityInput,
): Promise<EnqueuePmSyncFromActivityResult> {
	const {
		itemId,
		itemType,
		projectId,
		userId,
		organizationId,
		temporalClient,
		triggerSource,
	} = input;

	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementContainerName: true,
				projectManagementAdditionalContext: true,
			},
		});

		if (!project) {
			return { enqueued: false, reason: "project-not-found" };
		}
		// Read-only mode: skip the outbound push silently before
		// stamping PENDING. Checked via the raw-SQL helper (not a typed select)
		// so a worker image with a stale Prisma client can't crash on the
		// newer column.
		if (await isProjectReadOnly(projectId)) {
			return { enqueued: false, reason: "read-only-mode" };
		}
		if (
			!project.projectManagementMcpConfigId ||
			!project.projectManagementContainerId
		) {
			return { enqueued: false, reason: "no-pm-config" };
		}

		// Resolve to the calling user's MCP config of the matching server type —
		// same rationale as `@repo/api/enqueuePmSync`: the pinned config belongs
		// to whoever last configured the integration; using it for a different
		// user breaks tenant filtering inside `getMcpConfigById`.
		// A personal GitLab config on another instance than the container is
		// no config for this project: nothing is enqueued for it.
		let userMcpConfig: Awaited<
			ReturnType<typeof resolveProjectPMConfigForUser>
		>;
		try {
			userMcpConfig = await resolveProjectPMConfigForUser({
				configId: project.projectManagementMcpConfigId,
				mcpServerId: project.projectManagementMcpServerId,
				userId,
				organizationId: project.organizationId ?? undefined,
				pmAdditionalContext: project.projectManagementAdditionalContext,
			});
		} catch (error) {
			if (!(error instanceof GitLabPmOriginMismatchError)) {
				throw error;
			}
			logger.info(
				"enqueuePmSyncFromActivity: the user's GitLab is on another instance than the project's PM container",
				{ itemId, itemType, userId },
			);
			return { enqueued: false, reason: "no-pm-config" };
		}
		if (!userMcpConfig || !userMcpConfig.enabled) {
			logger.info(
				"enqueuePmSyncFromActivity: no resolvable MCP config for user",
				{
					itemId,
					itemType,
					userId,
					pinnedConfigId: project.projectManagementMcpConfigId,
					pinnedServerId: project.projectManagementMcpServerId,
				},
			);
			return { enqueued: false, reason: "no-pm-config" };
		}

		const attemptId = await markPending(itemType, itemId);

		// The same per-item id and policies as `@repo/api`'s enqueue, so a
		// concurrent enqueue attaches to a running sync instead of racing it
		// down the CREATE path, and the reconcile step below and the
		// stuck-sync watchdog can describe this attempt's workflow.
		const workflowId = pmSyncWorkflowId(itemType, itemId);
		try {
			const additionalContext =
				(project.projectManagementAdditionalContext as Record<
					string,
					string
				> | null) ?? undefined;

			const handle = await temporalClient.workflow.start(
				"pmSyncSingleStoryWorkflow",
				{
					taskQueue: "ai-chat",
					workflowId,
					...PM_SYNC_START_POLICIES,
					args: [
						{
							itemId,
							itemType,
							projectId,
							mcpConfigId: userMcpConfig.id,
							containerId: project.projectManagementContainerId,
							containerName:
								project.projectManagementContainerName ??
								undefined,
							additionalContext,
							userId,
							organizationId:
								organizationId ??
								project.organizationId ??
								undefined,
							pushAnyway: false,
							triggerSource,
							// Scopes the run's status writes to this attempt.
							pmSyncAttemptId: attemptId ?? undefined,
						},
					],
				},
			);
			return { enqueued: true, workflowId: handle.workflowId };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			logger.warn("enqueuePmSyncFromActivity: temporal start failed", {
				itemId,
				itemType,
				workflowId,
				message,
			});
			const settlement = await settleFailedPmSyncStart({
				client: temporalClient,
				workflowId,
				compensate: async () => {
					if (attemptId === null) {
						return;
					}
					try {
						await compensatePmSyncStart({
							table: "userStory",
							itemId,
							attemptId,
							message,
						});
					} catch (rollbackError) {
						logger.warn(
							"enqueuePmSyncFromActivity: rollback to FAILED also failed",
							{
								itemId,
								itemType,
								message:
									rollbackError instanceof Error
										? rollbackError.message
										: String(rollbackError),
							},
						);
					}
				},
			});
			if (settlement === "running") {
				return { enqueued: true, workflowId };
			}
			if (settlement === "uncertain") {
				logger.warn(
					"enqueuePmSyncFromActivity: start outcome unknown — left PENDING for the stuck-sync watchdog",
					{ itemId, itemType, workflowId },
				);
				return {
					enqueued: false,
					reason: "start-uncertain",
					workflowId,
				};
			}
			return { enqueued: false, reason: "temporal-error" };
		}
	} catch (error) {
		// A chat turn's stop (from the check before the PENDING stamp, or
		// a read it aborted) is not a database error: rethrown, so the
		// caller never treats the item as handled. A no-op outside a turn.
		rethrowIfDispatchStopped(error);
		logger.warn("enqueuePmSyncFromActivity: unexpected DB error", {
			itemId,
			itemType,
			message: error instanceof Error ? error.message : String(error),
		});
		return { enqueued: false, reason: "db-error" };
	}
}
