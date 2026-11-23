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

import type { ResolvedProposalItem } from "../proposal-item-state";

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
		"The PM tool may already have this item, but Fabric couldn't link to it. Check the PM tool; if it isn't there, use Unlink & re-create.",
	create_unconfirmed:
		"Fabric couldn't confirm whether the PM tool created this item, so it didn't create another. Check the PM tool; if it isn't there, use Unlink & re-create.",
	TargetMissing:
		"The ticket this proposal updates no longer exists. Move the update to Rejected, or dismiss the proposal.",
	default: "Couldn't sync this proposal. Show details.",
};

/**
 * Classes of an apply that ran out of time: the apply activity's own
 * timeout (`TimeoutFailure`) and the stale-apply watchdog (`TimedOut`).
 */
const TIMED_OUT_CLASSES = new Set(["TimeoutFailure", "TimedOut"]);

/** The proposal fields a timed-out apply's headline counts. */
type ApplyProgressSource = {
	changeCount: number;
	resolvedItems: readonly ResolvedProposalItem[];
};

/**
 * A timed-out apply's headline. It counts only the changes an apply can
 * land: an item moved to Rejected or resolved as a duplicate is never
 * applied by a retry, so it is in neither number.
 */
function timedOutCopy(proposal: ApplyProgressSource): string {
	const applied = proposal.resolvedItems.filter(
		(item) => item.reason === "applied",
	).length;
	const remaining = proposal.changeCount - proposal.resolvedItems.length;
	if (applied === 0) {
		return "Applying took too long and stopped before any change was applied. Retry to apply them.";
	}
	if (remaining <= 0) {
		return "Applying took too long after every change was applied. Retry to finish the apply.";
	}
	return `Applying took too long: ${applied} of ${applied + remaining} changes were applied. Retry to apply the remaining ${remaining}.`;
}

/**
 * Map a `PendingBacklogProposal.errorClass` value to the plain-English
 * sentence the inbox renders above the raw error block. Returns the
 * `default` copy for unknown / null / empty classes so the function is
 * always safe to call from a render path. `proposal` lets a timed-out
 * apply say how much of it landed.
 */
export function failureClassToCopy(
	errorClass: string | null | undefined,
	proposal: ApplyProgressSource,
): string {
	if (!errorClass) {
		return FAILURE_CLASS_COPY.default;
	}
	if (TIMED_OUT_CLASSES.has(errorClass)) {
		return timedOutCopy(proposal);
	}
	return FAILURE_CLASS_COPY[errorClass] ?? FAILURE_CLASS_COPY.default;
}
