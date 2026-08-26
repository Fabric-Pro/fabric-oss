/**
 * Word-boundary clip for chat teasers, shared by every chat renderer in this
 * package.
 *
 * Shared deliberately, and the boundary of what is shared is the point: the
 * RENDERERS must diverge, because each one's content model belongs to its
 * feature and a change to the newsletter teaser must never silently change the
 * publishing broadcast. The clipping RULE must not diverge — how much text a
 * chat post may carry before it floods a channel is a property of chat, not of
 * whichever feature is posting. The per-field budgets stay with each caller for
 * the same reason.
 *
 * Not re-exported from the package barrel: nothing outside this package needs
 * it, and an export on the barrel that no consumer imports is what the repo's
 * knip gate fails on.
 */
export function truncateForChat(s: string, max: number): string {
	const t = s.trim();
	if (t.length <= max) {
		return t;
	}
	const slice = t.slice(0, max);
	const lastSpace = slice.lastIndexOf(" ");
	// Cut at the last space only if it keeps most of the budget (avoids a stubby
	// result when there's no space near the end, e.g. one very long token).
	const body = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
	return `${body.trimEnd()}…`;
}
