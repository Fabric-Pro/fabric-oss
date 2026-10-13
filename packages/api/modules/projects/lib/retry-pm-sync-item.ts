import { applyPmUnlink, clearPmCreateClaim, db } from "@repo/database";
import { type EnqueuePmSyncResult, enqueuePmSync } from "./enqueue-pm-sync";
import { retryTestCasePmSync } from "./retry-test-case-pm-sync";

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
	/**
	 * The stored link's URL, read with it. Test cases only: their Unlink &
	 * re-create also requires the URL to be unchanged. Stories ignore it.
	 */
	externalUrl?: string | null;
	/**
	 * The item's PM create claim, read by the caller with the link. Unlink &
	 * re-create clears only this exact claim: a claim taken after the read
	 * belongs to a push that may already have sent a create, so the recovery
	 * keeps it and enqueues nothing (`reason: "pm-recovery-stale"`). `null`
	 * means there was no claim to clear.
	 */
	pmCreateClaimId: string | null;
}

/**
 * `enqueuePmSync`'s result, plus the recovery's own refusals:
 * `"pm-recovery-stale"` — Unlink & re-create found the PM link or the create
 * claim changed since the caller read them, so nothing was cleared or
 * enqueued; `"already-running"` (test cases) — a push of the case is already
 * running and settles it, so nothing was cleared, stamped or started;
 * `"pm-recovery-too-recent"` — the create claim read is still held and
 * younger than `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`, so a push may still
 * be sending its create: nothing was cleared or enqueued, and
 * `recoverableAt` says when it can be (`null` when unknown).
 */
export type RetryPmSyncItemResult = Omit<EnqueuePmSyncResult, "reason"> & {
	reason?:
		| EnqueuePmSyncResult["reason"]
		| "pm-recovery-stale"
		| "pm-recovery-too-recent"
		| "already-running";
	recoverableAt?: Date | null;
};

/**
 * The message for `"pm-recovery-stale"`, for callers that report it to the
 * user.
 */
export const PM_RECOVERY_STALE_MESSAGE =
	"This item's PM link or pending create changed after it was loaded (another sync may be creating it right now), so Fabric did not unlink or re-create it. Refresh, check the PM tool, and try again if it is still needed.";

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
): Promise<RetryPmSyncItemResult> {
	// Test cases ride their own table + `testCaseSyncWorkflow`, with their own
	// Unlink & re-create (`applyTestCasePmUnlink`); there is no
	// `PendingPmStateChange`/FLAG_MISSING flow for them.
	if (input.itemType === "testCase") {
		return retryTestCasePmSync(input);
	}

	// "Unlink & re-create": sever the dead PM link before syncing so the push
	// re-creates a fresh card instead of re-failing on the deleted one, and
	// dismiss any pending FLAG_MISSING review row so the Review Center doesn't
	// show a stale "unlink" proposal afterward. Reuses the same atomic unlink
	// predicate as the Review Center (`applyPmUnlink`), scoped also to the
	// create claim read with the link, which it drops. When the row no longer
	// matches what was read (another recovery or push got there first), it
	// is left alone and nothing is enqueued.
	if (input.unlinkFirst && input.externalId) {
		const entityType = ITEM_TYPE_TO_ENTITY[input.itemType];
		const { applied, claimTooRecent } = await applyPmUnlink({
			projectId: input.projectId,
			entityType,
			entityId: input.itemId,
			expectedExternalId: input.externalId,
			expectedExternalMcpServerId: input.externalMcpServerId,
			expectedPmCreateClaimId: input.pmCreateClaimId,
		});
		if (claimTooRecent) {
			return {
				enqueued: false,
				reason: "pm-recovery-too-recent",
				recoverableAt: claimTooRecent.recoverableAt,
			};
		}
		if (!applied) {
			return { enqueued: false, reason: "pm-recovery-stale" };
		}
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
	} else if (
		input.unlinkFirst &&
		input.pmCreateClaimId &&
		ITEM_TYPE_TO_ENTITY[input.itemType] === "STORY"
	) {
		// An unlinked row whose earlier create may have reached the PM tool
		// still holds its create claim, and every push refuses to create
		// while it does. Unlink & re-create is the user saying no PM item
		// exists for it (or that a second one is wanted), so drop the claim
		// that was read and let this push create. A different claim now
		// means another push took it after the read and may already have
		// sent a create: it is kept and nothing is enqueued. So is the claim
		// read while it is younger than PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS:
		// its push may still be sending its create.
		const { cleared, claimTooRecent } = await clearPmCreateClaim({
			projectId: input.projectId,
			storyId: input.itemId,
			claimId: input.pmCreateClaimId,
		});
		if (claimTooRecent) {
			return {
				enqueued: false,
				reason: "pm-recovery-too-recent",
				recoverableAt: claimTooRecent.recoverableAt,
			};
		}
		if (!cleared) {
			return { enqueued: false, reason: "pm-recovery-stale" };
		}
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
