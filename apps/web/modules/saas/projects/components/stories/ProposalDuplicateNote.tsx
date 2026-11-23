"use client";

/**
 * "Possible duplicate" note on one inbox proposal item: what it may duplicate
 * (a roadmap ticket, another pending item, or a sibling in the same
 * proposal) and how similar it is. Advisory only; the reviewer still
 * approves, moves to Rejected, or merges by choosing an Enrich target. A
 * matched inbox item, of another proposal or of this one, can be merged into
 * this item or moved to Rejected from here, as the manual create dialog
 * offers for an inbox match; another proposal can also be opened. Leaving
 * both items in review is the reviewer's other choice.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	ArchiveIcon,
	CopyIcon,
	InboxIcon,
	Loader2Icon,
	type LucideIcon,
	MergeIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import type { BacklogProposalPanel } from "../../../../analytics/events/backlog-open-existing";
import {
	type ProposalDuplicateItemMatch,
	type ProposalDuplicateMatch,
	type ProposalDuplicateStoryMatch,
	similarityPercent,
} from "./proposal-duplicate-flags";
import { invalidateProposalInboxQueries } from "./proposal-inbox-client";
import { StoryNewTabLink } from "./StoryNewTabLink";

type Props = {
	matches: ProposalDuplicateMatch[];
	/** The item's duplicate check has no final answer yet: a candidate still
	 * waits for the verifier, or the item is still to be compared. */
	checking?: boolean;
	itemTitle: string;
	projectId?: string;
	organizationId?: string | null;
	/** The open proposal, to tell a sibling item from another proposal's. */
	proposalId?: string;
	/** This item's index in the open proposal; absent when nothing can be
	 * merged into it (the proposal is not in review). */
	changeIndex?: number;
	/** The ticket this item is already set to enrich, if any. */
	enrichTargetStoryId?: string;
	/** Absent when the item cannot be re-routed (e.g. it is resolved). */
	onUseAsEnrichTarget?: (match: ProposalDuplicateStoryMatch) => void;
	onOpenProposal?: (proposalId: string) => void;
	disabled?: boolean;
	panel?: BacklogProposalPanel;
};

const matchKey = (match: ProposalDuplicateMatch) =>
	match.kind === "story"
		? `story:${match.storyId}`
		: `item:${match.proposalId}:${match.matchChangeIndex}`;

/**
 * One action on a matched inbox item, run at once and without a
 * confirmation, like the create dialog's inbox matches. Either moves the
 * item to Rejected, or merges it into this item, which also moves it to
 * Rejected; both are recoverable from the Rejected list. The refreshed flags
 * drop the match; until then it is hidden here.
 */
