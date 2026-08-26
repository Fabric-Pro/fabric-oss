/**
 * Attachment retention-purge activity (#1702 Part 5).
 *
 * Permanently deletes StoryAttachment rows soft-deleted (deletedAt set) longer
 * ago than their tenant's retention window, plus their R2 objects. The window
 * cascades project -> organization -> FABRIC_ATTACHMENT_RETENTION_DAYS (default
 * 90); see #1749. Eligibility is decided in code, not in the WHERE clause: the
 * indexed scan is bounded by the SMALLEST window configured anywhere (so it is
 * a superset of what is purgeable), then each page is attributed to its project
 * and filtered.
 *
 * OBJECT-FIRST, then row (the one inversion of the system-wide row-before-object
 * rule): delete each page's objects, then delete ONLY the rows
 * whose object delete succeeded. A row whose object delete errored keeps its row
 * (and its @unique storageKey reservation) and is retried next run — the key is
 * never freed while its object still exists, so no createAttachment replay can
 * re-bind it (closes the purge-time key-reuse race) and the purge produces no
 * orphan (self-healing, independent of the #1756 sweep).
 *
 * Keyset pagination (id > lastId): error rows are intentionally left behind, so
 * deletion can't advance the window — and a Prisma `cursor` can't be used either
 * (the cursor row is often one of the rows we just deleted). A keyset predicate
 * (`id: { gt: lastId }`) compares VALUES, never requires the boundary row to
 * exist, and guarantees termination even on an all-errored run.
 *
 * This purge always runs on its configured schedule (schedules.ts) — there is
 * no enablement flag.
 */

import { config } from "@repo/config";
import {
	db,
	getMinimumAttachmentRetentionOverride,
	resolveAttachmentRetentionOverrides,
} from "@repo/database";
import { logger } from "@repo/logs";
import { deleteObjects } from "@repo/storage";
import {
	ATTACHMENT_RETENTION_GRACE_DAYS,
	DEFAULT_ATTACHMENT_RETENTION_DAYS,
	MAX_ATTACHMENT_RETENTION_DAYS,
	sanitizeRetentionDays,
} from "@repo/utils/attachment";
import { safeHeartbeat } from "./lib/activity-liveness";

const MS_PER_DAY = 86_400_000;
const FINAL_PREFIX = "story-attachments/";
const PAGE_SIZE = 1000;
const MAX_PAGES = 100_000; // runaway/infinite-loop guard
const MAX_DELETIONS = 2_000; // per-run destructive bound — counts successful object deletes
const MAX_ERRORS = 500;

export interface PurgeExpiredAttachmentsResult {
	/**
	 * Row VISITS by the scan, expired or not — not distinct rows. When the
	 * deletion budget truncates a page, the keyset rewinds to the last processed
	 * row and the page's remainder is visited again on the next iteration,
	 * counting twice. Distinct-row accounting would need a second counter and
	 * buys nothing: these figures exist to tell "the sweep filtered a lot" apart
	 * from "the sweep is broken", and both readings serve that.
	 */
	scanned: number;
	/**
	 * Visits found eligible — past their window and clear of the grace floor.
	 * Together with the three counters below this partitions `scanned`:
	 * `scanned === expiredCandidates + filteredOut + skippedUnattributed +
	 * skippedUnresolved`. Eligible is not the same as deleted: the per-run budget
	 * or a failed object delete can leave a candidate for the next run.
	 */
	expiredCandidates: number;
	/** Visits that were attributed and resolved but not yet eligible. */
	filteredOut: number;
	/** Visits whose storageKey named no project — never deleted. */
	skippedUnattributed: number;
	/** Visits whose project the resolver did not return — never deleted. */
	skippedUnresolved: number;
	deletedRows: number;
	deletedObjects: number;
	objectErrors: number;
	errorsTruncated: boolean;
	pages: number;
	hitDeletionCap: boolean;
	hitRunawayGuard: boolean;
	/**
	 * The scan bound. NOT `now - retentionDays`: once any tenant overrides,
	 * those two describe different things and must never be read as a pair.
	 */
	cutoffAt: string;
	/** The smallest effective window anywhere; what `cutoffAt` is derived from. */
	minWindowDays: number;
	/** The server-default tier of the cascade, for reference only. */
	retentionDays: number;
	/**
	 * Which windows actually did the work, ascending by `windowDays`. The point of
	 * a per-tenant policy is that "deleted 40 rows" is no longer a full answer —
	 * this says whether a shortened window is being honoured or everything is
	 * still coming out at the server default.
	 *
	 * `deleted` counts rows SUBMITTED to a successful `deleteMany` after their
	 * object was positively accounted as gone, so it equals `deletedRows` in total
	 * unless a concurrent cascade had already removed a row (`deleteMany` reports
	 * a count, not which ids it matched, and splitting the call per window to
	 * recover that would change the delete shape this activity is pinned to).
	 */
	windowsApplied: { windowDays: number; deleted: number }[];
}

