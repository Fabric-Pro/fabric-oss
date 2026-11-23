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
	bodyEditsAgainst,
	type UpdateBodies,
} from "@repo/utils/proposal-update-edits";
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
	/**
	 * The ticket's bodies as they are now, for an update whose body has no
	 * `from`: its change is counted against them, not against an empty body.
	 */
	current?: UpdateBodies;
	/** Set once the item is applied: the ticket it updated, when known. */
	applied?: { projectId?: string; storyId: string | null };
	/**
	 * A re-routed item whose merge adds none of its text to the target: the
	 * target's identifier, so the summary says the item's content is not
	 * written there.
	 */
	keptBodyOn?: string;
	panel?: BacklogProposalPanel;
	className?: string;
};

export function ProposalUpdateSummary({
	change,
	showReasoning = true,
	current,
	applied,
	keptBodyOn,
	panel,
	className,
}: Props) {
	const headingId = useId();
	const { title, description, acceptanceCriteria, priority, size } = change;
	const lines = useMemo(() => {
		const bodies = current
			? bodyEditsAgainst({ description, acceptanceCriteria }, current)
			: { description, acceptanceCriteria };
		return summarizeProposalUpdate({ title, ...bodies, priority, size });
	}, [title, description, acceptanceCriteria, priority, size, current]);
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
			{keptBodyOn && (
				<p className="text-xs text-foreground break-words">
					{`None of this item's text is merged into ${keptBodyOn}: its description and acceptance criteria stay as they are.`}
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
