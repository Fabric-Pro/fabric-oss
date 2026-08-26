/**
 * Shared helpers for the `CONTEXT_INDEXING_*` notifications emitted by the
 * URL-source flow.
 *
 * Spec ref: `fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md`
 *   - §8.3 — `estimateCopy()` time-estimate heuristic (explicit-ceiling, not
 *     a guarantee; no workflow heartbeats).
 *   - §8.2 — `displayUrl()` + `contextTabHref()` used to populate the
 *     Notification row's `title` and `link`.
 *
 * Why API-side: `estimateCopy` is called from `process-context-link.ts` when
 * the started-row is emitted; `displayUrl` and `contextTabHref` are reused by
 * the temporal-side completion notification helper at
 * `packages/temporal/src/activities/url-source/lib/emit-completion-notification.ts`,
 * which re-implements the same shapes (we don't import across packages to
 * keep the temporal package free of `@repo/api` deps).
 */
/**
 * Mirror of `URL_SCOPE_VALUES` in `process-context-link.ts`. Inlined to keep
 * this helper free of any procedure-side imports (the temporal package
 * imports `displayUrl` via a parallel re-implementation but shares this
 * scope contract).
 */
export type UrlSourceScope = "SINGLE_PAGE" | "PATH_PREFIX";

/**
 * Human-readable time estimate for the started-notification snippet.
 *
 * Heuristic (per §8.3 of the spec):
 *   - SINGLE_PAGE: fixed copy — single-page scrape settles in well under a
 *     minute on every provider we ship today.
 *   - PATH_PREFIX: 5 seconds per page (Firecrawl observed median including
 *     fetch + extract + embed) plus a 30s fixed overhead for map / kickoff,
 *     rounded up to the nearest minute and floored at 1 min so the bell row
 *     never says "Estimated 0 min".
 *
 * Examples expected by §13.5:
 *   - (PATH_PREFIX, 1)   → "Estimated 1 min …"
 *   - (PATH_PREFIX, 100) → "Estimated 9 min …"
 *   - (PATH_PREFIX, 500) → "Estimated 43 min …"
 */
export function estimateCopy(scope: UrlSourceScope, maxPages: number): string {
	if (scope === "SINGLE_PAGE") {
		return "About 30 seconds — we'll notify you when it's ready.";
	}
	const seconds = maxPages * 5 + 30;
	const minutes = Math.max(1, Math.round(seconds / 60));
	return `Estimated ${minutes} min — we'll notify you when it's ready.`;
}

const MAX_PATH_LENGTH = 40;

/**
 * Format a URL for use in the notification `title`. Returns `host + path`
 * with the path truncated to ~40 chars (ellipsis suffix) so the row stays
 * legible at the bell's compact width.
 *
 * - Invalid URLs fall back to the raw string so the notification never blows
 *   up on a malformed input (the API zod schema rejects bad URLs upstream,
 *   but the activity-side helper has no such guard).
 * - Search + hash are dropped — they're noise in the bell.
 * - Trailing slashes on the path are stripped so `example.com/` renders as
 *   `example.com` (matches the user's mental model of "the URL").
 */
export function displayUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	const host = parsed.host;
	const rawPath = parsed.pathname.replace(/\/+$/, "");
	if (rawPath === "" || rawPath === "/") {
		return host;
	}
	const path =
		rawPath.length > MAX_PATH_LENGTH
			? `${rawPath.slice(0, MAX_PATH_LENGTH)}…`
			: rawPath;
	return `${host}${path}`;
}

/**
 * Build the "open the project's Context tab" deep-link for the notification
 * row. Org-vs-personal slug-aware — when `organizationSlug` is provided we
 * build the `/app/${slug}/...` form, otherwise the personal `/app/...` form.
 *
 * Why this lives here: the spec (§8.2) calls for the link to point at the
 * project's Context tab. The contexts list page already mounts under
 * `/app/projects/[projectId]/context` (personal) and
 * `/app/[slug]/projects/[projectId]/context` (org). Both notification emit
 * sites build the same href so they're trivially aligned.
 *
 * NOTE: `organizationSlug` is the human-readable URL slug, not the
 * organization id. The emit sites resolve the slug from the organization
 * row before calling this helper.
 */
export function contextTabHref(
	projectId: string,
	organizationSlug: string | null,
): string {
	return organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}/context`
		: `/app/projects/${projectId}/context`;
}
