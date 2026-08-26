/**
 * Pure outcome helpers for `backlogApplyChangesWorkflow` — extracted so the
 * "what counts as applied" + "is this PM-sync failure recoverable" logic is
 * unit-testable (the workflow body itself runs in the Temporal sandbox). No
 * I/O, no clock, no randomness — safe to import into the workflow.
 */

/**
 * True when a PM-sync failure means the linked PM ticket was DELETED on its
 * server — a recoverable "re-link" condition, NOT a reason to fail an
 * otherwise-applied Fabric change. `syncWorkItemToPM` already proposes a
 * FLAG_MISSING for the Review Center (re-push / unlink / dismiss) before it
 * throws, so the apply just needs to stop treating it as fatal.
 *
 * The primary signal is the activity's classified `errorClass`
 * ("PmNotFoundError"). `unwrapPmSyncError` can lose that class to a deeper,
 * generic frame (name "Error") when the ApplicationFailure carries a raw
 * `cause`, so as a fallback — and ONLY when the class is generic/absent — we
 * match the canonical not-found message pattern (the same one
 * `humanize-pm-sync-error` uses to map a deleted-card 404 to unlink guidance).
 * A specifically-classified error (PmAuthError, PmCreateError, …) is never
 * mistaken for a missing ticket.
 */
export function isPmTicketMissingError(
	errorClass: string | null | undefined,
	message: string | null | undefined,
): boolean {
	if (errorClass === "PmNotFoundError") {
		return true;
	}
	if (
		!errorClass ||
		errorClass === "Error" ||
		errorClass === "UnknownError"
	) {
		return /\bnot found\b|does not exist|could not be found|resource not found|\b404\b/i.test(
			message ?? "",
		);
	}
	return false;
}

/**
 * Resolve which approved-change proposal indexes are "fully applied" and should
 * be recorded on the proposal (so an idempotent retry skips them). A change
 * counts iff Fabric succeeded AND — when PM sync was requested — it also synced,
 * OR did not need PM sync, OR its PM ticket was deleted (treated as
 * applied-and-flagged-for-relink, not failed), OR its PM push hit a content
 * CONFLICT (the Fabric change landed; the item is flagged for Review Center
 * conflict resolution — applied-and-flagged, not failed). A change that failed
 * PM sync for any OTHER reason is deliberately left out so a retry re-attempts
 * its sync.
 */
export function computeAppliedProposalIndexes(args: {
	/** Positions (in the approved set) whose Fabric create/update succeeded. */
	fabricSucceededPositions: Iterable<number>;
	/** position -> original proposal.changes[] index. */
	approvedChangeIndexes: number[];
	syncToPM: boolean;
	pmSucceededPositions: ReadonlySet<number>;
	pmNotNeededPositions: ReadonlySet<number>;
	/** Positions whose PM ticket was deleted (recoverable re-link). */
	pmTicketMissingPositions: ReadonlySet<number>;
	/**
	 * Positions whose PM push hit a content CONFLICT (the PM ticket drifted
	 * from our last-synced baseline). The Fabric change applied and the item
	 * is flagged for Review Center conflict resolution, so — like a deleted
	 * ticket — it counts as applied-and-flagged, not failed. Optional for
	 * backwards compatibility with callers that predate conflict handling.
	 */
	pmConflictPositions?: ReadonlySet<number>;
}): number[] {
	const out: number[] = [];
	for (const position of args.fabricSucceededPositions) {
		const proposalIndex = args.approvedChangeIndexes[position];
		if (typeof proposalIndex !== "number") {
			continue;
		}
		if (args.syncToPM) {
			const fullyDone =
				args.pmSucceededPositions.has(position) ||
				args.pmNotNeededPositions.has(position) ||
				args.pmTicketMissingPositions.has(position) ||
				(args.pmConflictPositions?.has(position) ?? false);
			if (!fullyDone) {
				continue;
			}
		}
		out.push(proposalIndex);
	}
	return out;
}
