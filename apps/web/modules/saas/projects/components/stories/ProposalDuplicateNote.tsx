"use client";

/**
 * "Possible duplicate" note on one inbox proposal item: what it may duplicate
 * (a roadmap ticket, another pending item, or a sibling in the same
 * proposal) and how similar it is. Advisory only; the reviewer still
 * approves, moves to Rejected, or merges by choosing an Enrich target. An
 * item of another proposal can be opened, or moved to Rejected from here,
 * as the manual create dialog offers for an inbox match.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	ArchiveIcon,
	CopyIcon,
	InboxIcon,
	Loader2Icon,
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
	itemTitle: string;
	projectId?: string;
	organizationId?: string | null;
	/** The open proposal, to tell a sibling item from another proposal's. */
	proposalId?: string;
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
 * Move another proposal's matched item to Rejected (recoverable from the
 * Rejected list), at once and without a confirmation, like the create
 * dialog's inbox matches. The refreshed flags drop it; until then it is
 * hidden here.
 */
function RejectMatchedItemButton({
	match,
	projectId,
	organizationId,
	disabled,
	onRejected,
}: {
	match: ProposalDuplicateItemMatch;
	projectId: string;
	organizationId: string | null;
	disabled: boolean;
	onRejected: () => void;
}) {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.backlog.proposals.rejectItem({
				projectId,
				organizationId,
				proposalId: match.proposalId,
				changeIndex: match.matchChangeIndex,
			}),
		onSuccess: () => {
			invalidateProposalInboxQueries(
				queryClient,
				projectId,
				organizationId,
			);
			toast.success(`Moved “${match.title}” to Rejected`, {
				description:
					"Find it anytime in Rejected proposals on your roadmap.",
			});
			onRejected();
		},
		onError: (error) => {
			toast.error(`Couldn't move “${match.title}” to Rejected`, {
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
			aria-label={`Move the matched item ${match.title} to Rejected`}
			onClick={() => mutation.mutate()}
		>
			{mutation.isPending ? (
				<Loader2Icon
					aria-hidden="true"
					className="size-3 motion-safe:animate-spin"
				/>
			) : (
				<ArchiveIcon aria-hidden="true" className="size-3" />
			)}
			Move matched item to Rejected
		</Button>
	);
}

export function ProposalDuplicateNote({
	matches,
	itemTitle,
	projectId,
	organizationId = null,
	proposalId,
	enrichTargetStoryId,
	onUseAsEnrichTarget,
	onOpenProposal,
	disabled = false,
	panel,
}: Props) {
	const headingId = useId();
	const [rejectedKeys, setRejectedKeys] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const visible = matches.filter(
		(match) => !rejectedKeys.has(matchKey(match)),
	);
	if (visible.length === 0) {
		return null;
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
						<span className="min-w-0 flex-1 truncate">
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
							match.proposalId !== proposalId && (
								<>
									{onOpenProposal && (
										<Button
											type="button"
											size="sm"
											variant="ghost"
											className="h-6 px-2 text-xs"
											aria-label={`Open the proposal with ${match.title}`}
											onClick={() =>
												onOpenProposal(match.proposalId)
											}
										>
											Open proposal
										</Button>
									)}
									{projectId && (
										<RejectMatchedItemButton
											match={match}
											projectId={projectId}
											organizationId={organizationId}
											disabled={disabled}
											onRejected={() =>
												setRejectedKeys((prev) =>
													new Set(prev).add(
														matchKey(match),
													),
												)
											}
										/>
									)}
								</>
							)
						)}
					</li>
				))}
			</ul>
		</section>
	);
}
