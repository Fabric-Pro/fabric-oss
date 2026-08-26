"use client";

/**
 * TeamsProposalsCard — renders Teams-channel change proposals for a Daily Brief.
 */

import type { PartialFailure, TeamsProposalItem } from "@repo/database";
import { cn } from "@ui/lib";
import { MessagesSquareIcon } from "lucide-react";
import { formatRelativeOccurredAt } from "./format";
import { SourceCard } from "./SourceCard";

const STATUS_CHIP: Record<TeamsProposalItem["status"], string> = {
	PENDING:
		"bg-highlight/10 text-highlight-foreground dark:text-highlight border-highlight/40",
	APPROVED: "bg-secondary/10 text-secondary border-secondary/30",
	APPLIED: "bg-secondary/10 text-secondary border-secondary/30",
	REJECTED: "bg-muted text-muted-foreground border-border",
	FAILED: "bg-destructive/10 text-destructive border-destructive/30",
};

export interface TeamsProposalsCardProps {
	items: TeamsProposalItem[];
	partialFailure?: PartialFailure;
	emptyMessage?: string;
}

export function TeamsProposalsCard({
	items,
	partialFailure,
	emptyMessage = "No Teams-channel proposals in this window.",
}: TeamsProposalsCardProps) {
	return (
		<SourceCard
			title="Teams-channel proposals"
			sourceLabel="Source — Teams channels"
			count={items.length}
			emptyMessage={emptyMessage}
			icon={<MessagesSquareIcon className="size-4" />}
			partialFailure={partialFailure}
		>
			<ul className="divide-y divide-border">
				{items.map((item) => (
					<li
						key={item.proposalCuid}
						className="py-3 first:pt-0 last:pb-0"
					>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<span
									className={cn(
										"inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
										STATUS_CHIP[item.status],
									)}
								>
									{item.status}
								</span>
								<span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
									{item.changeCount} change
									{item.changeCount === 1 ? "" : "s"}
								</span>
								{item.channelName ? (
									<span className="font-mono text-[10px] text-muted-foreground">
										#{item.channelName}
									</span>
								) : null}
							</div>
							<p className="mt-1.5 font-sans text-sm font-medium text-foreground">
								{item.title}
							</p>
							{item.summary ? (
								<p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
									{item.summary}
								</p>
							) : null}
							<p className="mt-0.5 text-xs text-muted-foreground">
								{formatRelativeOccurredAt(item.occurredAt)}
							</p>
						</div>
					</li>
				))}
			</ul>
		</SourceCard>
	);
}
