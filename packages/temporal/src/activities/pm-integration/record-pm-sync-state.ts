import { db, PmSyncStatus } from "@repo/database";
import { logger } from "@repo/logs";
import { humanizePmSyncError } from "./humanize-pm-sync-error";
import { recordPmSyncLog } from "./record-pm-sync-log";

const ERROR_FIELD_MAX = 500;

function truncate(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

/**
 * Work-item type for PM-sync state writes. Stories and bugs share the
 * `userStory` table — the only work-item table since the Epic/Feature folder
 * tables were dropped. `epic`/`feature` remain in the union for wire
 * compatibility with persisted Temporal histories; they are no-ops here.
 * `testCase` writes to the separate `test_case` table (QA feature).
 */
export type PmSyncItemType = "epic" | "feature" | "story" | "bug" | "testCase";

export interface RecordPmSyncFailureInput {
	itemId: string;
	itemType: PmSyncItemType;
	errorMessage: string;
	errorClass: string;
	triggerSource: "ai-update" | "manual-edit" | "retry";
	/**
	 * PM tool slug (e.g. "azure-devops"). Optional — the workflow catch paths
	 * that call this activity don't currently thread it, so when absent we
	 * derive it from the synced item's `externalMcpServerId` (MCPServer.key)
	 * and fall back to "unknown".
	 */
	pmTool?: string;
	/** User who triggered the push; null for system / poll-driven runs. */
	actorUserId?: string | null;
}

/**
 * Map a sync item type to the `PmSyncLog` `entityType` value. Bugs are
 * `UserStory` rows and log as `STORY`; there is NO `TASK` value.
 * Test cases log as `TEST_CASE`.
 */
function itemTypeToLogEntityType(
	itemType: PmSyncItemType,
): "EPIC" | "FEATURE" | "STORY" | "TEST_CASE" {
	switch (itemType) {
		case "epic":
			return "EPIC";
		case "feature":
			return "FEATURE";
		case "story":
		case "bug":
			return "STORY";
		case "testCase":
			return "TEST_CASE";
	}
}

/**
 * Snapshot the synced item (title, external refs, tenant) for the FAILURE log
 * row. Returns `null` when the row is gone (e.g. deleted mid-sync) so the
 * caller can skip the log without erroring. The pmTool is resolved from the
 * row's `externalMcpServerId` → MCPServer.key when the caller didn't supply
 * one.
 */
async function loadFailureLogContext(
	itemId: string,
	itemType: PmSyncItemType,
): Promise<{
	title: string;
	externalId: string | null;
	externalUrl: string | null;
	projectId: string | null;
	organizationId: string | null;
	userId: string | null;
	mcpServerKey: string | null;
} | null> {
	// Test cases live in their own table; resolve their failure-log context the
	// same way (title + external refs + tenant). `project` carries the XOR
	// discriminator (organizationId set → org, null → personal).
	if (itemType === "testCase") {
		const tc = await db.testCase.findUnique({
			where: { id: itemId },
			select: {
				title: true,
				externalId: true,
				externalUrl: true,
				projectId: true,
				project: { select: { organizationId: true, userId: true } },
				externalMcpServerId: true,
			},
		});
		if (!tc) {
			return null;
		}
		let testCaseMcpServerKey: string | null = null;
		if (tc.externalMcpServerId) {
			const server = await db.mCPServer.findUnique({
				where: { id: tc.externalMcpServerId },
				select: { key: true },
			});
			testCaseMcpServerKey = server?.key ?? null;
		}
		return {
			title: tc.title,
			externalId: tc.externalId,
			externalUrl: tc.externalUrl,
			projectId: tc.projectId,
			organizationId: tc.project.organizationId,
			userId: tc.project.userId,
			mcpServerKey: testCaseMcpServerKey,
		};
	}

	// Stories are the only other work-item rows (Epic/Feature folder tables were
	// dropped); legacy epic/feature item types resolve to "row gone". Project
	// always has a `userId`; `organizationId` is the XOR discriminator (set →
	// org context, null → personal).
	if (itemType !== "story" && itemType !== "bug") {
		return null;
	}

	const row = await db.userStory.findUnique({
		where: { id: itemId },
		select: {
			title: true,
			externalId: true,
			externalUrl: true,
			projectId: true,
			project: { select: { organizationId: true, userId: true } },
			externalMcpServerId: true,
		},
	});
	if (!row) {
		return null;
	}
	const { title, externalId, externalUrl, projectId } = row;
	const organizationId = row.project.organizationId;
	const userId = row.project.userId;
	const externalMcpServerId = row.externalMcpServerId;

	let mcpServerKey: string | null = null;
	if (externalMcpServerId) {
		const server = await db.mCPServer.findUnique({
			where: { id: externalMcpServerId },
			select: { key: true },
		});
		mcpServerKey = server?.key ?? null;
	}

	return {
		title,
		externalId,
		externalUrl,
		projectId,
		organizationId,
		userId,
		mcpServerKey,
	};
}

/**
 * Persist a FAILED PM sync state on a hierarchy item after an activity throws.
 *
 * Called from the workflow's catch path (workflows cannot reach Prisma
 * directly). Dispatches to `epic`, `feature`, or `userStory` based on
 * `itemType`.
 */
export async function recordPmSyncFailure(
	input: RecordPmSyncFailureInput,
): Promise<void> {
	const { itemId, itemType, errorMessage, errorClass, triggerSource } = input;
	const now = new Date();
	// Translate known-cryptic PM errors (e.g. Atlassian "cloud id isn't
	// granted") into actionable guidance before persisting, so the
	// "PM sync failed" panel tells the user how to fix it. Unknown errors
	// pass through unchanged.
	const humanizedError = humanizePmSyncError(errorMessage);
	const data = {
		lastPmSyncStatus: PmSyncStatus.FAILED,
		lastPmSyncError: truncate(humanizedError, ERROR_FIELD_MAX),
		lastPmSyncAttemptAt: now,
	};
	try {
		// Legacy epic/feature item types have no row to stamp (folder tables
		// dropped) — the failure is still logged below for observability.
		if (itemType === "story" || itemType === "bug") {
			await db.userStory.update({ where: { id: itemId }, data });
		} else if (itemType === "testCase") {
			await db.testCase.update({ where: { id: itemId }, data });
		}
		logger.info("pm.sync.failed", {
			itemId,
			itemType,
			errorClass,
			message: truncate(errorMessage, ERROR_FIELD_MAX),
			triggerSource,
			occurredAt: now.toISOString(),
		});
	} catch (error) {
		logger.warn("[PM Sync] recordPmSyncFailure write failed", {
			itemId,
			itemType,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	// Append-only audit row for the FAILURE outcome. Snapshot the
	// item + tenant from the DB since the workflow catch path doesn't thread
	// them. NON-FATAL: `recordPmSyncLog` swallows its own write errors, so this
	// never affects the FAILED state already persisted above.
	const ctx = await loadFailureLogContext(itemId, itemType);
	if (ctx) {
		await recordPmSyncLog({
			direction: "push",
			entityType: itemTypeToLogEntityType(itemType),
			entityId: itemId,
			title: ctx.title,
			pmTool: input.pmTool ?? ctx.mcpServerKey ?? "unknown",
			status: "FAILURE",
			errorPayload: {
				errorClass,
				errorMessage: truncate(humanizedError, ERROR_FIELD_MAX),
				triggerSource,
			},
			actorUserId: input.actorUserId ?? null,
			externalId: ctx.externalId,
			externalUrl: ctx.externalUrl,
			organizationId: ctx.organizationId,
			userId: ctx.organizationId ? null : ctx.userId,
			projectId: ctx.projectId,
		});
	}
}

export interface RecordPmSyncSuccessStateInput {
	itemId: string;
	itemType: PmSyncItemType;
}

/**
 * Stamp a SUCCESS PM-sync state on a hierarchy item after a successful push,
 * clearing any stale FAILED badge + error left by a prior failed attempt.
 *
 * The single-story push path (`syncStoryToPM`) persists the new external link
 * but never reset the sync-status fields, so a `FAILED` badge written by an
 * earlier attempt (e.g. a push against a previously-configured PM tool) stayed
 * on the card even after the next push succeeded. This clears it.
 *
 * Deliberately does NOT write `lastSyncedPmHash`: `syncStoryToPM` transforms the
 * body per PM tool (HTML / ADF / Fizzy embeds) and that transformed body isn't
 * available at the call site, so a hash computed from the raw content would
 * mismatch the PM read-back and raise a false CONTENT_DRIFT. A null baseline is
 * safely skipped by the drift detectors, so establishing it here is a separate
 * concern. (`stampPmSyncSuccess` in hierarchy-sync handles the auto-push path,
 * where the transformed body IS in scope.)
 *
 * NON-FATAL: the PM ticket already exists when this runs, so any failure here —
 * the DB write OR building the payload — must not turn a real success into a
 * reported failure. The whole body (including reading `PmSyncStatus`) is inside
 * the try so it swallows + warns rather than propagating to the push caller's
 * catch, mirroring `recordPmSyncFailure`.
 */
export async function recordPmSyncSuccessState(
	input: RecordPmSyncSuccessStateInput,
): Promise<void> {
	try {
		const now = new Date();
		const data = {
			lastPmSyncStatus: PmSyncStatus.SUCCESS,
			lastPmSyncError: null,
			lastPmSyncAttemptAt: now,
			lastSyncedAt: now,
		};
		// Legacy epic/feature item types are no-ops (folder tables dropped).
		if (input.itemType === "story" || input.itemType === "bug") {
			await db.userStory.update({
				where: { id: input.itemId },
				data,
			});
		} else if (input.itemType === "testCase") {
			await db.testCase.update({
				where: { id: input.itemId },
				data,
			});
		}
	} catch (error) {
		logger.warn("[PM Sync] recordPmSyncSuccessState write failed", {
			itemId: input.itemId,
			itemType: input.itemType,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export interface ClearPmSyncPendingInput {
	itemId: string;
	itemType: PmSyncItemType;
}

/**
 * Clear a stuck `PENDING` row at the workflow boundary's `finally`.
 *
 * Only clears when the row is still PENDING — preserves SUCCESS / CONFLICT /
 * FAILED states already written by the happy path.
 */
export async function clearPmSyncPendingIfLeaked(
	input: ClearPmSyncPendingInput,
): Promise<void> {
	const where = {
		id: input.itemId,
		lastPmSyncStatus: PmSyncStatus.PENDING,
	};
	const data = {
		lastPmSyncStatus: null,
		lastPmSyncAttemptAt: new Date(),
	};
	try {
		// Legacy epic/feature item types are no-ops (folder tables dropped).
		if (input.itemType === "story" || input.itemType === "bug") {
			await db.userStory.updateMany({ where, data });
		} else if (input.itemType === "testCase") {
			await db.testCase.updateMany({ where, data });
		}
	} catch (error) {
		logger.warn("[PM Sync] clearPmSyncPendingIfLeaked failed", {
			itemId: input.itemId,
			itemType: input.itemType,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
