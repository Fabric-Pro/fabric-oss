"use client";

/**
 * What a proposed update changes, at the top of every update item in the
 * review list and its detail dialog: one line per field it moves, read from
 * the item's own before/after values, and the item's reasoning as "Why".
 *
 * Once the item is applied, the block is titled "As proposed": apply can
 * merge the change into a ticket that moved on, so what was written is read
 * from the ticket's Decision Log, linked here.
 */

import {
	describeLineCounts,
	summarizeProposalUpdate,
} from "@repo/utils/proposal-update-summary";
import { cn } from "@ui/lib";
import { stripMarkdown } from "@ui/lib/strip-markdown";
import { useId, useMemo } from "react";
import type { BacklogProposalPanel } from "../../../../analytics/events/backlog-open-existing";
import type { ChangeItem } from "./BacklogChangeProposal";
import { StoryNewTabLink } from "./StoryNewTabLink";

type Props = {
	change: Pick<
		ChangeItem,
		| "title"
		| "description"
		| "acceptanceCriteria"
		| "priority"
		| "size"
		| "reasoning"
	>;
	/** Hide "Why" where the reasoning is already shown in full. */
	showReasoning?: boolean;
	/** Set once the item is applied: the ticket it updated, when known. */
	applied?: { projectId?: string; storyId: string | null };
	panel?: BacklogProposalPanel;
	className?: string;
};

export function ProposalUpdateSummary({
	change,
	showReasoning = true,
	applied,
	panel,
	className,
}: Props) {
	const headingId = useId();
	const { title, description, acceptanceCriteria, priority, size } = change;
	const lines = useMemo(
		() =>
			summarizeProposalUpdate({
				title,
				description,
				acceptanceCriteria,
				priority,
				size,
			}),
		[title, description, acceptanceCriteria, priority, size],
	);
	const reasoning = showReasoning ? stripMarkdown(change.reasoning) : "";
	return (
		<div
			className={cn(
				"space-y-1.5 rounded-md border bg-muted/30 p-3",
				className,
			)}
			data-testid="proposal-update-summary"
		>
			<p
				id={headingId}
				className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
			>
				{applied ? "As proposed" : "Proposed changes"}
			</p>
			{lines.length > 0 ? (
				<ul aria-labelledby={headingId} className="space-y-1">
					{lines.map((line) => {
						const counts = describeLineCounts(
							line.field,
							line.added,
							line.removed,
						);
						return (
							<li
								key={line.field}
								className="text-xs break-words"
							>
								<span className="font-medium text-foreground">
									{line.label}
								</span>
								{counts && (
									<span className="text-muted-foreground">
										{` · ${counts}`}
									</span>
								)}
								<span className="text-muted-foreground">
									{` — ${line.explanation}`}
								</span>
							</li>
						);
					})}
				</ul>
			) : (
				<p className="text-xs text-muted-foreground">
					No field changes: the ticket stays as it is.
				</p>
			)}
			{reasoning && (
				<p className="text-xs text-muted-foreground break-words">
					<span className="font-medium text-foreground">Why: </span>
					{reasoning}
				</p>
			)}
			{applied && (
				<p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
					What was applied is recorded in the ticket's Decision Log.
					{applied.storyId && applied.projectId && (
						<StoryNewTabLink
							projectId={applied.projectId}
							storyId={applied.storyId}
							view="decisionLog"
							panel={panel}
							label={`Open the Decision Log of ${change.title.to} in a new tab`}
						>
							Open Decision Log
						</StoryNewTabLink>
					)}
				</p>
			)}
		</div>
	);
}
