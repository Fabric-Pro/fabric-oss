import { db, markPmSyncFailedUnlessPending } from "@repo/database";
import {
	GitLabPmOriginMismatchError,
	resolveProjectPMConfigForUser,
} from "@repo/integrations/gitlab";
import { logger } from "@repo/logs";
import type { Client as TemporalClient } from "@temporalio/client";
import {
	compensatePmSyncStart,
	newPmSyncPendingStamp,
	PM_SYNC_START_POLICIES,
	pmSyncWorkflowId,
	settleFailedPmSyncStart,
} from "./pm-sync-start";

/**
 * Work-item type for PM sync. Stories and bugs share the `userStory` table —
 * the only work-item table since the Epic/Feature folder tables were dropped.
 * `epic`/`feature` remain in the union for caller compatibility (stored
 * payloads, older clients); they resolve to `item-not-found` here.
 */
export type PmSyncItemType = "epic" | "feature" | "story" | "bug";

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
		/**
		 * The client could not be acquired, or Temporal has no running
		 * workflow under the id; the attempt was marked FAILED.
		 */
		| "temporal-error"
		/**
		 * The start threw but may have gone through, and Temporal could not
		 * say: the item is left PENDING for the stuck-sync watchdog.
		 */
		| "start-uncertain"
		/**
		 * Watchdog retry only: the row was no longer PENDING for the attempt
		 * the watchdog observed (a run settled it or a newer enqueue stamped
		 * it), so nothing was stamped or started.
		 */
		| "superseded"
		| "db-error";
	workflowId?: string;
}

