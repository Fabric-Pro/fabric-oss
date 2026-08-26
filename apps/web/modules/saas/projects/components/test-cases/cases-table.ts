/**
 * Layout constants for the Cases table.
 *
 * The column template lives here, in ONE string, because the sticky column
 * header and every row have to agree on it exactly. When each declared its own
 * `grid-template-columns`, adding a column to the header and forgetting a row
 * shifted every cell after it by one — a table that looks plausible and is
 * lying. Both import this.
 *
 * Written as a literal (not composed at runtime) so Tailwind's scanner sees the
 * arbitrary value and emits the class.
 */
/**
 * The leading 52px cell holds the reorder grip AND the select checkbox. It is
 * that wide even when reordering is unavailable, so the template never varies
 * for a given column count: a header and a row that pick different templates
 * misalign every column after the first, and the table still looks plausible
 * while showing each value under the wrong heading.
 *
 * Sized against the CONTAINER, not the viewport. Sizing it against `lg`
 * (1024px of *window*) was wrong by the width of the sidebar: at a 1085px
 * window the card is 800px wide while the row wanted 938px, so the last two
 * columns were laid out 147px past the card's right edge and clipped — with no
 * scrollbar, because the body did not overflow. "Last run" and the row menu
 * were simply gone, for every window between roughly 1024px and 1240px.
 *
 * A horizontal-scroll wrapper is NOT the fix. An element with `overflow-x`
 * computes `overflow-y` to `auto` as well, which makes it the nearest scroll
 * container for any `position: sticky` descendant — the column header then pins
 * to a box that never scrolls and rides away with the rows. That bug is why the
 * wrapper was removed in the first place. Instead the table drops its
 * lowest-value columns as the container narrows, so the row always fits.
 */

/** Container width at which every column fits. */
export const CASES_FULL_COLS = 940;
/** Below this, "Last run" is dropped. */
export const CASES_NO_LASTRUN_COLS = 820;
/** Below this, "Covers" is dropped too; below `@[670px]` the row stacks. */
export const CASES_NO_COVERS_COLS = 670;

/**
 * Three templates, one per tier, differing only in how many cells they expect.
 * A dropped column is `display:none`, so it leaves grid flow entirely and the
 * remaining cells land on the remaining tracks in order — which is why the cell
 * count and the track count stay in step without any runtime branching.
 *
 *  - 8 cols  ≥670: select+id+title+result+state+pri+owner+actions ≈ 638px
 *  - 9 cols  ≥820: + covers                                      ≈ 786px
 *  - 10 cols ≥940: + last run                                    ≈ 918px
 */
export const CASES_GRID_COLS = [
	"@[670px]:grid-cols-[52px_68px_minmax(150px,1fr)_104px_92px_52px_36px_36px]",
	"@[820px]:grid-cols-[52px_68px_minmax(150px,1fr)_140px_104px_92px_52px_36px_36px]",
	"@[940px]:grid-cols-[52px_68px_minmax(150px,1fr)_140px_104px_92px_52px_36px_124px_36px]",
].join(" ");

/**
 * Below the narrowest tier the row abandons the grid and stacks — a ten-column
 * table on a phone is a horizontal-scroll puzzle, not a list.
 */
export const CASES_GRID_ROW = `flex flex-wrap items-center gap-x-3 gap-y-1.5 @[670px]:grid @[670px]:gap-x-2 @[670px]:gap-y-0 ${CASES_GRID_COLS}`;

/** Row height once the grid engages; below that the row is content-height. */
export const CASES_ROW_HEIGHT = "@[670px]:h-[46px]";
/**
 * The compact alternative. Trades the breathing room for roughly a third more
 * rows on screen, which is what someone triaging a few hundred cases wants. Only
 * the height changes — the column template is shared, so the two densities can
 * never disagree about where a column sits.
 */
export const CASES_ROW_HEIGHT_COMPACT = "@[670px]:h-[34px]";

/**
 * Per-column visibility, imported by BOTH the header and the row so a column
 * can never be dropped from one and kept in the other — which would shift every
 * cell after it under the wrong heading.
 *
 * Visible while stacked, hidden in the narrow grid tiers, visible again once
 * the container earns the column back. The stacked row wraps freely and has all
 * the room it needs, so dropping anything there would lose information for no
 * gain — it is only the fixed-track grid that has to ration width.
 */
export const CASES_COL_COVERS = "flex @[670px]:hidden @[820px]:flex";
export const CASES_COL_LASTRUN = "flex @[670px]:hidden @[940px]:flex";

/**
 * Up to this many pages, every page gets a button. Above it, the list windows
 * around the current page. Seven is where a row of buttons stops fitting beside
 * the rows-per-page control on a narrow viewport.
 */
const MAX_UNCOLLAPSED_PAGES = 7;

/** A gap in the page list, rendered as an ellipsis rather than a button. */
export const PAGE_GAP = "gap" as const;
export type PageToken = number | typeof PAGE_GAP;

/**
 * The page numbers to offer, windowed around the current one.
 *
 * A project with 40 pages cannot show 40 buttons, and "Previous / Next" alone
 * strands a reader who knows they want the end of the list. First and last are
 * always reachable, with a window either side of where they are; gaps collapse
 * to an ellipsis. Never emits a gap that hides exactly one page — "1 … 3 4 5"
 * spends the same width as "1 2 3 4 5" and tells the reader less.
 */
export function paginationPages(
	current: number,
	totalPages: number,
	window = 1,
): PageToken[] {
	if (totalPages <= 1) {
		return totalPages === 1 ? [1] : [];
	}
	// Small lists show every page. Windowing them produced "1 2 … 5" for a
	// five-page list — three buttons and an ellipsis where five buttons fit,
	// hiding pages for no gain.
	if (totalPages <= MAX_UNCOLLAPSED_PAGES) {
		return Array.from({ length: totalPages }, (_, i) => i + 1);
	}
	const wanted = new Set<number>([1, totalPages]);
	for (let p = current - window; p <= current + window; p++) {
		if (p >= 1 && p <= totalPages) {
			wanted.add(p);
		}
	}
	const sorted = [...wanted].sort((a, b) => a - b);

	const out: PageToken[] = [];
	for (const [i, page] of sorted.entries()) {
		const prev = sorted[i - 1];
		if (prev !== undefined && page - prev > 1) {
			// A single skipped page costs no less to hide than to show.
			if (page - prev === 2) {
				out.push(prev + 1);
			} else {
				out.push(PAGE_GAP);
			}
		}
		out.push(page);
	}
	return out;
}

/** Total pages for a result count, never below 1 so the footer always reads. */
export function pageCount(total: number, pageSize: number): number {
	return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/**
 * The 1-based row range shown on this page, clamped to what exists. Returns
 * `null` for an empty result set — "1–0 of 0" is worse than saying nothing.
 */
export function pageRange(
	page: number,
	pageSize: number,
	total: number,
): { from: number; to: number } | null {
	if (total === 0) {
		return null;
	}
	const from = (page - 1) * pageSize + 1;
	if (from > total) {
		return null;
	}
	return { from, to: Math.min(total, page * pageSize) };
}
