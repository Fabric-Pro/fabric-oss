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

type Props = {
	itemTitle: string;
	onApprove: () => void;
	onMoveToRejected: () => void;
	/** Another proposal action is in flight. */
	disabled: boolean;
	approveBlockedReason: string | null;
	/** The action in flight for this item, if any. */
	pendingAction: "approve" | "reject" | null;
	/**
	 * Update items only: Approve reads "Apply all changes" (Fast review) and
	 * this opens the item for line-by-line review (Thorough).
	 */
	onReviewLineByLine?: () => void;
	/** Why line-by-line review is unavailable for this update, or null. */
	lineReviewBlockedReason?: string | null;
};

export function ProposalItemActions({
	itemTitle,
	onApprove,
	onMoveToRejected,
	disabled,
	approveBlockedReason,
	pendingAction,
	onReviewLineByLine,
	lineReviewBlockedReason = null,
}: Props) {
	const reasonId = useId();
	const lineReviewReasonId = useId();
	return (
		<div className="mt-2 flex flex-wrap items-center gap-2">
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="h-7 px-2 text-xs"
				onClick={onApprove}
				disabled={disabled || approveBlockedReason !== null}
				aria-label={
					onReviewLineByLine
						? `Apply all changes to ${itemTitle}`
						: `Approve ${itemTitle}`
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
				{onReviewLineByLine ? "Apply all changes" : "Approve"}
			</Button>
			{onReviewLineByLine && (
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="h-7 px-2 text-xs"
					onClick={onReviewLineByLine}
					disabled={disabled || lineReviewBlockedReason !== null}
					aria-label={`Review ${itemTitle} line by line`}
					aria-describedby={
						lineReviewBlockedReason ? lineReviewReasonId : undefined
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
			{onReviewLineByLine && lineReviewBlockedReason && (
				<p
					id={lineReviewReasonId}
					className="text-muted-foreground text-xs"
				>
					{lineReviewBlockedReason}
				</p>
			)}
		</div>
	);
}
