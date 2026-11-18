/**
 * Per-item review of an inbox proposal, which stays open while any item is
 * undecided: which items are resolved (locked) and why, and the decisions
 * one item takes on its own — approve it, move it to Rejected, or review an
 * update line by line. The proposal view keeps the multi-select
 * "Apply Selected" flow; this hook owns everything a single item decides.
 */

import type { ChangeItem } from "./BacklogChangeProposal";
import type {
	DetailItemDecision,
	DetailItemResolution,
} from "./BacklogChangeDetailDialog";
import { itemApproveBlockedReason } from "./ProposalItemActions";
import { LINE_REVIEW_TARGET_CHANGED } from "./ProposalItemNotes";
import {
	type RoutingOverride,
	resolveEffectiveRouting,
} from "./ProposalRoutingControl";
import {
	NO_DUPLICATE_FLAGS,
	type ProposalDuplicateFlags,
	type ProposalDuplicateMatch,
} from "./proposal-duplicate-flags";
import {
	LOCKED_REASON_COPY,
	type LockedReason,
	type PendingItemAction,
} from "./proposal-item-state";
import { applyLineDecisions, type LineDecisions } from "./proposal-line-review";

type PmSyncOverride = { pushAnyway?: boolean; skip?: boolean };

/** What the inbox hands the proposal view for per-item review. */
export type ProposalItemReview = {
	/**
	 * Resolved items and why each is locked. They render with their outcome,
	 * cannot be selected, and are never submitted again, even from a stale
	 * persisted selection. The `changes` array is not filtered: review state
	 * is kept by index.
	 */
	lockedReasons: ReadonlyMap<number, LockedReason>;
	/**
	 * The ticket a resolved item created, updated or matched, by index. A
	 * resolved update with no entry links to its own target.
	 */
	lockedTargets?: ReadonlyMap<number, string>;
	/**
	 * Commit one item at once from its row or its detail dialog, leaving the
	 * others in review; offered on PENDING proposals, with `onRejectItem`.
	 * The change carries that item's kind/routing overrides, field skips and
	 * draft; its PM-sync override, if any, is keyed `0`.
	 */
	onApproveItem?: (
		approvedChange: ChangeItem,
		syncToPM: boolean,
		pmSyncOverrides: Record<number, PmSyncOverride> | undefined,
		changeIndex: number,
	) => void;
	/**
	 * Move one item to Rejected. `noteRejectedUpdate` marks an update whose
	 * every change the reviewer rejected line by line.
	 */
	onRejectItem?: (
		changeIndex: number,
		itemTitle: string,
		noteRejectedUpdate: boolean,
	) => void;
	/** The per-item action in flight, for its spinner. */
	pendingItemAction?: PendingItemAction | null;
	/** Possible duplicates of each unresolved item, by index. */
	duplicateFlags?: ProposalDuplicateFlags;
	/** Open the proposal a duplicate note points at. */
	onOpenProposal?: (proposalId: string) => void;
	/** Update items whose ticket changed after the proposal was made. */
	targetChangedIndexes?: ReadonlySet<number>;
};

const NO_LOCKED_REASONS: ReadonlyMap<number, LockedReason> = new Map();

const NO_LOCKED_TARGETS: ReadonlyMap<number, string> = new Map();

const NO_INDEXES: ReadonlySet<number> = new Set();

