import { db, PmSyncStatus, resolvePMConfigForUser } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

/**
 * Work-item type for PM sync. Stories and bugs share the `userStory` table —
 * the only work-item table since the Epic/Feature folder tables were dropped.
 * `epic`/`feature` remain in the union for caller compatibility (stored
 * payloads, older clients); they resolve to `item-not-found` here.
 */
type PmSyncItemType = "epic" | "feature" | "story" | "bug";

export interface EnqueuePmSyncInput {
	itemId: string;
	itemType: PmSyncItemType;
	projectId: string;
	userId: string;
	pushAnyway?: boolean;
	/**
	 * When true, skip the PM-side hash-drift conflict check and push the
	 * Fabric version unconditionally. Used by the `resolveConflict` procedure
	 * (LOCAL resolution path). Alias for `pushAnyway` — forwarded to the
	 * Temporal workflow as `pushAnyway: true`.
	 */
	forceHashOverride?: boolean;
	/**
	 * When true, bypass the `no-external-id` short-circuit so the workflow's
	 * create-then-link branch performs the initial push for stories the user
	 * has just opted into auto-sync. The `no-pm-config` short-circuit still
	 * applies — without a configured PM tool there is nowhere to push to.
	 * Defaults to false (the existing manual-edit / retry behavior).
	 */
	forceInitialPush?: boolean;
	triggerSource: "manual-edit" | "retry" | "auto-push";
}