/** Read FABRIC_ATTACHMENT_RETENTION_DAYS. Unset/NaN/<1 (after floor) -> 90. */
function readRetentionDays(): number {
	const raw =
		process.env.FABRIC_ATTACHMENT_RETENTION_DAYS ??
		String(DEFAULT_ATTACHMENT_RETENTION_DAYS);
	// Floor to whole days (mirrors audit-log-retention) so a fractional value can't
	// produce a surprising partial-day cutoff. Require >= 1 whole day AFTER flooring,
	// so a sub-1 value (e.g. "0.5" -> floor 0) can't collapse the cutoff to "now" and
	// purge everything — fall back to the safe default instead.
	//
	// The accepted range is 1..MAX_ATTACHMENT_RETENTION_DAYS, deliberately NOT the
	// tenant floor of 30: this variable is an operator-level deployment control and
	// #1702's runbook documents lowering it to 1 as the emergency drain. The
	// consequence is that its result must NEVER be passed through
	// sanitizeRetentionDays — that floor would silently rewrite an emergency 1 to 90.
	const parsed = Math.floor(Number(raw));
	if (!Number.isFinite(parsed) || parsed < 1) {
		return DEFAULT_ATTACHMENT_RETENTION_DAYS;
	}
	return Math.min(MAX_ATTACHMENT_RETENTION_DAYS, parsed);
}

/**
 * Derive the owning projectId from a final attachment storage key.
 *
 * The key format `story-attachments/{projectId}/{storyId}/{uuid}.{ext}` is
 * already load-bearing elsewhere — project deletion sweeps R2 by the
 * `story-attachments/{projectId}/` prefix. Parsing it here avoids joining the
 * `story` relation, which Prisma reads as a SEPARATE statement (relationJoins is
 * not enabled): a story cascade-deleted between the two statements raises
 * "Inconsistent query result" for a required relation, which this activity
 * rethrows — and the workflow is maximumAttempts: 1, so one racing story
 * deletion would cost the entire nightly run.
 *
 * Returns null for anything that is not a final attachment key, including the
 * `story-attachments-tmp/` prefix. The caller SKIPS such rows: a row we cannot
 * attribute to a tenant is a row we must not delete.
 */
export function parseProjectIdFromStorageKey(key: string): string | null {
	if (!key.startsWith(FINAL_PREFIX)) {
		return null;
	}
	const rest = key.slice(FINAL_PREFIX.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) {
		return null;
	}
	const projectId = rest.slice(0, slash);
	// The remainder must contain at least `{storyId}/{file}`.
	return rest.indexOf("/", slash + 1) > slash + 1 ? projectId : null;
}

/**
 * Whether a soft-deleted attachment has outlived its window.
 *
 * `retentionDays` MUST be a positive integer. The caller guarantees it via
 * `sanitizeRetentionDays(...) ?? serverDefault`, and both terms are positive by
 * construction, so there is deliberately NO in-function guard here — an earlier
 * draft carried one that said "sub-1 means keep forever" while the sanitizer
 * said "sub-1 means use the default", two rules with opposite outcomes and a
 * passing test each.
 */
export function hasExpired(input: {
	deletedAt: Date;
	retentionDays: number;
	now: number;
}): boolean {
	return (
		input.now - input.deletedAt.getTime() > input.retentionDays * MS_PER_DAY
	);
}

/**
 * Whether a row may actually be deleted: expired AND clear of the grace floor.
 *
 * The grace floor only ever DELAYS eligibility, never advances it, which is why
 * it cannot break the scan-bound superset property.
 */
export function isPurgeable(input: {
	deletedAt: Date | null;
	retentionDays: number;
	settingChangedAt: Date | null;
	now: number;
}): boolean {
	if (input.deletedAt === null) {
		return false;
	}
	if (
		!hasExpired({
			deletedAt: input.deletedAt,
			retentionDays: input.retentionDays,
			now: input.now,
		})
	) {
		return false;
	}
	if (input.settingChangedAt !== null) {
		const graceEnds =
			input.settingChangedAt.getTime() +
			ATTACHMENT_RETENTION_GRACE_DAYS * MS_PER_DAY;
		if (input.now <= graceEnds) {
			return false;
		}
	}
	return true;
}

