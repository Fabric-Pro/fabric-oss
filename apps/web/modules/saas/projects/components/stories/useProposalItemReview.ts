/**
 * Per-item review of an inbox proposal, which stays open while any item is
 * undecided: which items are resolved (locked) and why, and the decisions
 * one item takes on its own — approve it, move it to Rejected, or review an
 * update line by line on its ticket. The proposal view keeps the
 * multi-select "Apply Selected" flow; this hook owns everything a single
 * item decides.
 */

import type { UpdateBodies } from "@repo/utils/proposal-update-edits";
import type {
	DetailItemDecision,
	DetailItemResolution,
	SkippableField,
} from "./BacklogChangeDetailDialog";
import type { ChangeItem } from "./BacklogChangeProposal";
import {
	itemApproveBlockedReason,
	itemApproveLabel,
} from "./ProposalItemActions";
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

type PmSyncOverride = { pushAnyway?: boolean; skip?: boolean };

type ItemCommit = (
	approvedChange: ChangeItem,
	syncToPM: boolean,
	pmSyncOverrides: Record<number, PmSyncOverride> | undefined,
	changeIndex: number,
) => void;

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
	onApproveItem?: ItemCommit;
	/** Move one item to Rejected. */
	onRejectItem?: (changeIndex: number, itemTitle: string) => void;
	/**
	 * Open an update's target ticket with the change, built as for
	 * `onApproveItem`, pending a line-by-line review there.
	 */
	onReviewOnTicket?: ItemCommit;
	/** The per-item action in flight, for its spinner. */
	pendingItemAction?: PendingItemAction | null;
	/** Possible duplicates of each unresolved item, by index. */
	duplicateFlags?: ProposalDuplicateFlags;
	/** Items whose duplicate check has no final answer yet. */
	duplicateChecking?: ReadonlySet<number>;
	/** The first duplicate check is running: no item has an answer yet. */
	duplicateLoading?: boolean;
	/** Open the proposal a duplicate note points at. */
	onOpenProposal?: (proposalId: string) => void;
	/** Update items whose ticket changed after the proposal was made. */
	targetChangedIndexes?: ReadonlySet<number>;
	/**
	 * The ticket's bodies as they are now, by index, for the update items
	 * whose body has no `from`.
	 */
	updateTargetBodies?: ReadonlyMap<number, UpdateBodies>;
	/**
	 * Update items whose target is not a work item in this project, by the
	 * server's own hold-back rule: an approval would hold them back.
	 */
	heldBackUpdateIndexes?: ReadonlySet<number>;
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
	/**
	 * Why the parent blocks one item's approval: an update whose target is
	 * not in this project, or a re-routed item whose change summary is not
	 * read yet.
	 */
	itemBlockedReasonOf: (index: number) => string | null;
	/** The fields the reviewer rejected on one item. */
	skippedFieldsOf: (index: number) => ReadonlySet<SkippableField> | undefined;
}) {
	const { review, changes, routingOverridesByIndex } = params;
	const lockedReasons = review?.lockedReasons ?? NO_LOCKED_REASONS;
	const lockedTargets = review?.lockedTargets ?? NO_LOCKED_TARGETS;
	const targetChangedIndexes = review?.targetChangedIndexes ?? NO_INDEXES;
	const onApproveItem = review?.onApproveItem;
	const onRejectItem = review?.onRejectItem;
	const onReviewOnTicket = review?.onReviewOnTicket;
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
		) ?? params.itemBlockedReasonOf(index);
	const isActionDisabled = (index: number): boolean =>
		params.actionsBusy ||
		lockedReasons.has(index) ||
		params.reformattingIndex === index;
	const effectiveRoutingOf = (index: number) =>
		resolveEffectiveRouting(
			changes[index]?.routing ?? undefined,
			routingOverridesByIndex.get(index),
		);

	// Approve the item, or take it to its ticket for line-by-line review:
	// either way with the change as the reviewer left it.
	const commitItem = (commit: ItemCommit | undefined, index: number) => {
		if (
			!commit ||
			isActionDisabled(index) ||
			blockedReasonOf(index) !== null
		) {
			return;
		}
		params.cancelRunningDraft(index);
		const entry = params.pmSyncOverrideFor(index);
		commit(
			params.buildApprovedChange(index),
			params.syncToPM,
			entry ? { 0: entry } : undefined,
			index,
		);
	};
	const approveItem = (index: number) => commitItem(onApproveItem, index);
	// Offered on an unresolved update, original or re-routed: the ticket
	// page merges it into the ticket as it is now before showing it.
	const reviewOnTicketOf = (index: number): (() => void) | undefined => {
		if (
			!actionsEnabled ||
			!onReviewOnTicket ||
			lockedReasons.has(index) ||
			params.buildApprovedChange(index).action !== "update"
		) {
			return undefined;
		}
		return () => commitItem(onReviewOnTicket, index);
	};
	const approveLabelOf = (index: number): string =>
		itemApproveLabel(
			changes[index],
			reviewOnTicketOf(index) !== undefined,
			params.skippedFieldsOf(index),
		);

	const rejectItem = (index: number) => {
		if (!onRejectItem || isActionDisabled(index)) {
			return;
		}
		onRejectItem(index, changes[index]?.title.to ?? "");
	};

	// The ticket behind a locked row: what it created or matched, else the
	// target an update named. A rejected item wrote nothing, and a restored
	// one only the ticket its restore applied: one still applying, or whose
	// apply failed, has none.
	const lockedTargetOf = (index: number): string | null => {
		const target = lockedTargets.get(index);
		if (target) {
			return target;
		}
		const change = changes[index];
		const reason = lockedReasons.get(index);
		if (
			reason === "rejected" ||
			reason === "restored" ||
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
		targetBodiesOf: (index: number): UpdateBodies | undefined =>
			review?.updateTargetBodies?.get(index),
		reviewOnTicketOf,
		approveLabelOf,
		pendingActionOf: (index: number): PendingItemAction["action"] | null =>
			review?.pendingItemAction?.changeIndex === index
				? review.pendingItemAction.action
				: null,
		duplicateMatchesOf: (index: number): ProposalDuplicateMatch[] =>
			(review?.duplicateFlags ?? NO_DUPLICATE_FLAGS).get(index) ?? [],
		/** Whether the item's duplicate check has no final answer yet. */
		stillCheckingOf: (index: number): boolean =>
			review?.duplicateLoading === true ||
			(review?.duplicateChecking?.has(index) ?? false),
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
			return {
				onApprove: () => approveItem(index),
				onMoveToRejected: () => rejectItem(index),
				approveBlockedReason: blockedReasonOf(index),
				busy: isActionDisabled(index),
				onReviewOnTicket: reviewOnTicketOf(index),
			};
		},
	};
}
