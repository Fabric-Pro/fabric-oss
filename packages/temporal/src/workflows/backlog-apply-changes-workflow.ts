/**
 * Backlog Apply Changes Workflow
 *
 * Applies approved backlog changes to Fabric DB and optionally syncs to PM tool.
 * Changes are applied in hierarchy order: epics → features → stories.
 *
 * Follows the same patterns as story-sync-workflow:
 * - Signal-based cancellation
 * - Query-based progress tracking
 */

import {
	ApplicationFailure,
	CancellationScope,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";

import type {
	applyBacklogChanges as ApplyBacklogChangesFn,
	ChangeProposal,
} from "../activities/backlog-context/analyze-context";
import type { syncWorkItemToPM as SyncWorkItemToPMFn } from "../activities/pm-integration/hierarchy-sync";
import type {
	clearPmSyncPendingIfLeaked as ClearPmSyncPendingIfLeakedFn,
	recordPmSyncFailure as RecordPmSyncFailureFn,
} from "../activities/pm-integration/record-pm-sync-state";
import type { resolveApplyPmConfig as ResolveApplyPmConfigFn } from "../activities/pm-integration/resolve-apply-pm-config";
import type { discoverPMToolCapabilities as DiscoverPMToolCapabilitiesFn } from "../activities/pm-integration/story-sync";
// See sister workflow `backlog-context-analysis-workflow.ts`
// for the Step 6 proxy rationale (timeout posture is mandatory).
import type * as postOperationResultModule from "../activities/post-operation-result";
import type { finalizePendingProposalActivity as FinalizePendingProposalFn } from "../activities/teams-channel-monitor/fetch-channel-cursor";
import {
	computeAppliedProposalIndexes,
	isPmTicketMissingError,
} from "./backlog-apply-outcome";
import { BACKLOG_APPLY_CANCELLED_TYPE } from "./backlog-constants";
import { unwrapPmSyncError } from "./pm-sync-error-unwrap";
import { shouldSkipFlatPmSync } from "./pm-sync-item-gate";
import { computePmSyncOutage, type PmSyncOutage } from "./pm-sync-outage";

// =============================================================================
// Types
// =============================================================================

export interface BacklogApplyChangesInput {
	projectId: string;
	userId: string;
	/** Authenticated human who approved these changes. Optional for replaying
	 * histories created before semantic edit attribution was introduced. */
	approvedByName?: string | null;
	organizationId?: string;
	approvedChanges: ChangeProposal["changes"];
	syncToPM: boolean;
	pmConfig?: {
		mcpConfigId: string;
		containerId: string;
		containerName?: string;
		additionalContext?: Record<string, string>;
	};
	/**
	 * Optional: when set, the workflow flips the matching PendingBacklogProposal
	 * to APPLIED on success or FAILED on error so the approval inbox reaches a
	 * terminal state without relying on client-side polling.
	 */
	pendingProposalId?: string;
	/**
	 * Indexes of `proposal.changes[]` corresponding to each item in
	 * `approvedChanges`. Recorded against `appliedChangeIndexes` on success so
	 * retries of FAILED proposals skip already-applied updates.
	 */
	approvedChangeIndexes?: number[];
	/**
	 * Per-change PM-sync overrides keyed by index in `approvedChanges`.
	 * Set by the AI Update review step when the user resolves a conflict
	 * with "Push anyway" (force the push) or "Skip this one" (omit from PM
	 * sync entirely while still applying the Fabric write).
	 */
	pmSyncOverrides?: Record<number, { pushAnyway?: boolean; skip?: boolean }>;
	/**
	 * Optional `AgentConversation` ID. Same shape and
	 * intent as `BacklogContextAnalysisInput.conversationId`. When set,
	 * the workflow appends a persistent operation-result message at
	 * completion. Absent ⇒ Step 6 short-circuits.
	 */
	conversationId?: string;
	/**
	 * Bug 1429 — channel-monitor epic-suppression. Forwarded verbatim to the
	 * `applyBacklogChanges` activity. The Teams/Slack channel-monitor approve
	 * procedures set `true` so any `epic`-typed change (e.g. an already-stored
	 * pre-fix proposal) is normalized to a feature on apply. Defaults to
	 * unset/false for the general AI Update + ADO flows, which keep creating
	 * epics unchanged.
	 */
	forbidEpics?: boolean;
}

export interface BacklogApplyProgress {
	status: "applying" | "syncing_pm" | "completed" | "cancelled" | "failed";
	completedCount: number;
	totalCount: number;
	currentItem?: string;
	message: string;
	createdItems?: AppliedItemInfo[];
	updatedItems?: AppliedItemInfo[];
	/**
	 * Creates skipped by the exact-title dedup guard — surfaced per-item in the
	 * approve UI's result summary so the reviewer sees "skipped: already exists
	 * as F-123" instead of the item silently vanishing.
	 */
	skippedItems?: SkippedItemInfo[];
	/** Per-item Fabric-apply (create/update) failures, with a reason. */
	failedItems?: FailedItemInfo[];
	errors: string[];
}

export interface AppliedItemInfo {
	type: "epic" | "feature" | "story" | "bug";
	id: string;
	identifier: string;
	title: string;
}

export interface SkippedItemInfo {
	type: "epic" | "feature" | "story" | "bug";
	/** The proposed (new) title that collided with an existing item. */
	title: string;
	/** Identifier of the existing item the proposed create collided with. */
	identifier: string;
	reason: string;
}

export interface FailedItemInfo {
	type: "epic" | "feature" | "story" | "bug";
	title: string;
	reason: string;
}

export interface PmSyncItemResult {
	storyId: string;
	itemType: "epic" | "feature" | "story" | "bug";
	status: "SUCCESS" | "CONFLICT" | "FAILED";
	errorClass?: string;
	message?: string;
	pmCurrent?: { title: string; description: string };
	pmUrl?: string;
}

export interface BacklogApplyChangesOutput {
	success: boolean;
	appliedCount: number;
	syncedToPMCount: number;
	createdItems: AppliedItemInfo[];
	updatedItems: AppliedItemInfo[];
	skippedItems: SkippedItemInfo[];
	failedItems: FailedItemInfo[];
	errors: string[];
	pmSyncResults?: PmSyncItemResult[];
	pmSyncOutage?: PmSyncOutage;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelApplySignal = defineSignal("cancelApply");
export const applyProgressQuery =
	defineQuery<BacklogApplyProgress>("applyProgress");

// =============================================================================
// Activity Proxies
// =============================================================================

const { applyBacklogChanges } = proxyActivities<{
	applyBacklogChanges: typeof ApplyBacklogChangesFn;
}>({
	// Per-change work now includes the F-171 classifier + (for bugs) the
	// bug_creation drafting LLM call + RAG/live-integration context fetches
	// inside createStoryFromProposal — ~3-6s per story instead of <100ms.
	// A 50-change batch can take several minutes of wall-clock; give the
	// activity ample budget. Liveness is enforced by heartbeatTimeout, not
	// by startToCloseTimeout, so a generous wall-clock is safe.
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

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

const { discoverPMToolCapabilities } = proxyActivities<{
	discoverPMToolCapabilities: typeof DiscoverPMToolCapabilitiesFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { resolveApplyPmConfig } = proxyActivities<{
	resolveApplyPmConfig: typeof ResolveApplyPmConfigFn;
}>({
	startToCloseTimeout: "15 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
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

const { finalizePendingProposalActivity } = proxyActivities<{
	finalizePendingProposalActivity: typeof FinalizePendingProposalFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// Operation-result activity proxy. See the sister
// `backlog-context-analysis-workflow.ts` for the full timeout-strategy
// rationale; short version (Codex PR3 round-1 fix #1) is that the
// 15-second `scheduleToCloseTimeout` is intentional and matches the
// analysis workflow, because both backlog workflows are inline-await
// on the user-facing return path and a longer cap would expose a
// multi-minute UX stall through `analysis-progress.ts`'s
// `handle.result()` fallback.
const { postOperationResultActivity } = proxyActivities<
	typeof postOperationResultModule
>({
	startToCloseTimeout: "30 seconds",
	scheduleToCloseTimeout: "15 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "5s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// Workflow Implementation
// =============================================================================

export async function backlogApplyChangesWorkflow(
	input: BacklogApplyChangesInput,
): Promise<BacklogApplyChangesOutput> {
	const {
		projectId,
		userId,
		approvedByName,
		organizationId,
		approvedChanges,
		syncToPM,
		pmConfig,
		pendingProposalId,
		approvedChangeIndexes,
		pmSyncOverrides,
		// See input-interface comment above.
		conversationId,
		// Bug 1429 — see input-interface comment above.
		forbidEpics,
	} = input;

	// Workflow state
	let cancelled = false;
	const progress: BacklogApplyProgress = {
		status: "applying",
		completedCount: 0,
		totalCount: approvedChanges.length,
		message: "Applying backlog changes...",
		errors: [],
	};

	// Signal & Query Handlers
	setHandler(cancelApplySignal, () => {
		log.info("Received cancel signal for apply changes");
		cancelled = true;
		progress.status = "cancelled";
		progress.message = "Apply cancelled by user";
	});

	setHandler(applyProgressQuery, () => progress);

	// The Step 6 `postOperationResultActivity` was added
	// call below WITHOUT a patched() guard. Histories recorded by workers that
	// predate that change complete right after `finalizePendingProposalActivity`
	// and never schedule Step 6, so replaying them against current code raises
	// "Activity machine does not handle this event: WorkflowExecutionCompleted"
	// (issue #1377). Guard ONLY the Step 6 call: replaying an unmarked older
	// history returns false → skip Step 6 (matching the recorded history), while
	// every live execution returns true and posts the message as before.
	// `finalizePendingProposalActivity` predates #1235 (since #531) and IS present
	// in those histories, so it must stay unguarded.
	const emitOperationResult = patched(
		"backlog-apply-step6-operation-result-message",
	);

	try {
		log.info("Starting backlog apply changes workflow", {
			projectId,
			changeCount: approvedChanges.length,
			syncToPM,
			hasPmConfig: !!pmConfig,
			pmConfigId: pmConfig?.mcpConfigId,
		});

		if (approvedChanges.length === 0) {
			progress.status = "completed";
			progress.message = "No changes to apply.";
			return {
				success: true,
				appliedCount: 0,
				syncedToPMCount: 0,
				createdItems: [],
				updatedItems: [],
				skippedItems: [],
				failedItems: [],
				errors: [],
			};
		}

		// =====================================================================
		// Step 1: Apply changes to Fabric DB
		// =====================================================================

		progress.status = "applying";
		progress.message = "Creating and updating backlog items...";

		const applyResult = await applyBacklogChanges({
			projectId,
			userId,
			approvedByName,
			organizationId,
			approvedChanges,
			// Persist `pmAutoSyncEnabled: true` on every CREATEd epic/feature/
			// story when the approval opted into PM sync, so subsequent Fabric
			// edits don't silently diverge from the PM tool (the per-row gate
			// at `[[project_pm_sync_gate]]` short-circuits otherwise).
			syncToPM,
			// Bug 1429 — when dispatched from a channel-monitor approval, any
			// `epic`-typed change is normalized to a feature on apply.
			forbidEpics,
			// Stamp the AI audit rows with the originating proposal id so the
			// Audit history can link each change to its BacklogUpdateSession.
			// (Activity input-only; same command sequence → replay-safe.)
			pendingProposalId,
		});

		progress.completedCount = applyResult.appliedCount;

		// applyBacklogChanges() catches per-change DB failures and returns them
		// rather than throwing, so we must surface them into progress.errors to
		// block a premature APPLIED finalization downstream.
		if (applyResult.errors.length > 0) {
			for (const err of applyResult.errors) {
				progress.errors.push(
					`${err.change.type} "${err.change.title.to}": ${err.error}`,
				);
			}
		}

		// Build the set of change references that failed in the Fabric apply
		// step. PM sync must skip these — otherwise a failed update with an
		// existingId would still be pushed to the external PM tool, and the
		// proposal could end up reporting FAILED while the PM tool has been
		// mutated.
		const failedApplyChanges = new Set<ChangeProposal["changes"][number]>(
			applyResult.errors.map((e) => e.change),
		);

		// Per-item skipped (dedup title-collision) + failed (Fabric apply)
		// outcomes, surfaced to the approve UI's result summary so the reviewer
		// sees what was skipped/failed per item — not just an aggregate count.
		// PM-sync failures are reported separately via pmSyncOutage and are
		// intentionally NOT folded in here.
		const skippedItems: SkippedItemInfo[] =
			applyResult.skippedDuplicates.map((s) => ({
				type: s.type,
				title: s.proposedTitle,
				identifier: s.existingIdentifier,
				reason: s.existingIdentifier
					? `Already in the backlog as ${s.existingIdentifier}`
					: "Already in the backlog",
			}));
		const failedItems: FailedItemInfo[] = applyResult.errors.map((e) => ({
			type: e.change.type,
			title: e.change.title.to,
			reason: e.error,
		}));

		log.info("Applied backlog changes to Fabric DB", {
			appliedCount: applyResult.appliedCount,
			createdItems: Object.keys(applyResult.createdItemMap).length,
			dbErrors: applyResult.errors.length,
		});

		if (cancelled) {
			throw ApplicationFailure.nonRetryable(
				"Cancelled by user",
				BACKLOG_APPLY_CANCELLED_TYPE,
			);
		}

		// =====================================================================
		// Step 2: Sync to PM tool (if requested and configured)
		// =====================================================================

		let syncedToPMCount = 0;
		// Track per-position PM-sync outcome so we can record as APPLIED only
		// those changes that actually completed end-to-end. A change that is
		// Fabric-applied but fails PM sync is NOT recorded applied — a retry
		// of the FAILED proposal will re-run the apply workflow so PM sync
		// is re-attempted.
		const pmSucceededPositions = new Set<number>();
		const pmNotNeededPositions = new Set<number>();
		// Positions whose Fabric change applied but whose linked PM ticket was
		// deleted on its server (404). `syncWorkItemToPM` already proposed a
		// FLAG_MISSING for the Review Center, so these are recoverable re-link
		// conditions — counted as applied, NOT failed (the Fabric change landed).
		const pmTicketMissingPositions = new Set<number>();
		// Positions whose Fabric change applied but whose PM push hit a content
		// CONFLICT (the PM ticket drifted from our last-synced baseline).
		// `syncWorkItemToPM` already stamped `lastPmSyncStatus = CONFLICT`, which
		// surfaces the item in the Review Center (keep-mine / take-theirs /
		// AI-merge). Like a deleted ticket these are recoverable follow-ups —
		// counted as applied, NOT failed — so one drifted item can't fail the
		// whole proposal and trap it in a retry loop that re-conflicts forever.
		const pmConflictPositions = new Set<number>();
		const pmSyncResults: PmSyncItemResult[] = [];
		let pmSyncOutage: PmSyncOutage | undefined;

		// Resolve the effective PM config SERVER-SIDE so the push no longer depends
		// on the FE-supplied `pmConfig`, which the client leaves undefined whenever
		// the applying user can't resolve their OWN MCP config (teammate-configured
		// tool or GitLab-REST project) — the silent skip that made "Also sync to PM
		// tool" unreliable. patched() so recorded/in-flight histories — which used
		// the FE pmConfig and issued NO resolve activity — replay deterministically.
		let effectivePmConfig:
			| {
					mcpConfigId: string | null;
					mcpServerId?: string;
					containerId: string;
					containerName?: string;
					additionalContext?: Record<string, string>;
			  }
			| undefined = pmConfig;
		if (syncToPM && patched("resolve-apply-pm-config-v1")) {
			const resolvedPmConfig = await resolveApplyPmConfig({
				projectId,
				userId,
				organizationId,
			});
			if (resolvedPmConfig.resolved) {
				effectivePmConfig = {
					mcpConfigId: resolvedPmConfig.mcpConfigId,
					mcpServerId: resolvedPmConfig.mcpServerId,
					containerId: resolvedPmConfig.containerId,
					containerName: resolvedPmConfig.containerName,
					additionalContext: resolvedPmConfig.additionalContext,
				};
			} else if (!effectivePmConfig) {
				// syncToPM requested but no config resolved for this user →
				// surface an actionable warning instead of a silent
				// APPLIED-with-no-sync (AC7).
				log.warn(
					"Backlog apply requested PM sync but no config resolved",
					{ projectId, userId, reason: resolvedPmConfig.reason },
				);
				pmSyncOutage = {
					tool: "PM tool",
					errorClass:
						resolvedPmConfig.reason === "user-not-connected"
							? "not_connected"
							: "not_configured",
					count: approvedChanges.length,
					items: [],
				};
			}
		}

		if (syncToPM && effectivePmConfig) {
			const pmCfg = effectivePmConfig;
			progress.status = "syncing_pm";
			progress.message = "Syncing changes to PM tool...";

			// Discover capabilities once
			const capabilities = await discoverPMToolCapabilities({
				mcpConfigId: pmCfg.mcpConfigId,
				mcpServerId: pmCfg.mcpServerId,
				userId,
				organizationId,
			});

			if (capabilities?.hasPMCapabilities) {
				// Determine if this is a hierarchical PM tool (ADO) or flat (Fizzy, etc.)
				const isHierarchicalPM =
					capabilities.detectedType === "azure-devops";

				// Flat PM tools now sync `feature` items as cards (not only
				// story/bug). Guarded with patched() so recorded/in-flight
				// histories — which skipped features and therefore issued NO
				// syncWorkItemToPM command for them — replay deterministically;
				// new runs sync features. See shouldSkipFlatPmSync + the DSU
				// 2026-05-23 "story" retirement that made `feature` the leaf type.
				const syncFeaturesToFlatPm = patched("flat-pm-sync-features");

				// Sync each applied item to PM
				for (const [changeIndex, change] of approvedChanges.entries()) {
					if (cancelled) {
						break;
					}

					// User-requested skip from the AI Update conflict review.
					// Fabric write still applied; PM sync omitted entirely.
					if (pmSyncOverrides?.[changeIndex]?.skip) {
						log.info("Skipping PM sync per user override", {
							changeType: change.type,
							title: change.title.to,
						});
						pmNotNeededPositions.add(changeIndex);
						continue;
					}

					// Skip PM sync for any change that failed to apply in
					// Fabric — otherwise a failed update could still push to
					// the external PM tool via its existingId.
					if (failedApplyChanges.has(change)) {
						log.info(
							"Skipping PM sync for change that failed in Fabric apply",
							{
								changeType: change.type,
								title: change.title.to,
							},
						);
						continue;
					}

					const itemType = (applyResult.typeCorrections?.[
						changeIndex
					] ?? change.type) as "epic" | "feature" | "story" | "bug";

					// Flat PM tools: sync leaf work items (feature/story/bug) as
					// cards; skip only `epic` containers. Pre-patch histories take
					// the legacy story/bug-only branch — see shouldSkipFlatPmSync.
					if (
						shouldSkipFlatPmSync(
							itemType,
							isHierarchicalPM,
							syncFeaturesToFlatPm,
						)
					) {
						log.info(
							"Skipping PM sync for container item (flat PM tool)",
							{
								changeType: itemType,
								title: change.title.to,
								detectedType: capabilities.detectedType,
							},
						);
						pmNotNeededPositions.add(changeIndex);
						continue;
					}

					const itemId =
						applyResult.createdItemMap[changeIndex] ??
						applyResult.updatedItemMap[changeIndex] ??
						change.existingId;

					if (!itemId) {
						continue;
					}

					progress.currentItem = `${itemType}: ${change.title.to}`;
					progress.message = `Syncing ${itemType} to PM tool...`;
					try {
						try {
							const syncResult = await syncWorkItemToPM({
								itemType,
								itemId,
								projectId,
								mcpConfigId: pmCfg.mcpConfigId,
								mcpServerId: pmCfg.mcpServerId,
								containerId: pmCfg.containerId,
								containerName: pmCfg.containerName,
								additionalContext: pmCfg.additionalContext,
								userId,
								organizationId,
								capabilities,
								action: change.action,
								existingExternalId:
									change.existingExternalId ?? undefined,
								triggerSource: "ai-update",
								pushAnyway:
									pmSyncOverrides?.[changeIndex]
										?.pushAnyway ?? false,
							});

							if (syncResult.status === "SUCCESS") {
								syncedToPMCount++;
								pmSucceededPositions.add(changeIndex);
								pmSyncResults.push({
									storyId: itemId,
									itemType,
									status: "SUCCESS",
								});
							} else if (syncResult.status === "CONFLICT") {
								// The PM ticket drifted from our last-synced baseline,
								// so the push was refused and `syncWorkItemToPM` already
								// stamped `lastPmSyncStatus = CONFLICT` (Review Center
								// conflict resolution). The Fabric change DID apply, so —
								// like a deleted ticket (`pmTicketMissingPositions`) —
								// count it as applied and keep it OUT of `progress.errors`
								// so one drifted item can't fail the whole proposal and
								// trap it in a retry loop that re-conflicts forever.
								pmConflictPositions.add(changeIndex);
								pmSyncResults.push({
									storyId: itemId,
									itemType,
									status: "CONFLICT",
									pmCurrent: syncResult.pmCurrent,
									pmUrl: syncResult.pmUrl,
								});
								log.info(
									"PM sync conflict — change applied, flagged for Review Center",
									{ changeType: change.type, itemId },
								);
							} else if (syncResult.status === "FAILED") {
								// `syncWorkItemToPM` already stamped
								// `lastPmSyncStatus = FAILED` via
								// `recordPmSyncFailure({ errorClass:
								// "create_orphan" })` before returning, so we
								// do NOT re-stamp here. Push to the apply
								// result + surface to `progress.errors` so the
								// approve flow's success summary reflects the
								// failure instead of silently dropping it
								// (which previously made the user think the
								// proposal applied cleanly while a row was
								// left orphaned in the PM tool).
								pmSyncResults.push({
									storyId: itemId,
									itemType,
									status: "FAILED",
									errorClass: "create_orphan",
									message: syncResult.error,
								});
								progress.errors.push(
									`PM sync failed for ${change.type} "${change.title.to}": ${syncResult.error}`,
								);
							}
						} catch (error) {
							const { message: errorMsg, errorClass } =
								unwrapPmSyncError(error);
							const ticketMissing = isPmTicketMissingError(
								errorClass,
								errorMsg,
							);
							if (ticketMissing) {
								// The linked PM ticket was deleted on its server.
								// The Fabric change DID apply and
								// `syncWorkItemToPM` already proposed a
								// FLAG_MISSING (Review Center re-push / unlink /
								// dismiss), so this is a recoverable re-link
								// condition — NOT an apply failure. Count it as
								// applied (Step 3) and keep it OUT of
								// `progress.errors` / `pmSyncResults` so it neither
								// fails the whole proposal nor shows up as a
								// phantom "failed PM sync" / outage.
								pmTicketMissingPositions.add(changeIndex);
								log.warn(
									"PM ticket missing (deleted) — change applied, flagged for re-link",
									{
										changeType: change.type,
										itemId,
										errorClass,
										error: errorMsg,
									},
								);
							} else {
								progress.errors.push(
									`PM sync failed for ${change.type} "${change.title.to}": ${errorMsg}`,
								);
								log.warn("PM sync failed for item", {
									changeType: change.type,
									itemId,
									errorClass,
									error: errorMsg,
								});
								pmSyncResults.push({
									storyId: itemId,
									itemType,
									status: "FAILED",
									errorClass,
									message: errorMsg,
								});
							}
							// Stamp the per-story sync failure either way (roadmap
							// surfacing); unchanged from prior behaviour.
							await recordPmSyncFailure({
								itemId,
								itemType,
								errorMessage: errorMsg,
								errorClass,
								triggerSource: "ai-update",
							});
						}
					} finally {
						await clearPmSyncPendingIfLeaked({
							itemId,
							itemType,
						});
					}
				}

				log.info("PM sync complete", {
					syncedCount: syncedToPMCount,
					failedCount: progress.errors.length,
				});

				// All hierarchy item types are now retry-eligible via
				// retryPmSyncBatch (Feature/Epic carry the same PM sync
				// state columns as UserStory).
				const failedItems = pmSyncResults.filter(
					(r) => r.status === "FAILED",
				);
				if (failedItems.length > 0) {
					pmSyncOutage = computePmSyncOutage(
						failedItems.map((r) => ({
							id: r.storyId,
							itemType: r.itemType,
							errorClass: r.errorClass ?? "UnknownError",
						})),
						capabilities.detectedType ?? "unknown",
					);
					if (pmSyncOutage) {
						log.warn("pm.sync.outage", {
							tool: pmSyncOutage.tool,
							errorClass: pmSyncOutage.errorClass,
							count: pmSyncOutage.count,
						});
					}
				}
			} else {
				log.warn("PM tool does not have required capabilities");
				progress.errors.push("PM tool does not support task creation");
			}
		}

		// =====================================================================
		// Step 3: Finalize
		// =====================================================================

		progress.status = "completed";
		progress.completedCount = applyResult.appliedCount;
		progress.createdItems = applyResult.createdItems;
		progress.updatedItems = applyResult.updatedItems;
		progress.skippedItems = skippedItems;
		progress.failedItems = failedItems;

		const syncMsg = syncToPM
			? `. ${syncedToPMCount} synced to PM tool`
			: "";
		const relinkMsg =
			pmTicketMissingPositions.size > 0
				? ` ${pmTicketMissingPositions.size} item(s) need re-linking — the linked PM ticket was deleted in the PM tool.`
				: "";
		const conflictMsg =
			pmConflictPositions.size > 0
				? ` ${pmConflictPositions.size} item(s) changed in the PM tool and need conflict resolution in the Review Center.`
				: "";
		progress.message = `Applied ${applyResult.appliedCount} change(s)${syncMsg}.${relinkMsg}${conflictMsg}`;

		log.info("Backlog apply changes workflow completed", {
			appliedCount: applyResult.appliedCount,
			syncedToPMCount,
			errors: progress.errors.length,
		});

		// If this workflow was invoked from a PendingBacklogProposal approval,
		// flip its terminal state here so the inbox doesn't need to poll.
		// On partial failure we record ONLY the indexes that fully completed
		// end-to-end — Fabric apply succeeded AND (PM sync succeeded OR PM
		// sync wasn't needed for this change). Any change that failed PM sync
		// is deliberately NOT recorded so a retry of the FAILED proposal
		// re-runs the apply workflow for it and re-attempts the PM sync.
		if (pendingProposalId) {
			const hadErrors = progress.errors.length > 0;
			let appliedIndexes: number[] | undefined;
			if (approvedChangeIndexes) {
				// Map Fabric-applied positions (create + update) to fully-
				// applied proposal indexes. A change whose PM ticket was
				// deleted counts as applied (the Fabric change landed; the
				// ticket is flagged for re-link), while a genuine PM-sync
				// failure is left out so a retry re-attempts its sync.
				const fabricSucceededPositions = new Set<number>([
					...Object.keys(applyResult.createdItemMap).map(Number),
					...Object.keys(applyResult.updatedItemMap).map(Number),
				]);
				appliedIndexes = computeAppliedProposalIndexes({
					fabricSucceededPositions,
					approvedChangeIndexes,
					syncToPM,
					pmSucceededPositions,
					pmNotNeededPositions,
					pmTicketMissingPositions,
					pmConflictPositions,
				});
			}
			// Codex PR3 round-1 fix #2 (success-path symmetry with catch
			// branch) — isolate the finalize from the downstream Step 6
			// dispatch. A throw here would skip Step 6 entirely and the
			// user would never see the successful run materialise as a
			// system message.
			//
			// FAILED-with-no-thrown-error branch (per-change failures returned
			// in `applyResult.errors[]`): no single SDK error object is on
			// hand, so we synthesize the `{ errorClass, errorMessage }`
			// pair from the first reported per-change error. The dedup-
			// guard idempotency invariant still holds — a follow-up retry
			// of this same proposalId either lands on the existing row via
			// title collision (mark APPLIED) or re-runs the work with
			// `appliedChangeIndexes` honoured.
			const rawApplyError = hadErrors
				? progress.errors.join("\n").slice(0, 4000)
				: undefined;
			const firstErrorMessage = hadErrors
				? (progress.errors[0] ?? "apply workflow failed").slice(0, 500)
				: undefined;
			try {
				await finalizePendingProposalActivity({
					proposalId: pendingProposalId,
					outcome: hadErrors ? "failed" : "applied",
					appliedChangeIndexes: appliedIndexes,
					errorClass: hadErrors ? "default" : undefined,
					errorMessage: firstErrorMessage,
					rawApplyError,
					// Fabric-applied changes whose PM push hit a content
					// conflict (kept out of `hadErrors`). Drives the
					// session-history "N applied · M need review" split
					// without failing the proposal — the M items are
					// flagged in the Review Center.
					pmConflictCount: pmConflictPositions.size,
				});
			} catch (finalizeError) {
				log.warn(
					"finalizePendingProposalActivity failed on apply success path (non-fatal); Step 6 still attempts",
					{
						pendingProposalId,
						error:
							finalizeError instanceof Error
								? finalizeError.message
								: String(finalizeError),
					},
				);
			}
		}

		// Step 6: persist operation-result message.
		// Mirrors `backlog-context-analysis-workflow.ts` Step 6 — same
		// timeout strategy, same `nonCancellable` wrapping, same
		// `conversationId` short-circuit.
		//
		// Codex PR3 round-1 fix #6 — outcome trichotomy. Pre-fix logic
		// was binary: `errors.length === 0 ? "success" : "partial"`. The
		// edge case where appliedCount === 0 AND errors > 0 (every
		// attempted change failed) was marked "partial", which is
		// misleading — nothing actually went through. Now:
		//   - success: zero errors (regardless of appliedCount)
		//   - failure: zero applied AND some errors (worst case)
		//   - partial: mixed — some applied, some failed
		// This matches what an operator scanning the chat thread
		// would intuit from the operationLabel + outcome glyph.
		// `<SystemMessage>` renders ✓ / ✕ / ◐ for these.
		if (conversationId && emitOperationResult) {
			// Conflicts are NOT in `progress.errors` (they're recoverable
			// Review Center follow-ups, not failures), so fold them into
			// the outcome explicitly: a clean apply with M drifted items
			// reads as "partial" (◐), not "success" (✓).
			const hasPmConflicts = pmConflictPositions.size > 0;
			const persistedOutcome: "success" | "partial" | "failure" =
				progress.errors.length === 0 && !hasPmConflicts
					? "success"
					: applyResult.appliedCount === 0
						? "failure"
						: "partial";
			const summaryParts: string[] = [];
			summaryParts.push(
				`${applyResult.appliedCount} change(s) applied${
					syncToPM ? `, ${syncedToPMCount} synced to PM tool` : ""
				}.`,
			);
			if (progress.errors.length > 0) {
				summaryParts.push(
					`${progress.errors.length} error(s) during apply.`,
				);
			}
			if (pmConflictPositions.size > 0) {
				summaryParts.push(
					`${pmConflictPositions.size} item(s) changed in the PM tool — resolve in the Review Center.`,
				);
			}
			// Replay-safety: `convertedToCreate` is a NEW field on the
			// applyBacklogChanges result. Histories recorded before it existed
			// deserialize without it, so a bare `.length` throws during replay —
			// and that throw, swallowed by the outer `catch` below, re-schedules
			// finalizePendingProposalActivity where history expected
			// postOperationResultActivity (a TMPRL1100 non-determinism error,
			// PR #1524). `Array.isArray` keeps the command stream identical for
			// old histories (block skipped → Step 6 still scheduled next).
			if (
				Array.isArray(applyResult.convertedToCreate) &&
				applyResult.convertedToCreate.length > 0
			) {
				summaryParts.push(
					`${applyResult.convertedToCreate.length} proposed update(s) had no matching item and were created as new: ${applyResult.convertedToCreate
						.map((c) => `"${c.proposedTitle}"`)
						.join(", ")}.`,
				);
			}
			try {
				await CancellationScope.nonCancellable(async () => {
					await postOperationResultActivity({
						conversationId,
						userId,
						organizationId: organizationId ?? null,
						operationKey: `${workflowInfo().workflowId}-result`,
						outcome: persistedOutcome,
						operationLabel: "Backlog apply",
						summary: summaryParts.join(" "),
					});
				});
			} catch (postError) {
				log.warn(
					"Step 6 — operation-result message failed (non-fatal)",
					{
						conversationId,
						error:
							postError instanceof Error
								? postError.message
								: String(postError),
					},
				);
			}
		}

		return {
			success: progress.errors.length === 0,
			appliedCount: applyResult.appliedCount,
			syncedToPMCount,
			createdItems: applyResult.createdItems,
			updatedItems: applyResult.updatedItems,
			skippedItems,
			failedItems,
			errors: progress.errors,
			pmSyncResults: syncToPM ? pmSyncResults : undefined,
			pmSyncOutage,
		};
	} catch (error) {
		// PR3 — unify failure handling so Step 6 sees BOTH error shapes
		// uniformly (mirrors the catch refactor in PR2's direct-chat).
		const errorMessage =
			error instanceof Error ? error.message : String(error);

		if (!(error instanceof ApplicationFailure)) {
			log.error("Backlog apply changes workflow failed", {
				error: errorMessage,
			});
			progress.status = "failed";
			progress.message = errorMessage;
		}

		// finalizePendingProposalActivity (existing behaviour preserved),
		// but Codex PR3 round-1 fix #2 — isolate the finalize failure
		// from the downstream Step 6 dispatch. Pre-fix the finalize call
		// was naked-awaited here; if it threw (e.g. activity-worker
		// hiccup, retry budget exhausted), control would skip Step 6
		// entirely and the user would never see their cancelled/failed
		// run materialise as a system message — violating the contract
		// that the user-facing completion path must not regress because
		// of an internal side-effect activity's failure.
		//
		// Classify the thrown error via `unwrapPmSyncError` so the
		// proposal row carries `errorClass` (e.g. "PmAuthError",
		// "PayloadTooLarge") in addition to the short message and the
		// raw text. The inbox + roadmap banner read `errorClass` to map
		// to plain-English copy. The dedup-guard idempotency invariant
		// guarantees that a subsequent retry of the same proposalId
		// either lands on a pre-existing UserStory by title collision
		// (mark APPLIED) or runs the workflow afresh with
		// `appliedChangeIndexes` honoured — no duplicate rows.
		const { errorClass: classifiedErrorClass, message: classifiedMessage } =
			unwrapPmSyncError(error);
		if (pendingProposalId) {
			try {
				await finalizePendingProposalActivity({
					proposalId: pendingProposalId,
					outcome: "failed",
					errorClass: classifiedErrorClass,
					errorMessage: classifiedMessage,
					rawApplyError: errorMessage,
				});
			} catch (finalizeError) {
				log.warn(
					"finalizePendingProposalActivity failed in apply catch (non-fatal — proposal may stay in PENDING_FAILED until next retry); Step 6 still attempts",
					{
						pendingProposalId,
						error:
							finalizeError instanceof Error
								? finalizeError.message
								: String(finalizeError),
					},
				);
			}
		}

		// Step 6. `isTerminal` guard
		// matches the sister `backlog-context-analysis-workflow.ts` and
		// PR2's direct-chat catch: only post when the workflow won't be
		// retried, otherwise the dedup'd "failure" row would survive
		// past a later successful retry.
		//
		// Code-reviewer #2 fix: detect cancellation via the
		// `ApplicationFailure.type` set by the cancel-signal handler at
		// L332-334 (`"BACKLOG_APPLY_CANCELLED"`) and post
		// `outcome: "cancelled"` instead of `"failure"`. The activity's
		// `OperationOutcome` enum accepts "cancelled" and
		// `<SystemMessage>` renders the ⊘ glyph for it — distinct from
		// the ✕ used for genuine failures.
		const isCancellation =
			error instanceof ApplicationFailure &&
			error.type === BACKLOG_APPLY_CANCELLED_TYPE;
		const isTerminal =
			!(error instanceof ApplicationFailure) ||
			error.nonRetryable === true;
		if (conversationId && isTerminal && emitOperationResult) {
			const stepOutcome: "failure" | "cancelled" = isCancellation
				? "cancelled"
				: "failure";
			try {
				await CancellationScope.nonCancellable(async () => {
					await postOperationResultActivity({
						conversationId,
						userId,
						organizationId: organizationId ?? null,
						operationKey: `${workflowInfo().workflowId}-result`,
						outcome: stepOutcome,
						operationLabel: "Backlog apply",
						summary: errorMessage,
					});
				});
			} catch (postError) {
				log.warn(
					"Step 6 — operation-result message failed (non-fatal)",
					{
						conversationId,
						error:
							postError instanceof Error
								? postError.message
								: String(postError),
					},
				);
			}
		}

		if (error instanceof ApplicationFailure) {
			throw error;
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"BACKLOG_APPLY_FAILED",
		);
	}
}
