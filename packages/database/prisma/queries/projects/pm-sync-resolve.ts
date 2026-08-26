/**
 * PM-sync conflict-resolution dispatch helpers.
 *
 * The `resolveConflict` procedure (`@repo/api`) must operate over work items
 * without inlining Prisma in the procedure body (`backend/queries.md`: no
 * business logic / inline Prisma in procedures).
 *
 * `story` and `bug` both map to `db.userStory` — mirroring the coalescing in
 * `enqueue-pm-sync.ts` and `preview-pm-sync-conflict.ts`'s
 * `loadHashAndExternalId`. Bugs are persisted as user stories.
 *
 * `epic` / `feature` remain in the `PmSyncItemType` union ONLY for wire
 * compatibility with persisted Temporal histories and stored payloads — the
 * Epic/Feature folder tables were dropped, so those item types resolve to
 * "not found" / no-op here.
 *
 * `testCase` maps to its own `db.testCase` table. Only the failure-clear
 * helpers (`clearPmSyncFailure` / `clearPmSyncFailures`, the dismiss flow)
 * handle it; the story-specific resolve helpers (`getPmSyncItemState`,
 * `clearPmSyncConflictFlag`, `writePmSyncItemContent`, …) no-op for it because
 * test-case CONFLICT/resolution rides its own dedicated paths.
 */
import {
	db,
	type FeatureDraftingStage,
	type LastEditSource,
	PmSyncStatus,
} from "../../client";
import { createFeatureVersion } from "./feature-versions";

export type PmSyncItemType = "epic" | "feature" | "story" | "bug" | "testCase";

export interface PmSyncItemState {
	id: string;
	lastPmSyncStatus: PmSyncStatus | null;
}

/** True when the item type maps to a `user_story` row (the only work-item table). */
function isStoryItemType(itemType: PmSyncItemType): boolean {
	return itemType === "story" || itemType === "bug";
}

/**
 * Read the conflict/sync state for a single work item, scoped to the
 * project (tenant guard). Returns `null` when the item does not exist in the
 * given project so the caller can raise a typed `NOT_FOUND`. Legacy
 * `epic`/`feature` item types always resolve to `null` (tables dropped).
 *
 * Selects only the columns the resolution flow needs (`backend/queries.md`).
 */
export async function getPmSyncItemState(args: {
	itemType: PmSyncItemType;
	itemId: string;
	projectId: string;
}): Promise<PmSyncItemState | null> {
	if (!isStoryItemType(args.itemType)) {
		return null;
	}
	return db.userStory.findFirst({
		where: { id: args.itemId, projectId: args.projectId },
		select: { id: true, lastPmSyncStatus: true },
	});
}

/**
 * Clear the PM-sync CONFLICT flag on a single work item: set
 * `lastPmSyncStatus` to SUCCESS and drop the stored error so auto-push can
 * resume on the next status move.
 */
export async function clearPmSyncConflictFlag(args: {
	itemType: PmSyncItemType;
	itemId: string;
}): Promise<void> {
	if (!isStoryItemType(args.itemType)) {
		return;
	}
	await db.userStory.update({
		where: { id: args.itemId },
		data: {
			lastPmSyncStatus: PmSyncStatus.SUCCESS,
			lastPmSyncError: null,
		},
	});
}

/**
 * Dismiss a PM-sync FAILED flag on a single work item: clear
 * `lastPmSyncStatus` and the stored error so the item leaves the Review
 * Center's Failures queue. Scoped to `lastPmSyncStatus = FAILED` via
 * `updateMany` (with `projectId` as a tenant guard) so it never clobbers a
 * CONFLICT / SUCCESS / PENDING state — a no-op (count 0) when the item isn't
 * actually failed. Returns the number of rows cleared (0 or 1).
 *
 * Unlike `clearPmSyncConflictFlag` (which sets SUCCESS to re-arm auto-push), a
 * dismissed failure is cleared to `null`: the sync never succeeded, so claiming
 * SUCCESS would be dishonest. The item simply leaves the queue; it can return if
 * a future sync genuinely fails again. The durable terminal state for a deleted
 * card is Unlink (`applyPmUnlink`), which also severs the dead link.
 */