export async function purgeExpiredAttachmentsActivity(): Promise<PurgeExpiredAttachmentsResult> {
	// Pinned once: `scanCutoff` and every isPurgeable call must share one `now`,
	// or a long run makes rows eligible at filter time that the scan predicate
	// already excluded.
	const now = Date.now();
	const serverDefault = readRetentionDays();

	let minOverride: number | null;
	try {
		minOverride = await getMinimumAttachmentRetentionOverride();
	} catch (err) {
		logger.error(
			{
				event: "attachments.retention_purge.min_window_error",
				err: err instanceof Error ? err.message : String(err),
			},
			"[AttachmentRetentionPurge] Could not resolve the minimum window — aborting run",
		);
		// Deliberately NOT falling back to a default: a narrower scan silently
		// skips short-window tenants. Keeping the data and retrying tomorrow is
		// the recoverable failure.
		throw err;
	}

	// The scan bound must be the SMALLEST effective window anywhere, so every
	// purgeable row is still scanned. Taking the override alone would let one
	// tenant's long window move the cutoff and silently stop scanning everyone
	// still on the default.
	const minWindowDays = Math.min(serverDefault, minOverride ?? serverDefault);
	const scanCutoff = new Date(now - minWindowDays * MS_PER_DAY);

	const bucket = config.storage.bucketNames.projectContexts;
	logger.info(
		{
			event: "attachments.retention_purge.started",
			serverDefaultDays: serverDefault,
			minWindowDays,
			scanCutoffAt: scanCutoff.toISOString(),
		},
		"[AttachmentRetentionPurge] Starting purge run",
	);

	let scanned = 0;
	let expiredCandidates = 0;
	let filteredOut = 0;
	let skippedUnattributed = 0;
	let skippedUnresolved = 0;
	let deletedRows = 0;
	let deletedObjects = 0;
	let objectErrors = 0;
	let remainingBudget = MAX_DELETIONS;
	let pages = 0;
	let hitDeletionCap = false;
	let hitRunawayGuard = false;
	let errorsTruncated = false;
	/** windowDays -> rows freed under it. Flattened and sorted into the result. */
	const windowDeletions = new Map<number, number>();
	const errors: { key: string; message: string }[] = [];
	let lastId: string | undefined; // keyset boundary (a VALUE, not a live row)

	while (true) {
		if (pages >= MAX_PAGES) {
			hitRunawayGuard = true;
			break;
		}

		let page: { id: string; storageKey: string; deletedAt: Date | null }[];
		try {
			page = await db.storyAttachment.findMany({
				where: {
					deletedAt: { lt: scanCutoff },
					...(lastId ? { id: { gt: lastId } } : {}),
				},
				orderBy: { id: "asc" },
				take: PAGE_SIZE,
				select: { id: true, storageKey: true, deletedAt: true },
			});
		} catch (err) {
			logger.error(
				{
					event: "attachments.retention_purge.query_error",
					err: err instanceof Error ? err.message : String(err),
				},
				"[AttachmentRetentionPurge] findMany failed — aborting run; recovered next scheduled run",
			);
			throw err;
		}
		if (page.length === 0) {
			break;
		}
		pages += 1;

		// Attribute each row to a project. A row we cannot attribute is a row we
		// must not delete.
		const attributed: {
			id: string;
			storageKey: string;
			deletedAt: Date | null;
			projectId: string;
		}[] = [];
		for (const r of page) {
			const projectId = parseProjectIdFromStorageKey(r.storageKey);
			if (projectId === null) {
				skippedUnattributed += 1;
				continue;
			}
			attributed.push({ ...r, projectId });
		}

		// Resolved fresh for every page, never memoised across pages: that is what
		// makes a mid-run settings write able to LENGTHEN a window but never
		// shorten one retroactively within the same run.
		let windows: Awaited<
			ReturnType<typeof resolveAttachmentRetentionOverrides>
		>;
		try {
			windows = await resolveAttachmentRetentionOverrides([
				...new Set(attributed.map((r) => r.projectId)),
			]);
		} catch (err) {
			logger.error(
				{
					event: "attachments.retention_purge.resolve_error",
					err: err instanceof Error ? err.message : String(err),
				},
				"[AttachmentRetentionPurge] Could not resolve retention windows — aborting run",
			);
			throw err;
		}

		// Each surviving row carries the window it qualified under, so the delete
		// step can attribute windowsApplied without resolving a second time.
		const purgeable: {
			id: string;
			storageKey: string;
			windowDays: number;
		}[] = [];
		for (const r of attributed) {
			const override = windows.get(r.projectId);
			if (override === undefined) {
				// Absent means "could not resolve", never "no override".
				skippedUnresolved += 1;
				continue;
			}
			// serverDefault is deliberately NOT re-sanitized: its accepted floor is
			// 1 (the operator emergency drain) and the sanitizer's is 30.
			const retentionDays =
				sanitizeRetentionDays(override.days) ?? serverDefault;
			if (
				!isPurgeable({
					deletedAt: r.deletedAt,
					retentionDays,
					settingChangedAt: override.settingChangedAt,
					now,
				})
			) {
				filteredOut += 1;
				continue;
			}
			purgeable.push({
				id: r.id,
				storageKey: r.storageKey,
				windowDays: retentionDays,
			});
		}
		expiredCandidates += purgeable.length;

		// Budget-limit the destructive slice. `lastId` advances to the page's last
		// row ONLY when the whole page was covered — when the budget truncated the
		// purgeable set, advance to the last row we actually processed, or the
		// page's remainder is passed over for the rest of the run (an all-errored
		// slice consumes no budget, so the loop continues).
		const truncated = purgeable.length > remainingBudget;
		const slice = purgeable.slice(0, remainingBudget);
		scanned += page.length;
		lastId = truncated
			? (slice[slice.length - 1]?.id ?? lastId)
			: (page[page.length - 1]?.id ?? lastId);

		if (slice.length === 0) {
			// Heartbeat BEFORE continuing: heartbeatTimeout is 2 minutes and a long
			// stretch of unexpired pages would otherwise kill the run.
			safeHeartbeat();
			continue;
		}

		// OBJECT-FIRST.
		const keys = slice.map((r) => r.storageKey);
		const res = await deleteObjects(keys, { bucket }); // never throws
		deletedObjects += res.deleted;
		// Budget counts successful object deletes only; an all-errored page consumes
		// no budget, so MAX_PAGES is the backstop for an all-error run.
		remainingBudget -= res.deleted;
		const errorKeys = new Set(res.errors.map((e) => e.key));
		for (const e of res.errors) {
			objectErrors += 1;
			if (errors.length < MAX_ERRORS) {
				errors.push(e);
			} else {
				errorsTruncated = true;
			}
		}

		// Object-first safety: free a row ONLY when its object is positively accounted
		// as gone. deleteObjects accounts every input key as deleted-or-errored
		// (res.deleted + res.errors === keys). If that invariant does NOT hold (an
		// ambiguous/partial provider result), keep the WHOLE slice for next-run retry
		// rather than free a unique storageKey whose object may still exist (the F1
		// key-reuse window). Derive purgeability from positive accounting, never from
		// mere absence-from-errors.
		let freeable: typeof slice;
		if (res.deleted + res.errors.length !== slice.length) {
			logger.warn(
				{
					event: "attachments.retention_purge.ambiguous_delete_result",
					sliceSize: slice.length,
					deleted: res.deleted,
					errorCount: res.errors.length,
				},
				"[AttachmentRetentionPurge] deleteObjects did not account for every key; keeping the slice for retry",
			);
			freeable = [];
		} else {
			freeable = slice.filter((r) => !errorKeys.has(r.storageKey));
		}
		if (freeable.length > 0) {
			try {
				const del = await db.storyAttachment.deleteMany({
					where: { id: { in: freeable.map((r) => r.id) } },
				});
				deletedRows += del.count;
				// Attributed only AFTER the delete resolved: crediting a window at the
				// candidate stage would report a purge that a failed object delete or
				// a thrown deleteMany never actually performed.
				for (const r of freeable) {
					windowDeletions.set(
						r.windowDays,
						(windowDeletions.get(r.windowDays) ?? 0) + 1,
					);
				}
			} catch (err) {
				logger.error(
					{
						event: "attachments.retention_purge.delete_error",
						err: err instanceof Error ? err.message : String(err),
					},
					"[AttachmentRetentionPurge] deleteMany failed — aborting run; objects already deleted reclaimed by row retry next run",
				);
				throw err;
			}
		}

		safeHeartbeat();
		if (remainingBudget <= 0) {
			hitDeletionCap = true;
			break;
		}
	}

	if (hitDeletionCap || hitRunawayGuard) {
		logger.warn(
			{
				event: "attachments.retention_purge.safety_cap_hit",
				pages,
				deletedObjects,
				deletedRows,
				hitDeletionCap,
				hitRunawayGuard,
			},
			"[AttachmentRetentionPurge] Safety cap hit; remaining handled next run",
		);
	}

	const result: PurgeExpiredAttachmentsResult = {
		scanned,
		expiredCandidates,
		filteredOut,
		skippedUnattributed,
		skippedUnresolved,
		deletedRows,
		deletedObjects,
		objectErrors,
		errorsTruncated,
		pages,
		hitDeletionCap,
		hitRunawayGuard,
		cutoffAt: scanCutoff.toISOString(),
		minWindowDays,
		retentionDays: serverDefault,
		windowsApplied: [...windowDeletions.entries()]
			.map(([windowDays, deleted]) => ({ windowDays, deleted }))
			.sort((a, b) => a.windowDays - b.windowDays),
	};
	logger.info(
		{
			event: "attachments.retention_purge.completed",
			...result,
			errorsSample: errors.slice(0, 10),
		},
		`[AttachmentRetentionPurge] Purged ${deletedRows} rows / ${deletedObjects} objects (scanned ${scanned})`,
	);
	return result;
}