export interface EnqueuePmSyncResult {
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

async function findItemForEnqueue(
	itemType: PmSyncItemType,
	itemId: string,
	projectId: string,
): Promise<{
	id: string;
	externalId: string | null;
	kind?: string | null;
} | null> {
	// Stories are the only work-item rows; legacy epic/feature item types
	// resolve to "not found" (the folder tables were dropped).
	if (itemType !== "story" && itemType !== "bug") {
		return null;
	}
	// `kind` is the source of truth for whether a UserStory is a bug.
	// Most callers hardcode `itemType: "story"` regardless of kind, so
	// we read it here and normalize below — otherwise a bug would push
	// to ADO as "User Story" (the `ITEM_TYPE_TO_ADO_TYPE` mapping keys
	// off the workflow's `itemType`).
	return db.userStory.findFirst({
		where: { id: itemId, projectId },
		select: { id: true, externalId: true, kind: true },
	});
}

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
 * Mark the hierarchy item PENDING and start `pmSyncSingleStoryWorkflow`
 * fire-and-forget. Skips silently when the item has no `externalId` (unless
 * `forceInitialPush` is set) or the project has no PM integration configured.
 * Procedure callers must NOT await activity completion.
 *
 * Workflow name `pmSyncSingleStoryWorkflow` is retained for compat — its
 * input now generalizes to any hierarchy item type via `itemType`.
 */
export async function enqueuePmSync(
	input: EnqueuePmSyncInput,
): Promise<EnqueuePmSyncResult> {
	const {
		itemId,
		itemType,
		projectId,
		userId,
		pushAnyway: pushAnywayInput = false,
		forceHashOverride = false,
		triggerSource,
		forceInitialPush = false,
	} = input;
	// forceHashOverride is an alias for pushAnyway — merge them so callers
	// can use either name and both are honoured.
	const pushAnyway = pushAnywayInput || forceHashOverride;

	try {
		const item = await findItemForEnqueue(itemType, itemId, projectId);

		if (!item) {
			return { enqueued: false, reason: "item-not-found" };
		}

		// Promote `story → bug` from the persisted `kind`. Most callers that
		// edit a UserStory enqueue with a hardcoded `itemType: "story"`
		// regardless of kind; without this a bug (kind === "BUG") would push to
		// ADO as "User Story" (the `ITEM_TYPE_TO_ADO_TYPE` mapping keys off the
		// workflow's `itemType`). We only promote — an explicit `itemType: "bug"`
		// from a caller is always trusted, and epic/feature (no kind) pass
		// through untouched.
		const effectiveItemType: PmSyncItemType =
			itemType === "story" && item.kind === "BUG" ? "bug" : itemType;

		// Skip the `no-external-id` short-circuit when the caller has armed
		// the initial push. The downstream pmSyncSingleStoryWorkflow's
		// create-then-link branch (hierarchy-sync.ts) creates the PM-side
		// work item, links it back via updateWorkItemExternalRefs, and
		// stamps the externalId — so an unlinked story is the expected
		// shape here, not an error.
		if (!item.externalId && !forceInitialPush) {
			return { enqueued: false, reason: "no-external-id" };
		}

		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				id: true,
				organizationId: true,
				readOnlyMode: true,
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
		// Read-only mode: skip the outbound push silently —
		// BEFORE stamping PENDING, so the row's sync status is untouched.
		// Background callers treat this like the other benign skips; direct
		// user actions pre-check the flag and surface a toast instead.
		if (project.readOnlyMode) {
			return { enqueued: false, reason: "read-only-mode" };
		}
		if (!project.projectManagementContainerId) {
			return { enqueued: false, reason: "no-pm-config" };
		}

		// Resolution order:
		//   1. If the project has a pinned MCPConfig, try to resolve a config
		//      the CALLING USER actually owns of the same server type. The
		//      pinned config belongs to whoever set the integration up — handing
		//      it straight to Temporal makes the workflow fail with "PM tool
		//      does not have required capabilities" for every other user
		//      because `getMcpConfigById` is tenant-filtered.
		//   2. If no user-specific config resolves AND the project's PM tool is
		//      GitLab (`key:gitlab-official`), fall back to the REST routine —
		//      it uses the project's stored creds, not per-user MCP, so it works
		//      even when the calling user has never configured GitLab. This is
		//      the GitLab-only auto-recovery path (story/bug only — REST has no
		//      schema-Epic/Feature routine).
		//   3. Otherwise, stamp the row FAILED with an actionable message so
		//      the UI badge stops lying about a sync that never happens.
		const restPathSupportsItemType =
			itemType === "story" || itemType === "bug";
		const isGitLabProject =
			project.projectManagementMcpServerId === "key:gitlab-official";

		let mcpConfigIdForWorkflow: string | null;
		if (!project.projectManagementMcpConfigId) {
			// Project never had a per-user MCP wired — original GitLab REST
			// fallback path. Anything else here = unconfigured PM tool.
			if (isGitLabProject && restPathSupportsItemType) {
				mcpConfigIdForWorkflow = null;
			} else {
				return { enqueued: false, reason: "no-pm-config" };
			}
		} else {
			const userMcpConfig = await resolvePMConfigForUser({
				configId: project.projectManagementMcpConfigId,
				mcpServerId: project.projectManagementMcpServerId,
				userId,
				organizationId: project.organizationId ?? undefined,
			});
			if (userMcpConfig?.enabled) {
				mcpConfigIdForWorkflow = userMcpConfig.id;
			} else if (isGitLabProject && restPathSupportsItemType) {
				// User has no resolvable GitLab MCP, but the project does have
				// GitLab configured — route through REST so the approval still
				// reaches GitLab without forcing every approver to set up their
				// own GitLab MCP first.
				logger.info(
					"enqueuePmSync GitLab REST fallback for user without own MCP config",
					{
						itemId,
						itemType,
						userId,
						pinnedConfigId: project.projectManagementMcpConfigId,
						pinnedServerId: project.projectManagementMcpServerId,
					},
				);
				mcpConfigIdForWorkflow = null;
			} else {
				// Cross-PM visibility fix — every non-GitLab tool used to fall
				// through here and `return` silently, leaving the row with
				// `pmAutoSyncEnabled = true / externalId = null` forever. Mark
				// it FAILED with an actionable message instead.
				logger.warn(
					"enqueuePmSync no resolvable MCP config for user — marking FAILED",
					{
						itemId,
						itemType,
						userId,
						pinnedConfigId: project.projectManagementMcpConfigId,
						pinnedServerId: project.projectManagementMcpServerId,
						hasConfig: !!userMcpConfig,
						enabled: userMcpConfig?.enabled,
					},
				);
				await markFailed(
					itemType,
					itemId,
					"PM tool was configured by another user. Open Settings → MCP Servers and connect your own credentials, then retry the sync.",
				);
				return { enqueued: false, reason: "no-pm-config" };
			}
		}

		await markPending(itemType, itemId);

		try {
			const client = await getTemporalClient();
			// Stable per-item workflowId so two near-simultaneous enqueues for
			// the same item de-duplicate instead of running in parallel and both
			// taking the CREATE path (which produced duplicate PM tickets). A
			// random-UUID id guarantees uniqueness but also defeats Temporal's
			// built-in conflict handling, which is exactly what lets the race
			// happen. With a stable id:
			//   - workflowIdConflictPolicy USE_EXISTING — a concurrent enqueue
			//     while a sync is already running attaches to that run instead of
			//     starting a duplicate (no parallel double-create).
			//   - workflowIdReusePolicy ALLOW_DUPLICATE — once a run completes, a
			//     later enqueue starts a fresh sync as normal.
			const workflowId = `pm-sync-${effectiveItemType}-${itemId}`;
			const additionalContext =
				(project.projectManagementAdditionalContext as Record<
					string,
					string
				> | null) ?? undefined;

			const handle = await client.workflow.start(
				"pmSyncSingleStoryWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					workflowIdReusePolicy: "ALLOW_DUPLICATE",
					workflowIdConflictPolicy: "USE_EXISTING",
					args: [
						{
							itemId,
							itemType: effectiveItemType,
							projectId,
							mcpConfigId: mcpConfigIdForWorkflow,
							// REST path needs the server id to resolve the source;
							// pass it for the MCP path too (harmless, lets the
							// activity emit better telemetry).
							mcpServerId:
								project.projectManagementMcpServerId ??
								undefined,
							containerId: project.projectManagementContainerId,
							containerName:
								project.projectManagementContainerName ??
								undefined,
							additionalContext,
							userId,
							organizationId: project.organizationId ?? undefined,
							pushAnyway,
							triggerSource,
						},
					],
				}),
			);
			return { enqueued: true, workflowId: handle.workflowId };
		} catch (error) {
			// PENDING is already on the row but the workflow never started;
			// the workflow's finally guard cannot clear it. Stamp FAILED so
			// the existing retry surface picks it up.
			const message =
				error instanceof Error ? error.message : String(error);
			logger.warn("enqueuePmSync temporal start failed", {
				itemId,
				itemType,
				message,
			});
			try {
				await markFailed(itemType, itemId, message);
			} catch (rollbackError) {
				logger.warn("enqueuePmSync rollback to FAILED also failed", {
					itemId,
					itemType,
					message:
						rollbackError instanceof Error
							? rollbackError.message
							: String(rollbackError),
				});
			}
			return { enqueued: false, reason: "temporal-error" };
		}
	} catch (error) {
		logger.warn("enqueuePmSync unexpected DB error", {
			itemId,
			itemType,
			message: error instanceof Error ? error.message : String(error),
		});
		return { enqueued: false, reason: "db-error" };
	}
}