export async function clearPmSyncFailure(args: {
	itemType: PmSyncItemType;
	itemId: string;
	projectId: string;
}): Promise<{ cleared: number }> {
	if (args.itemType === "testCase") {
		// Test cases have no `clearPmSyncConflictFlag` path (that helper re-arms
		// story auto-push and is story-only), so Dismiss must clear a test-case
		// CONFLICT as well as a FAILED — the FE offers Dismiss on both.
		// Cleared to null (not SUCCESS): the push never succeeded / drift was only
		// dismissed, so claiming SUCCESS would be dishonest.
		const { count } = await db.testCase.updateMany({
			where: {
				id: args.itemId,
				projectId: args.projectId,
				lastPmSyncStatus: {
					in: [PmSyncStatus.FAILED, PmSyncStatus.CONFLICT],
				},
			},
			data: {
				lastPmSyncStatus: null,
				lastPmSyncError: null,
			},
		});
		return { cleared: count };
	}
	if (!isStoryItemType(args.itemType)) {
		return { cleared: 0 };
	}
	const { count } = await db.userStory.updateMany({
		where: {
			id: args.itemId,
			projectId: args.projectId,
			lastPmSyncStatus: PmSyncStatus.FAILED,
		},
		data: {
			lastPmSyncStatus: null,
			lastPmSyncError: null,
		},
	});
	return { cleared: count };
}

/**
 * Bulk counterpart to `clearPmSyncFailure`: dismiss the FAILED flag on many
 * work items in one atomic `updateMany`, scoped to the project and to
 * `lastPmSyncStatus = FAILED` (tenant guard + idempotent — already-cleared,
 * non-failed, or cross-tenant ids are silently skipped). Returns the number of
 * rows cleared.
 */
export async function clearPmSyncFailures(args: {
	projectId: string;
	itemIds: string[];
	/**
	 * Target table for the bulk dismiss. Defaults to `story` (`db.userStory`)
	 * so existing callers are unchanged; the test-case dismiss-batch passes
	 * `"testCase"` to clear `db.testCase` rows.
	 */
	itemType?: "story" | "testCase";
}): Promise<{ cleared: number }> {
	if (args.itemIds.length === 0) {
		return { cleared: 0 };
	}
	if (args.itemType === "testCase") {
		// Clear FAILED *and* CONFLICT for test cases — see clearPmSyncFailure.
		const { count } = await db.testCase.updateMany({
			where: {
				id: { in: args.itemIds },
				projectId: args.projectId,
				lastPmSyncStatus: {
					in: [PmSyncStatus.FAILED, PmSyncStatus.CONFLICT],
				},
			},
			data: {
				lastPmSyncStatus: null,
				lastPmSyncError: null,
			},
		});
		return { cleared: count };
	}
	const { count } = await db.userStory.updateMany({
		where: {
			id: { in: args.itemIds },
			projectId: args.projectId,
			lastPmSyncStatus: PmSyncStatus.FAILED,
		},
		data: {
			lastPmSyncStatus: null,
			lastPmSyncError: null,
		},
	});
	return { cleared: count };
}

/**
 * Write merged `title` and/or `description` onto a single work item (used
 * by the AI-merge accept path). Each field is optional and only the supplied
 * fields are written, so callers can apply a description-only, title-only, or
 * combined merge. The written content then flows to PM via the subsequent
 * force-push.
 *
 * (Supersedes the description-only `writePmSyncItemDescription`: the 2-way
 * AI-merge now reconciles the title alongside the description, so the original
 * D3a "keep Fabric's title" scoping no longer holds.)
 */
export async function writePmSyncItemContent(args: {
	itemType: PmSyncItemType;
	itemId: string;
	projectId: string;
	title?: string;
	description?: string;
	/**
	 * Last-edit provenance for the conflict-resolve path (AI-merge accept).
	 * `lastEditedByName` is the resolving user's display name. See spec §5
	 * path 4 / IN-3 / IN-6.
	 */
	lastEditedByName?: string | null;
	lastEditedSource?: LastEditSource;
}): Promise<void> {
	if (!isStoryItemType(args.itemType)) {
		return;
	}
	const current = await db.userStory.findUnique({
		where: { id: args.itemId, projectId: args.projectId },
		select: { title: true, description: true },
	});
	if (!current) {
		return;
	}
	const data: { title?: string; description?: string } = {};
	if (args.title !== undefined && args.title !== current.title) {
		data.title = args.title;
	}
	if (
		args.description !== undefined &&
		args.description !== current.description
	) {
		data.description = args.description;
	}
	if (Object.keys(data).length === 0) {
		return;
	}
	await db.userStory.update({
		where: { id: args.itemId, projectId: args.projectId },
		data: {
			...data,
			...(args.lastEditedSource !== undefined
				? {
						lastEditedAt: new Date(),
						lastEditedByName: args.lastEditedByName ?? null,
						lastEditedSource: args.lastEditedSource,
					}
				: {}),
		},
	});
}

/**
 * Read a single work item's `title`, scoped to its project (tenant guard).
 * Used to snapshot the entity title onto the resolution `PmSyncLog` row (the
 * row itself stores no title — Q4). Returns `null` when the item is absent so
 * the caller can fall back to an empty snapshot rather than throw.
 */
