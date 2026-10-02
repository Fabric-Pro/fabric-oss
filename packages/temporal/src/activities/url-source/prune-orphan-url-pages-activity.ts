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
 *
 * A company owner (Fizzy #2719) prunes `CompanyContextUrlPage` under the
 * owner's organization, and does remove the pruned pages' vectors from the
 * company collection — before the rows, so a pruned page is never left
 * searchable under a source that still exists — then sweeps the source's
 * page vectors against the page rows left, so none outlives its row. A
 * missing owner is the project owner, unchanged.
 */
import { db } from "@repo/database/prisma/client";
import {
	deleteCompanyContextRowPoints,
	deleteCompanyPagePointsNotIn,
} from "@repo/rag";
import {
	type CompanyContextOwner,
	type ContextOwner,
	companyContextOwnerOf,
} from "../../lib/context-owner";
import { companyLinkCrawlStore } from "../../lib/context-row-store";
import { activityLogger } from "../lib/activity-logger";

export interface PruneOrphanUrlPagesActivityInput {
	parentContextId: string;
	/** URLs the just-finished crawl returned. Anything else under the parent is an orphan. */
	keptUrls: string[];
	/** Who owns the parent; absent is the project owner (`../../lib/context-owner`). */
	owner?: ContextOwner;
}

export interface PruneOrphanUrlPagesActivityOutput {
	deletedCount: number;
}

export async function pruneOrphanUrlPagesActivity(
	input: PruneOrphanUrlPagesActivityInput,
): Promise<PruneOrphanUrlPagesActivityOutput> {
	const company = companyContextOwnerOf(input.owner);
	if (company) {
		return pruneCompanyUrlPages(input, company);
	}

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

/**
 * The company owner's prune. Same guard and the same best-effort contract as
 * the project prune; the difference is the vectors.
 *
 * The orphans' points are removed first, then the rows. If the point delete
 * fails, no row is deleted, so the next crawl finds the same orphans and
 * tries again.
 *
 * Then, on every call — with no orphan to prune, and with an empty kept set
 * too — the source's page vectors are swept against its page rows as they
 * are after the prune: the points of any page whose row is gone are deleted.
 * That catches a page the row delete removed that was not among the orphans
 * read first (created in between), and whatever an earlier sweep failed to
 * remove. The sweep keeps no list of what it owes — it reads it from the
 * rows — so a sweep that fails is done again by the next crawl's prune; the
 * failure is logged and does not change the result.
 */
async function pruneCompanyUrlPages(
	input: PruneOrphanUrlPagesActivityInput,
	owner: CompanyContextOwner,
): Promise<PruneOrphanUrlPagesActivityOutput> {
	const { parentContextId, keptUrls } = input;

	activityLogger.info("Prune orphan company url pages start", {
		parentContextId,
		organizationId: owner.organizationId,
		keptCount: keptUrls.length,
	});

	const deletedCount = await pruneCompanyPageRows(input, owner);
	await sweepCompanyPagePoints(parentContextId, owner);
	return { deletedCount };
}

/** Remove the orphan pages' points, then their rows. Returns the rows removed. */
async function pruneCompanyPageRows(
	input: PruneOrphanUrlPagesActivityInput,
	owner: CompanyContextOwner,
): Promise<number> {
	const { parentContextId, keptUrls } = input;
	const { organizationId } = owner;
	const crawls = companyLinkCrawlStore(owner);

	if (keptUrls.length === 0) {
		activityLogger.warn("Prune skipped — empty kept set", {
			parentContextId,
		});
		return 0;
	}

	try {
		const kept = new Set(keptUrls);
		const orphanIds = (await crawls.listPages(parentContextId))
			.filter((page) => !kept.has(page.pageUrl))
			.map((page) => page.id);
		if (orphanIds.length === 0) {
			return 0;
		}

		await deleteCompanyContextRowPoints({
			organizationId,
			contextIds: orphanIds,
		});
		const { deletedPageIds } = await crawls.prunePages(
			parentContextId,
			keptUrls,
		);

		activityLogger.info("Prune orphan company url pages success", {
			parentContextId,
			deletedCount: deletedPageIds.length,
		});

		return deletedPageIds.length;
	} catch (error) {
		activityLogger.error("Prune orphan company url pages failed", {
			parentContextId,
			error: error instanceof Error ? error.message : String(error),
		});
		return 0;
	}
}

/**
 * Delete the source's page points whose page row no longer exists. Best
 * effort: a failure is logged, and the next prune sweeps again.
 */
async function sweepCompanyPagePoints(
	parentContextId: string,
	owner: CompanyContextOwner,
): Promise<void> {
	const { organizationId } = owner;
	try {
		const livePageIds = (
			await companyLinkCrawlStore(owner).listPages(parentContextId)
		).map((page) => page.id);
		await deleteCompanyPagePointsNotIn({
			organizationId,
			sourceId: parentContextId,
			livePageIds,
		});
	} catch (error) {
		activityLogger.error("Sweep of company url page points failed", {
			parentContextId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
