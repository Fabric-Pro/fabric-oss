import { applyPmUnlink, db, PmSyncStatus } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import { type EnqueuePmSyncResult, enqueuePmSync } from "./enqueue-pm-sync";
import { resolvePmTarget } from "./resolve-pm-target";

/**
 * Work-item retry types map to `db.userStory` and the story enqueue path.
 * `testCase` is handled separately (its own table + `testCaseSyncWorkflow`), so
 * it is intentionally excluded from this story-side dispatch map.
 */
type WorkItemRetryType = "epic" | "feature" | "story" | "bug";

type RetryPmSyncItemType = WorkItemRetryType | "testCase";

/**
 * Map a sync item type to the `PendingPmStateChange` entity type. Bugs are
 * `UserStory` rows, so they log/flag as `STORY`. `testCase` never reaches this
 * map — it short-circuits to its own sync path before the unlink dispatch.
 */
const ITEM_TYPE_TO_ENTITY: Record<
	WorkItemRetryType,
	"EPIC" | "FEATURE" | "STORY"
> = { epic: "EPIC", feature: "FEATURE", story: "STORY", bug: "STORY" };

export interface RetryPmSyncItemInput {
	itemId: string;
	itemType: RetryPmSyncItemType;
	projectId: string;
	userId: string;
	pushAnyway?: boolean;
	/**
	 * "Unlink & re-create": sever a dead PM link before syncing so the push
	 * takes the CREATE path and makes a fresh card (the deleted-card recovery).
	 */
	unlinkFirst?: boolean;
	/**
	 * The item's currently-stored PM link, resolved by the caller (which also
	 * performs its own tenant-ownership check). When `unlinkFirst` is set and
	 * `externalId` is present, the link is severed with this exact provenance —
	 * the same atomic predicate the Review Center uses.
	 */
	externalId: string | null;
	externalMcpServerId: string | null;
}

/**
 * Enqueue a PM sync for a single hierarchy item, optionally severing a dead PM
 * link first. Shared by `retryPmSync` (single) and `retryPmSyncBatch` (bulk) so
 * the deleted-card unlink-and-recreate path has one implementation and the bulk
 * path inherits the single-item BUG-retry/itemType behavior with no divergence.
 *
 * The caller resolves ownership + the current link and passes them in; this
 * helper only acts on what it is given. Like `enqueuePmSync`, it does not
 * resolve the work-item type beyond what is passed — `enqueuePmSync` promotes
 * `story → bug` from the persisted `kind` internally.
 */
export async function retryPmSyncItem(
	input: RetryPmSyncItemInput,
): Promise<EnqueuePmSyncResult> {
	// Test cases ride their own table + `testCaseSyncWorkflow`; they never take
	// the story enqueue path or the `applyPmUnlink` deleted-card recovery (there
	// is no `PendingPmStateChange`/FLAG_MISSING flow for them in v1). Dispatch to
	// the dedicated single-item sync and return its result in the shared shape.
	if (input.itemType === "testCase") {
		return startTestCaseSyncForItem(input);
	}

	// "Unlink & re-create": sever the dead PM link before syncing so the push
	// re-creates a fresh card instead of re-failing on the deleted one, and
	// dismiss any pending FLAG_MISSING review row so the Review Center doesn't
	// show a stale "unlink" proposal afterward. Reuses the same atomic unlink
	// predicate as the Review Center (`applyPmUnlink`). No-op when the item is
	// already unlinked.
	if (input.unlinkFirst && input.externalId) {
		const entityType = ITEM_TYPE_TO_ENTITY[input.itemType];
		await applyPmUnlink({
			projectId: input.projectId,
			entityType,
			entityId: input.itemId,
			expectedExternalId: input.externalId,
			expectedExternalMcpServerId: input.externalMcpServerId,
		});
		await db.pendingPmStateChange.updateMany({
			where: {
				projectId: input.projectId,
				entityType,
				entityId: input.itemId,
				status: "PENDING",
				proposedAction: "FLAG_MISSING",
			},
			data: { status: "DISMISSED" },
		});
	}

	return enqueuePmSync({
		itemId: input.itemId,
		itemType: input.itemType,
		projectId: input.projectId,
		userId: input.userId,
		pushAnyway: input.pushAnyway,
		// Arm the initial push whenever the row has no live PM link — either we
		// just severed it (unlinkFirst) or this is a failed FIRST push that never
		// created a card (externalId is null). In both cases there is nothing to
		// update, so a retry must take the CREATE path; otherwise enqueuePmSync
		// short-circuits on `no-external-id` and the Retry button is a silent
		// no-op, leaving the item FAILED with the same stale error.
		forceInitialPush: input.unlinkFirst || !input.externalId,
		triggerSource: "retry",
	});
}