export function useProposalItemReview(params: {
	review: ProposalItemReview | undefined;
	changes: readonly ChangeItem[];
	proposalStatus: string | undefined;
	routingOverridesByIndex: ReadonlyMap<number, RoutingOverride>;
	/** The parent has a proposal action in flight. */
	actionsBusy: boolean;
	reformattingIndex: number | null;
	syncToPM: boolean;
	/** The change as the reviewer left it, ready to submit. */
	buildApprovedChange: (index: number) => ChangeItem;
	pmSyncOverrideFor: (index: number) => PmSyncOverride | undefined;
	/** Stop the item's in-review draft before it is applied. */
	cancelRunningDraft: (index: number) => void;
}) {
	const { review, changes, routingOverridesByIndex } = params;
	const lockedReasons = review?.lockedReasons ?? NO_LOCKED_REASONS;
	const lockedTargets = review?.lockedTargets ?? NO_LOCKED_TARGETS;
	const targetChangedIndexes = review?.targetChangedIndexes ?? NO_INDEXES;
	const onApproveItem = review?.onApproveItem;
	const onRejectItem = review?.onRejectItem;
	// Unlike Apply Selected, per-item decisions never collapse the view: the
	// parent refreshes the proposal, the item locks, and its siblings keep
	// every piece of review state. A failed proposal stays in review: the
	// server takes per-item decisions on it as it does on a pending one.
	const actionsEnabled =
		(params.proposalStatus === "PENDING" ||
			params.proposalStatus === "FAILED") &&
		!!onApproveItem &&
		!!onRejectItem;

	const blockedReasonOf = (index: number): string | null =>
		itemApproveBlockedReason(
			changes[index]?.routing,
			routingOverridesByIndex.get(index),
		);
	const isActionDisabled = (index: number): boolean =>
		params.actionsBusy ||
		lockedReasons.has(index) ||
		params.reformattingIndex === index;
	const effectiveRoutingOf = (index: number) =>
		resolveEffectiveRouting(
			changes[index]?.routing ?? undefined,
			routingOverridesByIndex.get(index),
		);

	// `lineDecisions`: the item was reviewed line by line, so only its
	// accepted description / acceptance-criteria changes are applied.
	const approveItem = (index: number, lineDecisions?: LineDecisions) => {
		if (
			!onApproveItem ||
			isActionDisabled(index) ||
			blockedReasonOf(index) !== null
		) {
			return;
		}
		params.cancelRunningDraft(index);
		const entry = params.pmSyncOverrideFor(index);
		const approved = params.buildApprovedChange(index);
		onApproveItem(
			lineDecisions
				? applyLineDecisions(approved, lineDecisions)
				: approved,
			params.syncToPM,
			entry ? { 0: entry } : undefined,
			index,
		);
	};

	const rejectItem = (index: number, noteRejectedUpdate = false) => {
		if (!onRejectItem || isActionDisabled(index)) {
			return;
		}
		onRejectItem(index, changes[index]?.title.to ?? "", noteRejectedUpdate);
	};

	// The ticket behind a locked row: what it created or matched, else the
	// target an update named.
	const lockedTargetOf = (index: number): string | null => {
		const target = lockedTargets.get(index);
		if (target) {
			return target;
		}
		const change = changes[index];
		if (
			lockedReasons.get(index) === "rejected" ||
			change?.action !== "update"
		) {
			return null;
		}
		return change.existingId ?? null;
	};

	// Only an open item still waits to be merged into the changed ticket.
	const targetChanged = (index: number): boolean =>
		!lockedReasons.has(index) && targetChangedIndexes.has(index);

	return {
		actionsEnabled,
		lockedReasonOf: (index: number): LockedReason | undefined =>
			lockedReasons.get(index),
		lockedTargetOf,
		blockedReasonOf,
		isActionDisabled,
		approveItem,
		rejectItem,
		targetChanged,
		lineReviewBlockedReasonOf: (index: number): string | null =>
			targetChanged(index) ? LINE_REVIEW_TARGET_CHANGED : null,
		pendingActionOf: (index: number): PendingItemAction["action"] | null =>
			review?.pendingItemAction?.changeIndex === index
				? review.pendingItemAction.action
				: null,
		duplicateMatchesOf: (index: number): ProposalDuplicateMatch[] =>
			(review?.duplicateFlags ?? NO_DUPLICATE_FLAGS).get(index) ?? [],
		openProposal: review?.onOpenProposal,
		/** The ticket the item is set to enrich, if any. */
		enrichTargetOf: (index: number): string | undefined => {
			const effective = effectiveRoutingOf(index);
			return effective?.decision === "enrich"
				? effective.targetStoryId
				: undefined;
		},
		/** A locked row as the detail dialog shows it. */
		resolutionOf: (index: number): DetailItemResolution | undefined => {
			const reason = lockedReasons.get(index);
			if (reason === undefined) {
				return undefined;
			}
			const rejected = reason === "rejected";
			return {
				label: LOCKED_REASON_COPY[reason].badge,
				rejected,
				storyId: rejected ? null : lockedTargetOf(index),
			};
		},
		/** The detail dialog's own decision on an unresolved item. */
		decisionOf: (index: number): DetailItemDecision | undefined => {
			if (!actionsEnabled || lockedReasons.has(index)) {
				return undefined;
			}
			// Line review applies to the update as proposed against the
			// ticket it was compared with: not to a re-routed item, nor to a
			// ticket that changed since.
			const lineReviewable =
				effectiveRoutingOf(index)?.overridden !== true &&
				!targetChanged(index);
			return {
				onApprove: () => approveItem(index),
				onMoveToRejected: () => rejectItem(index),
				approveBlockedReason: blockedReasonOf(index),
				busy: isActionDisabled(index),
				lineReview: lineReviewable
					? {
							onApplyReviewed: (decisions) =>
								approveItem(index, decisions),
							onRejectAll: () => rejectItem(index, true),
						}
					: undefined,
				lineReviewBlockedReason: targetChanged(index)
					? LINE_REVIEW_TARGET_CHANGED
					: null,
			};
		},
	};
}
