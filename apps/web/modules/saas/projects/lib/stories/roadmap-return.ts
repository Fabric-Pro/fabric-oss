/**
 * Tab-scoped memory of the roadmap's filter query string.
 *
 * The Roadmap tab's filters (`useRoadmapFilters.ts`) are nuqs URL search-param
 * state, scoped to the roadmap route. Opening a feature
 * (`buildStoryDetailsRoute`) navigates to a different route entirely — the
 * feature workspace — which unmounts the roadmap and, with it, its URL state.
 * "Back to roadmap" can't just replay the current URL, because there isn't
 * one: it has to independently remember what the roadmap's query string
 * looked like when the user left, so returning restores the filters as the
 * user left them instead of resetting to the unfiltered roadmap.
 *
 * sessionStorage, not localStorage, for the same reason `ProjectDetails`'s
 * active-tab memory uses it (see `TAB_STORAGE_KEY` there): localStorage is
 * shared across every browser tab of the origin, so persisting there would
 * leak one tab's roadmap filters into another tab open on a different
 * project — or a different filter state of the same one.
 */

const ROADMAP_QUERY_STORAGE_KEY = "fabric-roadmap-filters";

function storageKey(projectId: string): string {
	return `${ROADMAP_QUERY_STORAGE_KEY}-${projectId}`;
}

/**
 * Remember the roadmap's current filter query string for `projectId`.
 *
 * `query` is a serialized filter query (e.g. `"?q=login&kind=BUG"`, or `""`
 * when no filters are active). Always writes — including the empty string —
 * so clearing filters is remembered too, not just setting them.
 *
 * No-ops silently (never throws) when `window`/sessionStorage is unavailable
 * or access throws, such as in private browsing.
 */
export function rememberRoadmapQuery(projectId: string, query: string): void {
	try {
		if (typeof window === "undefined") {
			return;
		}
		window.sessionStorage.setItem(storageKey(projectId), query);
	} catch {
		// Storage unavailable (private browsing, quota, etc.) — remembering
		// the filter state is a nicety, not a requirement.
	}
}

/**
 * Read back the roadmap's remembered filter query string for `projectId`.
 *
 * Returns `""` when nothing has been remembered yet, or when
 * `window`/sessionStorage is unavailable or access throws.
 */
export function readRoadmapQuery(projectId: string): string {
	try {
		if (typeof window === "undefined") {
			return "";
		}
		return window.sessionStorage.getItem(storageKey(projectId)) ?? "";
	} catch {
		return "";
	}
}

/**
 * Build the "Back to roadmap" route: the project's roadmap tab with the
 * remembered filter query re-applied.
 *
 * `query` is accepted with or without a leading `?`. `tab` always comes
 * first and is always `stories` — a stored `tab` value (there shouldn't be
 * one, but a stale or hand-built query could carry one) never wins. With
 * `query === ""` this returns exactly `${basePath}/projects/${projectId}?tab=stories`,
 * matching the route's pre-existing literal so unfiltered "Back to roadmap"
 * behavior is unchanged.
 */
export function buildRoadmapReturnRoute(
	basePath: string,
	projectId: string,
	query: string,
): string {
	const raw = query.startsWith("?") ? query.slice(1) : query;
	const params = new URLSearchParams(raw);
	params.delete("tab");

	const ordered = new URLSearchParams();
	ordered.set("tab", "stories");
	for (const [key, value] of params.entries()) {
		ordered.append(key, value);
	}

	return `${basePath}/projects/${projectId}?${ordered.toString()}`;
}
