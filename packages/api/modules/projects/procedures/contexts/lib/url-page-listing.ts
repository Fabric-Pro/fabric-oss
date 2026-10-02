/**
 * Pagination, status buckets and search for the crawled-page lists of a
 * website source — a project's `listUrlPages` and its company context twin,
 * which page and filter the same way. Each list keeps its own tenant scope,
 * reads and selected columns; only the filter and the paging live here.
 */
import type { ExtractionStatus } from "@repo/database";

export const URL_PAGES_DEFAULT_LIMIT = 10;
export const URL_PAGES_MAX_LIMIT = 50;

/**
 * Status-bucket filter expanded to the underlying enum set. "all" returns
 * everything; "indexed" → COMPLETED; "processing" → PENDING + EXTRACTING;
 * "failed" → FAILED. The bucketing is a UX concept — PENDING and EXTRACTING
 * are functionally indistinguishable to the user but distinct in the
 * workflow. Typed as `ExtractionStatus[]` (the Prisma enum) so the
 * `extractionStatus: { in: ... }` filter compiles strictly.
 */
const URL_PAGE_STATUS_BUCKETS: Record<
	"all" | "indexed" | "processing" | "failed",
	ExtractionStatus[] | null
> = {
	all: null,
	indexed: ["COMPLETED"],
	processing: ["PENDING", "EXTRACTING"],
	failed: ["FAILED"],
};

type UrlPageStatusFilter = keyof typeof URL_PAGE_STATUS_BUCKETS;

/**
 * The status-bucket and title/URL search part of a page list's WHERE, which
 * the caller spreads after its own parent and tenant scope. The search is a
 * case-insensitive substring match on either column, so a URL fragment and
 * an article title both find the page; an empty search adds nothing.
 */
export function urlPageListFilter(input: {
	statusFilter: UrlPageStatusFilter;
	search?: string;
}) {
	const statusValues = URL_PAGE_STATUS_BUCKETS[input.statusFilter];
	const search = input.search?.trim();
	return {
		...(statusValues ? { extractionStatus: { in: statusValues } } : {}),
		...(search
			? {
					OR: [
						{
							pageTitle: {
								contains: search,
								mode: "insensitive" as const,
							},
						},
						{
							pageUrl: {
								contains: search,
								mode: "insensitive" as const,
							},
						},
					],
				}
			: {}),
	};
}

/**
 * One page of a list read with `take: limit + 1`: the extra row only says a
 * next page exists, and the last row returned is its cursor.
 */
export function urlPageListPage<Row extends { id: string }>(
	rows: Row[],
	limit: number,
): { items: Row[]; nextCursor: string | null; hasNext: boolean } {
	const hasNext = rows.length > limit;
	const items = hasNext ? rows.slice(0, -1) : rows;
	const nextCursor =
		hasNext && items.length > 0 ? items[items.length - 1].id : null;
	return { items, nextCursor, hasNext };
}