/**
 * Enqueue a single test case's PM sync by starting `testCaseSyncWorkflow` scoped
 * to just that id (`testCaseIds: [itemId]`, `direction: "push"`). The test-case
 * counterpart of `enqueuePmSync`: resolve the project's PM target (MCP or GitLab
 * REST), stamp the row PENDING for immediate UI feedback, then fire the workflow
 * on the shared `"ai-chat"` queue. On a Temporal-start failure the row is stamped
 * FAILED so the existing retry surface picks it up. Returns the same
 * `EnqueuePmSyncResult` shape the story path uses.
 */
async function startTestCaseSyncForItem(
	input: RetryPmSyncItemInput,
): Promise<EnqueuePmSyncResult> {
	const { itemId, projectId, userId } = input;

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
	// Read-only mode: skip before stamping PENDING — mirrors
	// the enqueuePmSync gate for the story path.
	if (project.readOnlyMode) {
		return { enqueued: false, reason: "read-only-mode" };
	}
	if (!project.projectManagementContainerId) {
		return { enqueued: false, reason: "no-pm-config" };
	}

	// Accept both MCP-backed and GitLab-REST projects (the same resolver the bulk
	// sync uses); a null target means the caller has no usable PM connection.
	const target = await resolvePmTarget({
		project: {
			projectManagementMcpServerId: project.projectManagementMcpServerId,
			projectManagementMcpConfigId: project.projectManagementMcpConfigId,
			organizationId: project.organizationId,
		},
		userId,
		organizationId: project.organizationId,
	});
	if (!target) {
		return { enqueued: false, reason: "no-pm-config" };
	}

	// Immediate PENDING feedback (mirrors `enqueuePmSync`'s markPending) — the
	// workflow re-stamps SUCCESS/FAILED/CONFLICT once it runs.
	await db.testCase.updateMany({
		where: { id: itemId, projectId },
		data: {
			lastPmSyncStatus: PmSyncStatus.PENDING,
			lastPmSyncAttemptAt: new Date(),
		},
	});

	try {
		const client = await getTemporalClient();
		const additionalContext =
			(project.projectManagementAdditionalContext as Record<
				string,
				string
			> | null) ?? undefined;
		// The start-site `Date.now()` is intentional (and lives in the API, not
		// the deterministic workflow body) — it makes each retry a fresh run.
		const workflowId = `test-case-sync-${projectId}-${itemId}-${Date.now()}`;
		const handle = await client.workflow.start(
			"testCaseSyncWorkflow",
			withCorrelationMemo({
				taskQueue: "ai-chat",
				workflowId,
				args: [
					{
						projectId,
						// Guarded by the `resolvePmTarget` contract above (it only
						// returns non-null when the project has a server id).
						// biome-ignore lint/style/noNonNullAssertion: resolvePmTarget guarantees a server id
						mcpServerId: project.projectManagementMcpServerId!,
						mcpConfigId:
							target.kind === "mcp" ? target.mcpConfigId : null,
						containerId: project.projectManagementContainerId,
						containerName:
							project.projectManagementContainerName ?? undefined,
						additionalContext,
						userId,
						organizationId: project.organizationId || undefined,
						testCaseIds: [itemId],
						direction: "push",
						unsyncedOnly: false,
					},
				],
			}),
		);
		return { enqueued: true, workflowId: handle.workflowId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			await db.testCase.updateMany({
				where: { id: itemId, projectId },
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
		} catch {
			// Best-effort rollback; the PENDING badge is reconciled by the next
			// sync attempt if this write also fails.
		}
		return { enqueued: false, reason: "temporal-error" };
	}
}