function MatchedItemActionButton({
	label,
	ariaLabel,
	icon: Icon,
	run,
	successTitle,
	errorTitle,
	projectId,
	organizationId,
	disabled,
	onDone,
}: {
	label: string;
	ariaLabel: string;
	icon: LucideIcon;
	run: () => Promise<unknown>;
	successTitle: string;
	errorTitle: string;
	projectId: string;
	organizationId: string | null;
	disabled: boolean;
	onDone: () => void;
}) {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: run,
		onSuccess: () => {
			invalidateProposalInboxQueries(
				queryClient,
				projectId,
				organizationId,
			);
			toast.success(successTitle, {
				description:
					"Find it anytime in Rejected proposals on your roadmap.",
			});
			onDone();
		},
		onError: (error) => {
			toast.error(errorTitle, {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});
	return (
		<Button
			type="button"
			size="sm"
			variant="ghost"
			className="h-6 px-2 text-xs"
			disabled={disabled || mutation.isPending}
			aria-label={ariaLabel}
			onClick={() => mutation.mutate()}
		>
			{mutation.isPending ? (
				<Loader2Icon
					aria-hidden="true"
					className="size-3 motion-safe:animate-spin"
				/>
			) : (
				<Icon aria-hidden="true" className="size-3" />
			)}
			{label}
		</Button>
	);
}

/**
 * The resolutions offered for a matched inbox item: merge it into this item
 * (it then moves to Rejected), or move it to Rejected as it stands. A match
 * in another proposal can also be opened. A sibling in this proposal gets the
 * same merge and move, through the same per-item procedures and their
 * permission checks; the merge goes into this item, as for another
 * proposal's match. Leaving both items is the reviewer's other choice.
 */
function MatchedItemActions({
	match,
	itemTitle,
	projectId,
	organizationId,
	proposalId,
	changeIndex,
	onOpenProposal,
	disabled,
	onDone,
}: {
	match: ProposalDuplicateItemMatch;
	itemTitle: string;
	projectId?: string;
	organizationId: string | null;
	proposalId?: string;
	changeIndex?: number;
	onOpenProposal?: (proposalId: string) => void;
	disabled: boolean;
	onDone: () => void;
}) {
	const sibling = match.proposalId === proposalId;
	return (
		<>
			{!sibling && onOpenProposal && (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="h-6 px-2 text-xs"
					aria-label={`Open the proposal with ${match.title}`}
					onClick={() => onOpenProposal(match.proposalId)}
				>
					Open proposal
				</Button>
			)}
			{projectId && proposalId && changeIndex !== undefined && (
				<MatchedItemActionButton
					label={
						sibling
							? "Merge into this item"
							: "Merge into this proposal"
					}
					ariaLabel={`Merge the matched item ${match.title} into ${itemTitle}`}
					icon={MergeIcon}
					run={() =>
						orpcClient.projects.backlog.proposals.mergeIntoItem({
							projectId,
							organizationId,
							proposalId,
							changeIndex,
							source: {
								proposalId: match.proposalId,
								changeIndex: match.matchChangeIndex,
							},
						})
					}
					successTitle={`Merged “${match.title}” into “${itemTitle}”`}
					errorTitle={`Couldn't merge “${match.title}”`}
					projectId={projectId}
					organizationId={organizationId}
					disabled={disabled}
					onDone={onDone}
				/>
			)}
			{projectId && (
				<MatchedItemActionButton
					label="Move matched item to Rejected"
					ariaLabel={`Move the matched item ${match.title} to Rejected`}
					icon={ArchiveIcon}
					run={() =>
						orpcClient.projects.backlog.proposals.rejectItem({
							projectId,
							organizationId,
							proposalId: match.proposalId,
							changeIndex: match.matchChangeIndex,
						})
					}
					successTitle={`Moved “${match.title}” to Rejected`}
					errorTitle={`Couldn't move “${match.title}” to Rejected`}
					projectId={projectId}
					organizationId={organizationId}
					disabled={disabled}
					onDone={onDone}
				/>
			)}
		</>
	);
}

/** Says the item is still being checked for duplicates. */
function StillCheckingNote({ className }: { className?: string }) {
	return (
		<p
			role="status"
			className={cn(
				"flex items-center gap-1 text-muted-foreground text-xs",
				className,
			)}
		>
			<Loader2Icon
				aria-hidden="true"
				className="size-3 shrink-0 motion-safe:animate-spin"
			/>
			Still checking for possible duplicates…
		</p>
	);
}

export function ProposalDuplicateNote({
	matches,
	checking = false,
	itemTitle,
	projectId,
	organizationId = null,
	proposalId,
	changeIndex,
	enrichTargetStoryId,
	onUseAsEnrichTarget,
	onOpenProposal,
	disabled = false,
	panel,
}: Props) {
	const headingId = useId();
	const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const hide = (match: ProposalDuplicateItemMatch) =>
		setHiddenKeys((prev) => new Set(prev).add(matchKey(match)));
	const visible = matches.filter((match) => !hiddenKeys.has(matchKey(match)));
	if (visible.length === 0) {
		return checking ? <StillCheckingNote className="mt-2" /> : null;
	}
	return (
		<section
			aria-labelledby={headingId}
			className="mt-2 space-y-1.5 rounded-md border border-amber-300/70 bg-amber-50/60 p-2 text-xs dark:border-amber-800/70 dark:bg-amber-950/30"
		>
			<p
				id={headingId}
				className="flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300"
			>
				<CopyIcon aria-hidden="true" className="size-3.5 shrink-0" />
				<span>
					Possible duplicate
					<span className="sr-only"> of {itemTitle}</span>
				</span>
			</p>
			<ul className="space-y-1">
				{visible.map((match) => (
					<li
						key={matchKey(match)}
						className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
					>
						{match.kind === "story" ? (
							<span className="shrink-0 font-mono text-muted-foreground">
								{match.identifier}
							</span>
						) : (
							<span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
								<InboxIcon
									aria-hidden="true"
									className="size-3"
								/>
								{match.proposalId === proposalId
									? `Item ${match.matchChangeIndex + 1} of this proposal`
									: "Pending proposal"}
							</span>
						)}
						{/* Wraps instead of truncating: beside the label and
						    the actions a truncated title shrank to a letter. */}
						<span className="min-w-0 flex-1 basis-48 break-words">
							{match.title}
						</span>
						<Badge variant="outline">
							{similarityPercent(match.similarity)}% similar
						</Badge>
						{match.kind === "story" ? (
							<>
								{projectId && (
									<StoryNewTabLink
										projectId={projectId}
										storyId={match.storyId}
										panel={panel}
										label={`Open ${match.identifier} in a new tab`}
									>
										Open
									</StoryNewTabLink>
								)}
								{match.storyId === enrichTargetStoryId ? (
									<span className="text-muted-foreground">
										Enrich target
									</span>
								) : (
									onUseAsEnrichTarget && (
										<Button
											type="button"
											size="sm"
											variant="outline"
											className="h-6 px-2 text-xs"
											disabled={disabled}
											aria-label={`Enrich ${match.identifier} with ${itemTitle} instead of creating a new ticket`}
											onClick={() =>
												onUseAsEnrichTarget(match)
											}
										>
											<MergeIcon
												aria-hidden="true"
												className="size-3"
											/>
											Use as Enrich target
										</Button>
									)
								)}
							</>
						) : (
							<MatchedItemActions
								match={match}
								itemTitle={itemTitle}
								projectId={projectId}
								organizationId={organizationId}
								proposalId={proposalId}
								changeIndex={changeIndex}
								onOpenProposal={onOpenProposal}
								disabled={disabled}
								onDone={() => hide(match)}
							/>
						)}
					</li>
				))}
			</ul>
			{checking && <StillCheckingNote />}
		</section>
	);
}
