import { randomUUID } from "node:crypto";
import {
	db,
	isProjectReadOnly,
	PmSyncStatus,
	resolvePMConfigForUser,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { Client as TemporalClient } from "@temporalio/client";

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
		| "temporal-error"
		| "db-error";
	workflowId?: string;
}

// `user_story` is the only work-item table — the Epic/Feature folder tables
// were dropped. Legacy epic/feature item types are no-ops in the markers
// below (no row to stamp).

async function markPending(
	itemType: PmSyncItemType,
	itemId: string,
): Promise<void> {
	if (itemType !== "story" && itemType !== "bug") {
		return;
	}
	await db.userStory.update({
		where: { id: itemId },
		data: {
			lastPmSyncStatus: PmSyncStatus.PENDING,
			lastPmSyncAttemptAt: new Date(),
		},
	});
}

async function markFailed(
	itemType: PmSyncItemType,
	itemId: string,
	message: string,
): Promise<void> {
	if (itemType !== "story" && itemType !== "bug") {
		return;
	}
	await db.userStory.update({
		where: { id: itemId },
		data: {
			lastPmSyncStatus: PmSyncStatus.FAILED,
			lastPmSyncError:
				`Failed to enqueue PM sync (Temporal unreachable): ${message}`.slice(
					0,
					500,
				),
			lastPmSyncAttemptAt: new Date(),
		},
	});
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
 *   - Stamps `lastPmSyncStatus = PENDING` before starting the workflow.
 *   - Stamps `lastPmSyncStatus = FAILED` if the workflow start throws.
 *   - Silently skips when the project has no PM tool configured or the calling
 *     user lacks resolvable MCP credentials (mirrors `enqueuePmSync`).
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
		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId,
			organizationId: project.organizationId ?? undefined,
		});
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

		await markPending(itemType, itemId);

		try {
			const workflowId = `pm-sync-${itemType}-${itemId}-${randomUUID()}`;
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
				message,
			});
			try {
				await markFailed(itemType, itemId, message);
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
			return { enqueued: false, reason: "temporal-error" };
		}
	} catch (error) {
		logger.warn("enqueuePmSyncFromActivity: unexpected DB error", {
			itemId,
			itemType,
			message: error instanceof Error ? error.message : String(error),
		});
		return { enqueued: false, reason: "db-error" };
	}
}
