/**
 * Prune Orphan URL Pages Activity (URL Context Sources)
 *
 * Deletes `ProjectContextUrlPage` rows under a given parent context whose
 * `pageUrl` is NOT in the URL set returned by the most recent crawl.
 *
 * Why we need this:
 *   - User lowers `maxPages` from 100 → 40 and triggers a re-sync. Firecrawl
 *     returns 40 pages. We upsert 40 rows. The other 60 prior-crawl rows
 *     remain — `indexedCount` reads `_count.urlPages = 100` and the UI
 *     shows "100 pages indexed" with `Max pages = 40`. That's the
 *     "indexed > max" UX bug.
 *   - Site removes pages. Crawl no longer returns those URLs. Orphans stay.
 *   - Scope shrinks (path-prefix narrowed). Orphans stay.
 *
 * Behaviour:
 *   - Runs ONLY in the PATH_PREFIX branch of `urlSourceCrawlWorkflow`.
 *   - Caller passes the set of `pageUrl` strings the crawl just returned.
 *   - We delete `ProjectContextUrlPage` rows where `parentContextId` matches
 *     and `pageUrl NOT IN keptUrls`. Returns the count for the workflow's
 *     final indexed-count math.
 *   - Best-effort: if the delete fails (DB hiccup, etc.) we log and return
 *     `{ deletedCount: 0 }` so the workflow's finalize still runs. The
 *     reconciliation script (Group 5) can re-sweep later.
 *
 * Cascade: the schema declares `onDelete: Cascade` from
 * `ProjectContextUrlPage` to its child chunks/embeddings, so a delete here
 * also cleans up any orphan vector rows. The Qdrant points for those rows
 * are NOT auto-cleaned (Qdrant lives outside Prisma cascade). The follow-up
 * is filed as a separate hardening task — for the UX bug the user reported,
 * the SQL-side trim is what matters: it brings `_count.urlPages` back into
 * line with `urlMaxPages` so the displayed number stops exceeding the cap.
 */
import { db } from "@repo/database/prisma/client";
import { activityLogger } from "../lib/activity-logger";

export interface PruneOrphanUrlPagesActivityInput {
	parentContextId: string;
	/** URLs the just-finished crawl returned. Anything else under the parent is an orphan. */
	keptUrls: string[];
}

export interface PruneOrphanUrlPagesActivityOutput {
	deletedCount: number;
}

export async function pruneOrphanUrlPagesActivity(
	input: PruneOrphanUrlPagesActivityInput,
): Promise<PruneOrphanUrlPagesActivityOutput> {
	const { parentContextId, keptUrls } = input;

	activityLogger.info("Prune orphan url pages start", {
		parentContextId,
		keptCount: keptUrls.length,
	});

	// Defensive: an empty kept set means the crawl returned zero pages.
	// That's either a transient error or a deliberate scope change — in
	// neither case do we want to wipe the entire child table from inside
	// what's supposed to be a "trim orphans" step. Leave the existing
	// rows alone; the workflow's failure path / next successful run will
	// decide.
	if (keptUrls.length === 0) {
		activityLogger.warn("Prune skipped — empty kept set", {
			parentContextId,
		});
		return { deletedCount: 0 };
	}

	try {
		const result = await db.projectContextUrlPage.deleteMany({
			where: {
				parentContextId,
				pageUrl: { notIn: keptUrls },
			},
		});

		activityLogger.info("Prune orphan url pages success", {
			parentContextId,
			deletedCount: result.count,
		});

		return { deletedCount: result.count };
	} catch (error) {
		// Don't bubble — finalize must still run. Operator can re-trim via
		// the next manual re-sync.
		activityLogger.error("Prune orphan url pages failed", {
			parentContextId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { deletedCount: 0 };
	}
}
