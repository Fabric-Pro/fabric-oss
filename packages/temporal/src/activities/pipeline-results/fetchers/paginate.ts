/**
 * Bounded backlog paging for the provider listings.
 *
 * Every provider lists runs NEWEST-first and none of them offers a server-side
 * "id greater than" filter, so a single page of N against a backlog larger than
 * N returns the N *newest* runs above the cursor. Ingesting those advanced the
 * cursor past everything older, and the middle of the backlog became
 * unreachable forever — a repo doing 30 builds a day that nobody synced for
 * three days silently lost ~70 runs, reported as `ingestedRuns: 20`.
 *
 * Ordering cannot fix this: asking GitLab for `sort=asc` returns the project's
 * FIRST pipelines ever, which the client-side cursor filter then discards
 * wholesale, freezing the cursor. So we page until we reach the cursor.
 *
 * The page cap is a safety bound for a first-ever sync against a repo with
 * years of history, not the expected path. When it trips, {@link truncated}
 * says so rather than letting the caller report a clean drain.
 */

/** Pages of this many, up to {@link MAX_PAGES} — 200 runs per sync by default. */
export const MAX_PAGES = 10;

export interface PagedRuns<T> {
	/** Every listed run above the cursor, newest-first order preserved. */
	items: T[];
	/** True when the cap stopped us before we reached the cursor. */
	truncated: boolean;
}

/**
 * Page a newest-first listing until a run at or below `since` appears (the
 * backlog is fully covered), a short page arrives (no more history), or the
 * page cap trips.
 *
 * `fetchPage` is 1-indexed to match every provider's `page` parameter.
 */
export async function paginateRuns<T>(input: {
	since: number;
	perPage: number;
	idOf: (item: T) => number;
	fetchPage: (page: number) => Promise<T[]>;
	/** Called before each page so a long backlog can't starve the heartbeat. */
	onPage?: (page: number) => void;
}): Promise<PagedRuns<T>> {
	const collected: T[] = [];

	for (let page = 1; page <= MAX_PAGES; page++) {
		input.onPage?.(page);
		const batch = await input.fetchPage(page);
		if (batch.length === 0) {
			return { items: collected, truncated: false };
		}

		collected.push(...batch);

		// Reaching the cursor means everything between it and the newest run is
		// now in hand — there is no gap left to lose.
		if (batch.some((item) => input.idOf(item) <= input.since)) {
			return { items: collected, truncated: false };
		}
		// A short page is the end of the provider's history.
		if (batch.length < input.perPage) {
			return { items: collected, truncated: false };
		}
	}

	return { items: collected, truncated: true };
}
