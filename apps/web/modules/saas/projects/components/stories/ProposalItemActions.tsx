"use client";

/**
 * Per-item decisions on a pending inbox proposal: approve one item, or move
 * it to Rejected, while its siblings stay in review. Each button commits at
 * once; the multi-select "Apply Selected" flow is unchanged.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	ArchiveIcon,
	CheckIcon,
	ListChecksIcon,
	Loader2Icon,
} from "lucide-react";
import { useId } from "react";
import type { BacklogProposalPanel } from "../../../../analytics/events/backlog-open-existing";
import type { SkippableField } from "./BacklogChangeDetailDialog";
import type { ChangeItem } from "./BacklogChangeProposal";
import {
	type RoutingAnnotation,
	type RoutingOverride,
	routingBlocker,
} from "./ProposalRoutingControl";
import { LOCKED_REASON_COPY, type LockedReason } from "./proposal-item-state";
import { StoryNewTabLink } from "./StoryNewTabLink";

/**
 * A resolved row's status: what happened to it and, once it reached the
 * Roadmap, a new-tab link to the ticket it created, updated or matched.
 */
export function LockedRowStatus({
	reason,
	itemTitle,
	projectId,
	targetStoryId,
	panel,
}: {
	reason: LockedReason;
	itemTitle: string;
	projectId?: string;
	targetStoryId: string | null;
	panel?: BacklogProposalPanel;
}) {
	const rejected = reason === "rejected";
	return (
		<span className="inline-flex items-center gap-1">
			<Badge variant="outline" className="gap-1 text-xs">
				{rejected ? (
					<ArchiveIcon aria-hidden className="size-3" />
				) : (
					<CheckIcon aria-hidden className="size-3" />
				)}
				{LOCKED_REASON_COPY[reason].badge}
			</Badge>
			{!rejected && targetStoryId && projectId && (
				<StoryNewTabLink
					projectId={projectId}
					storyId={targetStoryId}
					panel={panel}
					label={`Open the ticket for ${itemTitle} in a new tab`}
				>
					Open ticket
				</StoryNewTabLink>
			)}
		</span>
	);
}

/** Why one item cannot be approved yet, or null when it can. */
export function itemApproveBlockedReason(
	routing: RoutingAnnotation | null | undefined,
	override: RoutingOverride | undefined,
): string | null {
	if (!routing) {
		return null;
	}
	const blocker = routingBlocker(routing, override);
	switch (blocker) {
		case null:
			return null;
		case "target-required":
			return "Choose a ticket to enrich before approving this item.";
		case "closed-target-unconfirmed":
			return "Confirm the closed target ticket before approving this item.";
		default: {
			const unhandled: never = blocker;
			return unhandled;
		}
	}
}

/**
 * What an item's Approve button says it applies. An update proposal reviewed
 * Fast reads "Apply all changes", or "Apply accepted changes" once the
 * reviewer rejected one of its proposed fields. A create routed to enrich an
 * existing ticket, and anything without a line-by-line review, reads
 * "Approve".
 */
export function itemApproveLabel(
	change: ChangeItem | undefined,
	lineReview: boolean,
	skippedFields: ReadonlySet<SkippableField> | undefined,
): string {
	if (!change || !lineReview || change.routing) {
		return "Approve";
	}
	return rejectsAProposedField(change, skippedFields)
		? "Apply accepted changes"
		: "Apply all changes";
}

function rejectsAProposedField(
	change: ChangeItem,
	skipped: ReadonlySet<SkippableField> | undefined,
): boolean {
	if (!skipped || skipped.size === 0) {
		return false;
	}
	return Array.from(skipped).some((field) => {
		switch (field) {
			case "title":
				return (
					change.title.from !== undefined &&
					change.title.from !== change.title.to
				);
			case "description":
			case "acceptanceCriteria":
			case "priority":
			case "size":
				return change[field] !== undefined;
			default: {
				const unhandled: never = field;
				return unhandled;
			}
		}
	});
}

type Props = {
	itemTitle: string;
	onApprove: () => void;
	onMoveToRejected: () => void;
	/** Another proposal action is in flight. */
	disabled: boolean;
	approveBlockedReason: string | null;
	/** The action in flight for this item, if any. */
	pendingAction: "approve" | "reject" | null;
	/** The Approve button's text, from `itemApproveLabel`. */
	approveLabel: string;
	/**
	 * Update items only: opens the target ticket with the changes pending a
	 * line-by-line review (Thorough).
	 */
	onReviewLineByLine?: () => void;
};

export function ProposalItemActions({
	itemTitle,
	onApprove,
	onMoveToRejected,
	disabled,
	approveBlockedReason,
	pendingAction,
	approveLabel,
	onReviewLineByLine,
}: Props) {
	const reasonId = useId();
	return (
		<div className="mt-2 flex flex-wrap items-center gap-2">
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="h-7 px-2 text-xs"
				onClick={onApprove}
				data-item-approve=""
				disabled={disabled || approveBlockedReason !== null}
				aria-label={
					approveLabel === "Approve"
						? `Approve ${itemTitle}`
						: `${approveLabel} to ${itemTitle}`
				}
				aria-describedby={approveBlockedReason ? reasonId : undefined}
			>
				{pendingAction === "approve" ? (
					<Loader2Icon
						className="size-3.5 motion-safe:animate-spin"
						aria-hidden="true"
					/>
				) : (
					<CheckIcon className="size-3.5" aria-hidden="true" />
				)}
				{approveLabel}
			</Button>
			{onReviewLineByLine && (
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="h-7 px-2 text-xs"
					onClick={onReviewLineByLine}
					disabled={disabled || approveBlockedReason !== null}
					aria-label={`Review ${itemTitle} line by line`}
					aria-describedby={
						approveBlockedReason ? reasonId : undefined
					}
				>
					<ListChecksIcon className="size-3.5" aria-hidden="true" />
					Review line by line
				</Button>
			)}
			<Button
				type="button"
				size="sm"
				variant="ghost"
				className="h-7 px-2 text-xs"
				onClick={onMoveToRejected}
				disabled={disabled}
				aria-label={`Move ${itemTitle} to Rejected`}
			>
				{pendingAction === "reject" ? (
					<Loader2Icon
						className="size-3.5 motion-safe:animate-spin"
						aria-hidden="true"
					/>
				) : (
					<ArchiveIcon className="size-3.5" aria-hidden="true" />
				)}
				Move to Rejected
			</Button>
			{approveBlockedReason && (
				<p id={reasonId} className="text-muted-foreground text-xs">
					{approveBlockedReason}
				</p>
			)}
		</div>
	);
}
