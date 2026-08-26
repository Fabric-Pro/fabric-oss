/**
 * Bulk Init URL Pages Activity (URL Context Sources).
 *
 * Creates PENDING placeholder rows in `ProjectContextUrlPage` for every URL
 * discovered by `firecrawlMapActivity`, BEFORE the workflow starts the per-
 * URL scrape loop. This is purely a UX-improvement step:
 *
 *   - Without bulk-init the UI sees rows appear one-by-one as each scrape
 *     completes, so the user has no idea what the total list looks like or
 *     how much is left.
 *   - With bulk-init the UI immediately shows the full list with "Processing"
 *     status, and each row flips to Indexed/Failed in place as the scrape
 *     loop advances. Same eventual state, far better progress feedback.
 *
 * Idempotent: a URL already present under the parent is skipped (we never
 * overwrite content here — that's `upsertUrlPageActivity`'s job once the
 * scrape returns markdown). Safe to call on re-syncs.
 *
 * Returns the full pageId → pageUrl mapping so the workflow can refer to
 * specific rows in the scrape loop. Initial chunkCount = 0, contentHash = ""
 * (will be set on the upsert that follows scrape).
 *
 * Sets up the per-page row lifecycle.
 */
import { db } from "@repo/database/prisma/client";
import { activityLogger } from "../lib/activity-logger";

export interface BulkInitUrlPagesActivityInput {
	parentContextId: string;
	projectId: string;
	urls: string[];
	userId: string | null;
	organizationId: string | null;
}

export interface BulkInitUrlPagesActivityOutput {
	/** Total rows touched (created or already-existing). */
	totalCount: number;
	/** Rows newly inserted in PENDING state. */
	createdCount: number;
	/** Rows already present (idempotent re-sync). */
	existingCount: number;
}

export async function bulkInitUrlPagesActivity(
	input: BulkInitUrlPagesActivityInput,
): Promise<BulkInitUrlPagesActivityOutput> {
	const { parentContextId, projectId, urls, userId, organizationId } = input;

	activityLogger.info("Bulk init url pages start", {
		parentContextId,
		urlCount: urls.length,
	});

	if (urls.length === 0) {
		return { totalCount: 0, createdCount: 0, existingCount: 0 };
	}

	// Find URLs already present under this parent so we don't try to
	// re-insert (and so the count reflects the right createdCount).
	const existingRows = await db.projectContextUrlPage.findMany({
		where: { parentContextId, pageUrl: { in: urls } },
		select: { pageUrl: true },
	});
	const existingSet = new Set(existingRows.map((r) => r.pageUrl));
	const toCreate = urls.filter((u) => !existingSet.has(u));

	if (toCreate.length === 0) {
		activityLogger.info("Bulk init url pages — all already present", {
			parentContextId,
			existingCount: existingSet.size,
		});
		return {
			totalCount: urls.length,
			createdCount: 0,
			existingCount: existingSet.size,
		};
	}

	// `createMany` is significantly faster than N round-trips and keeps the
	// activity short enough to never hit the heartbeat timeout window.
	const data = toCreate.map((pageUrl) => ({
		parentContextId,
		projectId,
		pageUrl,
		content: "",
		contentHash: "",
		extractionStatus: "PENDING" as const,
		userId,
		organizationId,
	}));

	const result = await db.projectContextUrlPage.createMany({
		data,
		// Race-safe: a concurrent re-sync from another tab can't double-
		// insert the same (parentContextId, pageUrl). The DB has a unique
		// index on that pair via the schema; `skipDuplicates` makes
		// createMany ignore conflicts instead of throwing.
		skipDuplicates: true,
	});

	activityLogger.info("Bulk init url pages success", {
		parentContextId,
		createdCount: result.count,
		existingCount: existingSet.size,
	});

	return {
		totalCount: urls.length,
		createdCount: result.count,
		existingCount: existingSet.size,
	};
}