export interface EnqueuePmSyncCoreInput extends EnqueuePmSyncInput {
	/** Acquires the Temporal client; a throw here is a definite non-start. */
	getTemporalClient: () => Promise<Pick<TemporalClient, "workflow">>;
	/** Decorates the start options (the API adds the request's correlation memo). */
	decorateStartOptions?: <T extends object>(options: T) => T;
	/**
	 * Set by the stuck-sync watchdog. The PENDING stamp is written only while
	 * the row is still PENDING for `expectedAttemptId` (null matches a row
	 * stamped before attempt ids existed), and it keeps `pendingSince` rather
	 * than restarting the give-up bound.
	 */
	watchdogRetry?: { expectedAttemptId: string | null; pendingSince: Date };
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

/**
 * Stamp PENDING for a new attempt and return its attempt id, or `null` when
 * a watchdog retry found the row no longer PENDING for the attempt it saw.
 */
async function markPending(
	itemId: string,
	watchdogRetry: EnqueuePmSyncCoreInput["watchdogRetry"],
): Promise<string | null> {
	const stamp = newPmSyncPendingStamp(watchdogRetry?.pendingSince);
	if (!watchdogRetry) {
		await db.userStory.update({ where: { id: itemId }, data: stamp.data });
		return stamp.attemptId;
	}
	// Check-then-act in one statement, immediately before the start: a run
	// that settled the row, or a user's newer enqueue, since the watchdog
	// scanned it is not re-armed.
	const { count } = await db.userStory.updateMany({
		where: {
			id: itemId,
			lastPmSyncStatus: stamp.data.lastPmSyncStatus,
			lastPmSyncAttemptId: watchdogRetry.expectedAttemptId,
		},
		data: stamp.data,
	});
	return count === 1 ? stamp.attemptId : null;
}

/**
 * Pre-start failure on the "no MCP config" branches below: this caller has
 * no attempt of its own, so the FAILED is written only when the row is not
 * PENDING. A PENDING row belongs to another enqueue (for example a teammate
 * whose own config resolved) whose sync is in flight, and the caller already
 * hears about the failure through the returned reason.
 */
async function markNoConfigFailed(
	itemId: string,
	message: string,
): Promise<void> {
	await markPmSyncFailedUnlessPending({
		itemId,
		error: `Failed to enqueue PM sync (Temporal unreachable): ${message}`.slice(
			0,
			500,
		),
	});
}

/**
 * Mark the story-family item PENDING and start `pmSyncSingleStoryWorkflow`
 * fire-and-forget. Skips silently when the item has no `externalId` (unless
 * `forceInitialPush` is set) or the project has no PM integration configured.
 * Callers must NOT await activity completion.
 *
 * Lives in `@repo/temporal` so both the API (`@repo/api`'s `enqueuePmSync`,
 * which passes its client and correlation memo) and the stuck-sync watchdog
 * activity enqueue through the same MCP-config resolution.
 *
 * A start that throws is settled by `settleFailedPmSyncStart`: FAILED when
 * the client could not be acquired or Temporal has no running workflow under
 * the id, PENDING while it is running (`enqueued: true`) or Temporal cannot
 * say (`start-uncertain`).
 *
 * Workflow name `pmSyncSingleStoryWorkflow` is retained for compat — its
 * input now generalizes to any hierarchy item type via `itemType`.
 */
export async function enqueuePmSyncCore(
	input: EnqueuePmSyncCoreInput,
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
		watchdogRetry,
	} = input;
	const decorate =
		input.decorateStartOptions ??
		(<T extends object>(options: T) => options);
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
			let userMcpConfig: Awaited<
				ReturnType<typeof resolveProjectPMConfigForUser>
			>;
			try {
				userMcpConfig = await resolveProjectPMConfigForUser({
					configId: project.projectManagementMcpConfigId,
					mcpServerId: project.projectManagementMcpServerId,
					userId,
					organizationId: project.organizationId ?? undefined,
					pmAdditionalContext:
						project.projectManagementAdditionalContext,
				});
			} catch (error) {
				if (!(error instanceof GitLabPmOriginMismatchError)) {
					throw error;
				}
				// The user's own GitLab MCP config is on another instance than
				// the container; their connection is on that instance too, so
				// the REST fallback cannot serve it either. Say so on the row.
				await markNoConfigFailed(itemId, error.message);
				return { enqueued: false, reason: "no-pm-config" };
			}
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
				await markNoConfigFailed(
					itemId,
					"PM tool was configured by another user. Open Settings → MCP Servers and connect your own credentials, then retry the sync.",
				);
				return { enqueued: false, reason: "no-pm-config" };
			}
		}

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
		const workflowId = pmSyncWorkflowId(effectiveItemType, itemId);

		const attemptId = await markPending(itemId, watchdogRetry);
		if (attemptId === null) {
			return { enqueued: false, reason: "superseded" };
		}

		let client: Pick<TemporalClient, "workflow"> | null = null;
		try {
			client = await input.getTemporalClient();
			const additionalContext =
				(project.projectManagementAdditionalContext as Record<
					string,
					string
				> | null) ?? undefined;

			const handle = await client.workflow.start(
				"pmSyncSingleStoryWorkflow",
				decorate({
					taskQueue: "ai-chat",
					workflowId,
					...PM_SYNC_START_POLICIES,
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
							// Scopes the run's status writes to this attempt.
							pmSyncAttemptId: attemptId,
						},
					],
				}),
			);
			return { enqueued: true, workflowId: handle.workflowId };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			logger.warn("enqueuePmSync temporal start failed", {
				itemId,
				itemType,
				workflowId,
				message,
			});
			const settlement = await settleFailedPmSyncStart({
				client,
				workflowId,
				compensate: async () => {
					try {
						await compensatePmSyncStart({
							table: "userStory",
							itemId,
							attemptId,
							message,
						});
					} catch (rollbackError) {
						logger.warn(
							"enqueuePmSync rollback to FAILED also failed",
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
				// The start went through (or attached to a running sync, as
				// USE_EXISTING does on success): the row stays PENDING and
				// that run settles it.
				return { enqueued: true, workflowId };
			}
			if (settlement === "uncertain") {
				logger.warn(
					"enqueuePmSync start outcome unknown — left PENDING for the stuck-sync watchdog",
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
		logger.warn("enqueuePmSync unexpected DB error", {
			itemId,
			itemType,
			message: error instanceof Error ? error.message : String(error),
		});
		return { enqueued: false, reason: "db-error" };
	}
}
