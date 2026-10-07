/**
 * A crawled page a website crawl could not fetch (Fizzy #2719), for either
 * owner's page table: `ProjectContextUrlPage` and `CompanyContextUrlPage`.
 *
 * A crawl that cannot fetch a page keeps it and marks it FAILED with why,
 * instead of letting the crawl's prune delete a page that may still be on the
 * site. Every such message starts with `URL_PAGE_FETCH_FAILURE_PREFIX`, so a
 * later crawl that fetches the page again can tell a page marked this way
 * from one that failed for another reason (its embed, say), and restore only
 * the former (`urlPageFetchFailureRestorableWhere`).
 *
 * Pure (no Prisma client), so the crawl activities and the query layer read
 * one definition.
 */

import type { Prisma } from "../client";

/**
 * The start of every message a failed page fetch records. It is shown as the
 * page's failure reason, and a later fetch of the page keys on it, so it
 * never changes and no other writer uses it.
 */
export const URL_PAGE_FETCH_FAILURE_PREFIX = "Could not fetch this page: ";

/** The message a failed page fetch records: the prefix, then the cause. */
export function urlPageFetchFailureMessage(cause: string): string {
	return `${URL_PAGE_FETCH_FAILURE_PREFIX}${cause.trim() || "unknown error"}`;
}

/**
 * The page rows a failed fetch marks FAILED: a COMPLETED or CANCELLED page,
 * or one holding no vectors. A PENDING, EXTRACTING or FAILED page that holds
 * vectors is left as it is — it is already waiting for, or has already
 * failed, a re-index, and that path decides what happens to it. The crawl
 * keeps it either way.
 *
 * Part of the write's WHERE, so the rule holds against a row that changed
 * after it was read.
 */
export function urlPageFetchFailureWritableWhere(): Prisma.ProjectContextUrlPageWhereInput &
	Prisma.CompanyContextUrlPageWhereInput {
	return {
		OR: [
			{ extractionStatus: { in: ["COMPLETED", "CANCELLED"] } },
			{ embeddedAt: null },
		],
	};
}

/**
 * The page rows a later fetch of unchanged content completes again: FAILED by
 * a failed fetch (the message starts with `URL_PAGE_FETCH_FAILURE_PREFIX`)
 * and still holding vectors. A failed fetch marks a page that holds vectors
 * only when it is COMPLETED (`urlPageFetchFailureWritableWhere`; a crawl
 * cancels only pages that hold none) or a retry of a page it already marked
 * (`urlPageRetryFetchFailureWritableWhere`), and never changes its content or
 * hash, so unchanged content on such a page is the indexed content, and it
 * needs no embed.
 *
 * Every condition is needed. A page FAILED for another reason — its embed,
 * say, after a content change — may hold the earlier version's vectors. A
 * page marked by a failed fetch with no vectors (a URL no fetch had written,
 * or one whose other model's vectors were removed) has nothing indexed. This
 * restores neither; the fetch's upsert embeds the content of a marked page
 * with no vectors instead.
 *
 * Part of the write's WHERE, so the rule holds against a row that changed
 * after it was read.
 */
export function urlPageFetchFailureRestorableWhere(): Prisma.ProjectContextUrlPageWhereInput &
	Prisma.CompanyContextUrlPageWhereInput {
	return {
		extractionStatus: "FAILED",
		embeddedAt: { not: null },
		extractionError: { startsWith: URL_PAGE_FETCH_FAILURE_PREFIX },
	};
}

/**
 * The retried page rows a failed fetch marks with its own reason: PENDING (a
 * page retry sets that and keeps the page's reason) and holding no vectors,
 * or already marked by a failed fetch. Either way any vectors are the page's
 * content's — a content write clears the reason — so the page stays one a
 * later fetch of unchanged content may complete again
 * (`urlPageFetchFailureRestorableWhere`). A retried page that failed for
 * another reason may hold an earlier version's vectors and keeps its reason.
 *
 * Part of the write's WHERE, so the rule holds against a row that changed
 * after it was read.
 */
export function urlPageRetryFetchFailureWritableWhere(): Prisma.ProjectContextUrlPageWhereInput &
	Prisma.CompanyContextUrlPageWhereInput {
	return {
		extractionStatus: "PENDING",
		OR: [
			{ embeddedAt: null },
			{ extractionError: { startsWith: URL_PAGE_FETCH_FAILURE_PREFIX } },
		],
	};
}
