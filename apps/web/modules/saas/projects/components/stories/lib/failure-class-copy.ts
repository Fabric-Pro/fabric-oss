/**
 * Plain-English copy for backlog-proposal sync failures.
 *
 * Maps the classified `errorClass` value stamped on the
 * `PendingBacklogProposal` row by `unwrapPmSyncError` to a short, calm
 * sentence the user can act on. The raw `errorMessage` / `applyError`
 * is shown separately behind a "Show details" expander.
 *
 * Pure function. Never throws. Unknown error classes fall back to the
 * `default` copy so the inbox always renders something readable.
 *
 * Keep this list aligned with `unwrapPmSyncError` (in
 * `@repo/temporal`) — every class it emits needs a row here.
 */

const FAILURE_CLASS_COPY: Record<string, string> = {
	TemporalScheduleFailed:
		"Background job couldn't start. Try again in a moment.",
	PayloadTooLarge:
		"Proposal description is too long for the PM tool. Shorten it and retry.",
	PmAuthError: "PM tool credentials are invalid. Reconnect and retry.",
	PmNotFoundError:
		"The PM tool project or list this targets no longer exists. Reconfigure and retry.",
	PmRateLimitError: "PM tool rate limit hit. Try again in a minute.",
	PmCreateError:
		"PM tool rejected this proposal. Show details for the raw response.",
	DedupCollision:
		"A story with this title already exists. Already on roadmap.",
	create_orphan:
		"Created in Fabric but the PM-tool link couldn't be saved. Retry to relink.",
	default: "Couldn't sync this proposal. Show details.",
};

/**
 * Map a `PendingBacklogProposal.errorClass` value to the plain-English
 * sentence the inbox renders above the raw error block. Returns the
 * `default` copy for unknown / null / empty classes so the function is
 * always safe to call from a render path.
 */
export function failureClassToCopy(
	errorClass: string | null | undefined,
): string {
	if (!errorClass) {
		return FAILURE_CLASS_COPY.default;
	}
	return FAILURE_CLASS_COPY[errorClass] ?? FAILURE_CLASS_COPY.default;
}
