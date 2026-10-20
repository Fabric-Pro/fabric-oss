import { db, PmSyncStatus, type Prisma } from "@repo/database";
import { logger } from "@repo/logs";
import { humanizePmSyncError } from "./humanize-pm-sync-error";
import {
	writePmSyncRunStatus,
	writePmSyncStatusForAttempt,
	writePmSyncStatusUnattempted,
} from "./pm-sync-attempt-fence";
import { redactDatabaseErrorText } from "./pm-sync-user-error";
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
	direction?: "push" | "pull";
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
	/**
	 * When set, the FAILED write applies only while the row is still PENDING
	 * for this attempt (`attemptId: null` matches a row stamped before attempt
	 * ids existed), and no audit row is written when it does not apply. The
	 * stuck-sync watchdog passes the attempt it scanned so a run that settled
	 * the row, or a newer enqueue, since the scan is not overwritten. The
	 * workflows' own calls use `onlyIfAttempt` instead.
	 */
	onlyIfPendingAttempt?: { attemptId: string | null };
	/**
	 * The attempt id of the run making this write. When set, the FAILED
	 * write applies only while the row still names this attempt (whatever
	 * its status), and no audit row is written when it does not: a newer
	 * enqueue's PENDING is left alone. Unset (a run that carries no attempt
	 * id), the write skips a row that is PENDING for an attempt, which an
	 * attempted run or the stuck-sync watchdog settles, and writes no audit
	 * row then; any other row is written by id.
	 */
	onlyIfAttempt?: string;
	/**
	 * Write by id whatever the row's state, with no attempt fence at all.
	 * Only for a create that may have left an unlinked ticket
	 * (`create_orphan`, `create_unconfirmed`, through `pm-create-orphan.ts`):
	 * that FAILED tells the user a ticket may already exist and keeps the
	 * stuck-sync watchdog from retrying the row into a second ticket, so a
	 * PENDING attempt must not make it skip.
	 */
	overridePendingAttempt?: boolean;
	/**
	 * With `overridePendingAttempt`, for `create_unconfirmed` only: the
	 * FAILED write applies only while the row is still unlinked
	 * (`externalId` null) and its create claim is held (`pmCreateClaimId` not
	 * null), checked in the same conditional UPDATE. A row linked since the
	 * caller's claim attempt, or whose claim was cleared, is not written and
	 * gets no audit row; the call resolves `false` then, and also when the
	 * write fails (whether the row matched is unknown).
	 */
	onlyIfCreateClaimHeld?: boolean;
	/**
	 * With `onlyIfCreateClaimHeld`, narrows it: the held claim must be this
	 * one (`pmCreateClaimId` equal), not any. For a caller whose failure is
	 * about its own create (the bulk create's `create_orphan`), so a claim
	 * another create took after Unlink & re-create is not stamped. Ignored
	 * without `onlyIfCreateClaimHeld`.
	 */
	onlyIfCreateClaimId?: string;
	/**
	 * Narrow a failure to the link and attempt the caller read. With
	 * `onlyIfAttempt` for a test case, the snapshot also fences that attempt's write.
	 * Without an attempt id, the row must additionally not be PENDING for
	 * an attempt (`writePmSyncStatusUnattempted`). A relink or newer enqueue
	 * keeps its state. No audit row is written when the predicate misses or
	 * the write fails. Ignored when `onlyIfPendingAttempt` is set, or when
	 * `onlyIfAttempt` is set for a story or bug.
	 * `externalUrl`, when given, is required too, so a replacement link with
	 * the same id cannot receive a failure judged from the previous URL.
	 */
	onlyIfRowUnchanged?: {
		externalId: string | null;
		externalMcpServerId: string | null;
		externalPmTarget?: string | null;
		lastPmSyncAttemptId: string | null;
		externalUrl?: string | null;
	};
	/**
	 * For a failure about one PM create whose claim the caller took (the
	 * test-case create's definite rejection): on top of the attempt scoping
	 * (`onlyIfAttempt`, or the no-attempt rule), the FAILED write applies
	 * only while the row is unlinked and still holds this claim, checked in
	 * the same UPDATE. A row another create has claimed or linked since keeps
	 * its state. Resolves `false`, with no audit row, when it does not apply
	 * or the write fails. Not used with `onlyIfPendingAttempt` or
	 * `overridePendingAttempt`.
	 */
	onlyWhileHoldingCreateClaim?: string;
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
 *
 * Resolves `false` when a fence did not match the row
 * (`onlyIfPendingAttempt`: no longer PENDING for that attempt;
 * `onlyIfAttempt`: a newer attempt owns the row; `onlyIfRowUnchanged`: the
 * link or attempt changed since the caller read the row, or the row is
 * PENDING for an attempt; `onlyIfCreateClaimHeld`: the row is linked or
 * its create claim (with `onlyIfCreateClaimId`, that claim) is not held;
 * none of these, nor `overridePendingAttempt`: the row is PENDING for an
 * attempt, or gone): nothing written, no audit
 * row. `true` otherwise. A failed state write is logged and swallowed,
 * except under `onlyIfPendingAttempt`, where it is rethrown so the watchdog
 * can retry, and under `onlyIfRowUnchanged` or `onlyIfCreateClaimHeld`,
 * where it resolves `false` with no audit row. A failed audit row (the context read or the log write) is
 * logged and swallowed for every caller.
 */
