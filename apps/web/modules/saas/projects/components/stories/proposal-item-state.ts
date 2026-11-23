/**
 * Per-item review state of an inbox proposal, read from the server's
 * resolved set: which items no longer wait for a decision and why
 * (`resolvedItems`), and how many still do (`remainingCount`). The rule
 * that decides an item is resolved lives on the server only; this module
 * maps each server reason to its label and ticket. Resolved items are
 * locked: they cannot be selected, approved or rejected again, so only
 * unresolved indexes are ever submitted.
 */

/**
 * Why a row is locked. `accepted` is the Roadmap-recommendation wording,
 * `applied` everyone else's; `already-on-roadmap` is an item resolved
 * without creating anything (its title or a duplicate was already on the
 * Roadmap); `rejected` was moved to Rejected on its own, and `restored`
 * was moved there and then restored from the Rejected list.
 */
export type LockedReason =
	| "accepted"
	| "applied"
	| "already-on-roadmap"
	| "rejected"
	| "restored";

/** Badge text and the checkbox's accessible-name suffix, per reason. */
export const LOCKED_REASON_COPY: Record<
	LockedReason,
	{ badge: string; ariaSuffix: string }
> = {
	accepted: { badge: "Accepted", ariaSuffix: "already accepted" },
	applied: { badge: "Applied", ariaSuffix: "already applied" },
	"already-on-roadmap": {
		badge: "Already on Roadmap",
		ariaSuffix: "already on the Roadmap",
	},
	rejected: { badge: "Moved to Rejected", ariaSuffix: "moved to Rejected" },
	restored: {
		badge: "Restored from Rejected",
		ariaSuffix: "restored from Rejected",
	},
};

/** A single-item decision still in flight, for that row's spinner. */
export type PendingItemAction = {
	changeIndex: number;
	action: "approve" | "reject";
};

export type ProposalApplication = {
	changeIndex: number;
	createdEntityId: string | null;
	action: string;
};

/** An item resolved as a duplicate of an existing ticket. */
export type ProposalDuplicateResolution = {
	changeIndex: number;
	existingEntityId: string | null;
};

/** An item moved to Rejected and restored from there, with its ticket. */
export type RestoredProposalItem = {
	changeIndex: number;
	storyId: string | null;
};

/** One item the server counts as resolved, with its reason. */
export type ResolvedProposalItem = {
	changeIndex: number;
	reason: "applied" | "duplicate" | "rejected";
};

export type ProposalItemState = {
	lockedReasons: Map<number, LockedReason>;
	/** The ticket an applied item created, updated or matched, by index. */
	lockedTargets: Map<number, string>;
	/** Items applied as proposed (`accepted` / `applied`). */
	appliedCount: number;
	alreadyOnRoadmapCount: number;
};

function lockedReasonFor(
	item: ResolvedProposalItem,
	created: ReadonlySet<number>,
	restored: ReadonlySet<number>,
	appliedReason: "accepted" | "applied",
): LockedReason {
	switch (item.reason) {
		case "rejected":
			return restored.has(item.changeIndex) ? "restored" : "rejected";
		case "applied":
		case "duplicate":
			return created.has(item.changeIndex)
				? appliedReason
				: "already-on-roadmap";
		default: {
			const unhandled: never = item.reason;
			return unhandled;
		}
	}
}

export function deriveProposalItemState(params: {
	resolvedItems: readonly ResolvedProposalItem[];
	/** The items this proposal created or updated (application table). */
	createdChangeIndexes: readonly number[];
	applications?: readonly ProposalApplication[];
	duplicateResolutions?: readonly ProposalDuplicateResolution[];
	appliedReason: "accepted" | "applied";
	/** Existing tickets the last approve matched instead of creating. */
	skippedTargets?: ReadonlyMap<number, string>;
	/** Rejected items restored from the Rejected list. */
	restoredItems?: readonly RestoredProposalItem[];
}): ProposalItemState {
	const created = new Set(params.createdChangeIndexes);
	const restoredItems = params.restoredItems ?? [];
	const restored = new Set(restoredItems.map((item) => item.changeIndex));
	const lockedReasons = new Map<number, LockedReason>(
		params.resolvedItems.map((item) => [
			item.changeIndex,
			lockedReasonFor(item, created, restored, params.appliedReason),
		]),
	);

	const lockedTargets = new Map<number, string>();
	const setTarget = (index: number, storyId: string | null) => {
		if (storyId && lockedReasons.has(index)) {
			lockedTargets.set(index, storyId);
		}
	};
	for (const [index, storyId] of params.skippedTargets ?? []) {
		setTarget(index, storyId);
	}
	for (const duplicate of params.duplicateResolutions ?? []) {
		setTarget(duplicate.changeIndex, duplicate.existingEntityId);
	}
	for (const application of params.applications ?? []) {
		setTarget(application.changeIndex, application.createdEntityId);
	}
	for (const item of restoredItems) {
		setTarget(item.changeIndex, item.storyId);
	}

	const reasons = Array.from(lockedReasons.values());
	const countOf = (reason: LockedReason) =>
		reasons.filter((r) => r === reason).length;
	return {
		lockedReasons,
		lockedTargets,
		appliedCount: countOf(params.appliedReason),
		alreadyOnRoadmapCount: countOf("already-on-roadmap"),
	};
}

/** "3 changes", or "2 of 3 changes left" once some are resolved. */
export function changeCountLabel(row: {
	changeCount: number;
	remainingCount: number;
}): string {
	const plural = row.changeCount !== 1 ? "s" : "";
	const total = `${row.changeCount} change${plural}`;
	return row.remainingCount < row.changeCount
		? `${row.remainingCount} of ${total} left`
		: total;
}