export async function getPmSyncItemTitle(args: {
	itemType: PmSyncItemType;
	itemId: string;
	projectId: string;
}): Promise<string | null> {
	if (!isStoryItemType(args.itemType)) {
		return null;
	}
	const row = await db.userStory.findFirst({
		where: { id: args.itemId, projectId: args.projectId },
		select: { title: true },
	});
	return row?.title ?? null;
}

/**
 * Re-stamp ONLY the `lastSyncedPmHash` baseline on a single work item —
 * no title/description change — behind the pull-drift "Dismiss" resolution.
 *
 * Dismiss is a real resolution, not a postpone: the user accepts the
 * divergence without mutating either side. Re-stamping the baseline to the
 * current ADO content hash is what makes the next hourly poll stop re-detecting
 * the same drift (`detectContentDrift` short-circuits when `adoHash ===
 * lastSyncedPmHash`). The hash is computed by the caller (the resolve
 * procedure) via `computePmHash` — `@repo/database` does not depend on
 * `@repo/temporal` where the hash lives.
 */
export async function stampPmSyncBaseline(args: {
	itemType: PmSyncItemType;
	itemId: string;
	projectId: string;
	newContentHash: string;
}): Promise<void> {
	if (!isStoryItemType(args.itemType)) {
		return;
	}
	await db.userStory.update({
		where: { id: args.itemId, projectId: args.projectId },
		data: { lastSyncedPmHash: args.newContentHash },
	});
}

/**
 * Apply ADO content (title + description) onto a single Fabric work item
 * — the net-new ADO→Fabric ingest primitive behind the pull-drift
 * "Apply (ADO → Fabric)" resolution.
 *
 * Effects (one atomic write per entity):
 * - Overwrites the entity's `title` + `description` with the supplied ADO
 *   values.
 * - Re-stamps `lastSyncedPmHash` to `newContentHash` (the §10 invariant — so the
 *   next hourly poll no longer reports drift against the applied content).
 *
 * `newContentHash` is computed by the **caller** (the resolve procedure) via
 * `computePmHash(title, description)` — `@repo/database` must not depend on
 * `@repo/temporal` where the hash lives, so the hash is passed in.
 *
 * STORY (and `bug`, which is persisted as a `UserStory`) additionally snapshots
 * a new `FeatureVersion` before the update — parity with `applyHide`'s version
 * bump — and bumps `version`. Tenant XOR is honored via `userId` +
 * `organizationId` (personal context = `organizationId: null`).
 */
export async function applyAdoContentToFabricItem(args: {
	itemType: PmSyncItemType;
	itemId: string;
	projectId: string;
	title: string;
	description: string | null;
	newContentHash: string;
	userId: string;
	organizationId: string | null;
	lastEditedByName?: string | null;
}): Promise<void> {
	const {
		itemType,
		itemId,
		projectId,
		title,
		description,
		newContentHash,
		userId,
		organizationId,
	} = args;

	if (!isStoryItemType(itemType)) {
		return;
	}

	const story = await db.userStory.findUnique({
		where: { id: itemId, projectId },
		select: {
			id: true,
			title: true,
			version: true,
			description: true,
			acceptanceCriteria: true,
			draftingStage: true,
		},
	});
	if (!story) {
		return;
	}

	const newVersion = (story.version ?? 1) + 1;
	const contentChanged =
		title !== story.title || description !== story.description;

	// Snapshot the story's CURRENT content + stage before overwriting.
	// Content-only ingest does not change the drafting stage, so the
	// snapshot must preserve the story's actual stage (mirrors
	// `restoreFeatureVersion`) — never a hardcoded value, which would
	// corrupt the stage if the user later restores this version.
	if (contentChanged) {
		await createFeatureVersion({
			storyId: story.id,
			version: newVersion,
			description: story.description ?? null,
			acceptanceCriteria: story.acceptanceCriteria ?? null,
			draftingStage: story.draftingStage as FeatureDraftingStage,
			changeDescription:
				"ADO content sync: applied PM tool's title/description",
			changedBy: userId,
			userId,
			organizationId: organizationId ?? undefined,
		});
	}

	await db.userStory.update({
		where: { id: itemId, projectId },
		data: {
			lastSyncedPmHash: newContentHash,
			...(contentChanged
				? {
						title,
						description,
						version: newVersion,
						lastEditedAt: new Date(),
						lastEditedByName: args.lastEditedByName ?? null,
						lastEditedSource: "PM_PULL" as const,
					}
				: {}),
		},
	});
}