export async function recordPmSyncFailure(
	input: RecordPmSyncFailureInput,
): Promise<boolean> {
	const { itemId, itemType, errorMessage, errorClass, triggerSource } = input;
	const now = new Date();
	// Replace database error text first, then translate cryptic PM errors
	// (e.g. Atlassian "cloud id isn't granted") into actionable guidance
	// before persisting to the "PM sync failed" panel. Other messages
	// pass through unchanged.
	const humanizedError = humanizePmSyncError(
		redactDatabaseErrorText(errorMessage, errorClass),
	);
	const data = {
		lastPmSyncStatus: PmSyncStatus.FAILED,
		lastPmSyncError: truncate(humanizedError, ERROR_FIELD_MAX),
		lastPmSyncAttemptAt: now,
	};
	try {
		// Legacy epic/feature item types have no row to stamp (folder tables
		// dropped) — the failure is still logged below for observability.
		const fence = input.onlyIfPendingAttempt;
		if (fence) {
			const where = {
				id: itemId,
				lastPmSyncStatus: PmSyncStatus.PENDING,
				lastPmSyncAttemptId: fence.attemptId,
			};
			const result =
				itemType === "testCase"
					? await db.testCase.updateMany({ where, data })
					: itemType === "story" || itemType === "bug"
						? await db.userStory.updateMany({ where, data })
						: { count: 0 };
			if (result.count === 0) {
				return false;
			}
		} else if (input.onlyIfAttempt !== undefined) {
			const wrote = await writePmSyncStatusForAttempt({
				itemType,
				itemId,
				attemptId: input.onlyIfAttempt,
				onlyIfRowUnchanged:
					itemType === "testCase"
						? input.onlyIfRowUnchanged
						: undefined,
				data,
				onlyWhileHoldingCreateClaim: input.onlyWhileHoldingCreateClaim,
			});
			if (!wrote) {
				logger.info("pm.sync.failed.superseded", {
					itemId,
					itemType,
					errorClass,
					attemptId: input.onlyIfAttempt,
				});
				return false;
			}
		} else if (
			input.overridePendingAttempt &&
			input.onlyIfCreateClaimHeld
		) {
			const where = {
				id: itemId,
				externalId: null,
				pmCreateClaimId: input.onlyIfCreateClaimId ?? { not: null },
			};
			const result =
				itemType === "testCase"
					? await db.testCase.updateMany({ where, data })
					: itemType === "story" || itemType === "bug"
						? await db.userStory.updateMany({ where, data })
						: { count: 0 };
			if (result.count === 0) {
				logger.info("pm.sync.failed.yielded", {
					itemId,
					itemType,
					errorClass,
					reason: "linked-or-unclaimed",
				});
				return false;
			}
		} else if (input.overridePendingAttempt) {
			if (itemType === "story" || itemType === "bug") {
				await db.userStory.update({ where: { id: itemId }, data });
			} else if (itemType === "testCase") {
				await db.testCase.update({ where: { id: itemId }, data });
			}
		} else if (
			itemType === "story" ||
			itemType === "bug" ||
			itemType === "testCase"
		) {
			// A run without an attempt id: kept off a row that is PENDING for
			// an attempt, and, with `onlyIfRowUnchanged`, also scoped to the
			// row as the caller read it.
			const snapshot = input.onlyIfRowUnchanged;
			const wrote = await writePmSyncStatusUnattempted({
				itemType,
				itemId,
				data,
				...(snapshot ? { onlyIfRowUnchanged: snapshot } : {}),
				onlyWhileHoldingCreateClaim: input.onlyWhileHoldingCreateClaim,
			});
			if (!wrote) {
				logger.info("pm.sync.failed.yielded", {
					itemId,
					itemType,
					errorClass,
					...(snapshot
						? { reason: "row-changed-or-attempt-pending" }
						: {}),
				});
				return false;
			}
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
		// A fenced caller (the watchdog) retries the whole call; the fence
		// makes that safe, and no audit row claims a write that did not land.
		if (input.onlyIfPendingAttempt) {
			throw error;
		}
		// Whether the row still matched is unknown, so no audit row claims a
		// failure the row may not carry.
		if (
			input.onlyIfRowUnchanged &&
			(input.onlyIfAttempt === undefined || itemType === "testCase")
		) {
			return false;
		}
		if (input.overridePendingAttempt && input.onlyIfCreateClaimHeld) {
			return false;
		}
		if (input.onlyWhileHoldingCreateClaim !== undefined) {
			return false;
		}
	}

	await recordPmSyncFailureLog(input);
	return true;
}

/**
 * The append-only FAILURE row in the sync log, with no write to the item's
 * state. Snapshots the item and tenant from the DB, since the workflow catch
 * path doesn't thread them. `link` names the PM item the failure is about
 * when it is not the row's stored link (an orphaned create whose row now
 * carries another link); unset, the row's link is logged.
 *
 * Best effort: the row state is what matters, and a throw from here would
 * turn a recorded failure into a failed activity (for the create-orphan
 * callers, into a retry that creates a second ticket). `recordPmSyncLog`
 * swallows its own write errors; the context read is guarded here.
 */
export async function recordPmSyncFailureLog(
	input: Pick<
		RecordPmSyncFailureInput,
		| "itemId"
		| "itemType"
		| "errorMessage"
		| "errorClass"
		| "triggerSource"
		| "pmTool"
		| "actorUserId"
		| "direction"
	> & { link?: { externalId: string | null; externalUrl: string | null } },
): Promise<void> {
	const { itemId, itemType, errorClass, triggerSource } = input;
	try {
		const ctx = await loadFailureLogContext(itemId, itemType);
		if (ctx) {
			await recordPmSyncLog({
				direction: input.direction ?? "push",
				entityType: itemTypeToLogEntityType(itemType),
				entityId: itemId,
				title: ctx.title,
				pmTool: input.pmTool ?? ctx.mcpServerKey ?? "unknown",
				status: "FAILURE",
				errorPayload: {
					errorClass,
					errorMessage: truncate(
						humanizePmSyncError(
							redactDatabaseErrorText(
								input.errorMessage,
								errorClass,
							),
						),
						ERROR_FIELD_MAX,
					),
					triggerSource,
				},
				actorUserId: input.actorUserId ?? null,
				externalId: input.link ? input.link.externalId : ctx.externalId,
				externalUrl: input.link
					? input.link.externalUrl
					: ctx.externalUrl,
				organizationId: ctx.organizationId,
				userId: ctx.organizationId ? null : ctx.userId,
				projectId: ctx.projectId,
			});
		}
	} catch (error) {
		logger.warn("[PM Sync] recordPmSyncFailure audit row skipped", {
			itemId,
			itemType,
			errorClass,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export interface RecordPmSyncSuccessStateInput {
	itemId: string;
	itemType: PmSyncItemType;
	/**
	 * The attempt id of the run making this write. `lastSyncedAt` (the push
	 * happened) is always written by id. When set, the SUCCESS status lands
	 * only while the row still names this attempt, so a newer enqueue's
	 * PENDING is left alone. Unset, it lands unless the row is PENDING for an
	 * attempt (`writePmSyncStatusUnattempted`).
	 */
	pmSyncAttemptId?: string;
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
		await writePmSyncSuccessState(input);
	} catch (error) {
		logger.warn("[PM Sync] recordPmSyncSuccessState write failed", {
			itemId: input.itemId,
			itemType: input.itemType,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * The writes behind `recordPmSyncSuccessState`, through `client` (a caller's
 * transaction, or `db`): `lastSyncedAt` by id, then the SUCCESS status under
 * the attempt fence (`writePmSyncRunStatus`). Resolves whether the status
 * landed; `false` also for the legacy epic/feature types. A database error
 * propagates, so a caller's transaction rolls back with it.
 */
export async function writePmSyncSuccessState(
	input: RecordPmSyncSuccessStateInput,
	client: Prisma.TransactionClient = db,
): Promise<boolean> {
	// Legacy epic/feature item types are no-ops (folder tables dropped).
	const { itemType } = input;
	if (itemType !== "story" && itemType !== "bug" && itemType !== "testCase") {
		return false;
	}
	const now = new Date();
	const status = {
		lastPmSyncStatus: PmSyncStatus.SUCCESS,
		lastPmSyncError: null,
		lastPmSyncAttemptAt: now,
	};
	// The push happened, so its timestamp is recorded by id whoever owns
	// the row's status now; only the status write is fenced.
	const synced = { lastSyncedAt: now };
	if (itemType === "testCase") {
		await client.testCase.update({
			where: { id: input.itemId },
			data: synced,
		});
	} else {
		await client.userStory.update({
			where: { id: input.itemId },
			data: synced,
		});
	}
	const wrote = await writePmSyncRunStatus({
		itemType,
		itemId: input.itemId,
		attemptId: input.pmSyncAttemptId,
		data: status,
		client,
	});
	if (!wrote) {
		logger.info("pm.sync.success.superseded", {
			itemId: input.itemId,
			itemType,
			attemptId: input.pmSyncAttemptId,
		});
	}
	return wrote;
}

export interface ClearPmSyncPendingInput {
	itemId: string;
	itemType: PmSyncItemType;
	/**
	 * The attempt id the run synced under. Set, only that attempt's PENDING is
	 * cleared. Unset (backlog apply, histories from before attempt ids were
	 * passed), only a PENDING that no attempt owns (`lastPmSyncAttemptId`
	 * null, a row stamped before attempt ids existed) is cleared.
	 */
	attemptId?: string;
	/**
	 * Clear a PENDING whichever attempt stamped it (`attemptId` is then
	 * ignored). The story workflow sets this only after an orphaned create
	 * (a ticket created but not linked): an attempt that attached to that run
	 * must not stay PENDING, or the stuck-sync watchdog would retry it
	 * against the unlinked row and create a second ticket.
	 */
	anyAttempt?: boolean;
}

/**
 * Clear a stuck `PENDING` row at the workflow boundary's `finally`.
 *
 * Only clears when the row is still PENDING — preserves SUCCESS / CONFLICT /
 * FAILED states already written by the happy path — and only for the
 * caller's own attempt. The writers that stamp PENDING all write an attempt
 * id with it (the enqueues through `newPmSyncPendingStamp`, and the
 * duplicate-merge transfer in `duplicate-links.ts`), so a PENDING carrying
 * another attempt id belongs to an enqueue whose sync has not settled yet;
 * clearing it would also hide it from the stuck-sync watchdog, which scans
 * for PENDING rows. `anyAttempt` drops the attempt match, after an orphaned
 * create only (see the field).
 */
export async function clearPmSyncPendingIfLeaked(
	input: ClearPmSyncPendingInput,
): Promise<void> {
	const where = {
		id: input.itemId,
		lastPmSyncStatus: PmSyncStatus.PENDING,
		...(input.anyAttempt
			? {}
			: { lastPmSyncAttemptId: input.attemptId ?? null }),
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
