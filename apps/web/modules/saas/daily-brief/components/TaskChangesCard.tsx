"use client";

/**
 * TaskChangesCard — renders task change items for a Daily Brief.
 */

import type { PartialFailure, TaskChangeItem } from "@repo/database";
import { CheckSquareIcon } from "lucide-react";
import { formatRelativeOccurredAt } from "./format";
import { SourceCard } from "./SourceCard";

const KIND_LABEL: Record<TaskChangeItem["kind"], string> = {
	status_changed: "Status changed",
	created: "Created",
	due_date_changed: "Due date changed",
	completed: "Completed",
};

export interface TaskChangesCardProps {
	items: TaskChangeItem[];
	partialFailure?: PartialFailure;
	emptyMessage?: string;
}

export function TaskChangesCard({
	items,
	partialFailure,
	emptyMessage = "No task changes in this window.",
}: TaskChangesCardProps) {
	return (
		<SourceCard
			title="Task changes"
			sourceLabel="Source — Tasks"
			count={items.length}
			emptyMessage={emptyMessage}
			icon={<CheckSquareIcon className="size-4" />}
			partialFailure={partialFailure}
		>
			<ul className="divide-y divide-border">
				{items.map((item, index) => (
					<li
						key={`${item.taskCuid}-${item.kind}-${index}`}
						className="py-3 first:pt-0 last:pb-0"
					>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<span className="inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-muted-foreground">
									{item.taskIdentifier}
								</span>
								{item.storyIdentifier ? (
									<span className="font-mono text-[10px] text-muted-foreground">
										in {item.storyIdentifier}
									</span>
								) : null}
								<span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
									{KIND_LABEL[item.kind]}
								</span>
							</div>
							<p className="mt-1.5 font-sans text-sm font-medium text-foreground">
								{item.title}
							</p>
							{item.fromValue || item.toValue ? (
								<p className="mt-0.5 text-xs text-muted-foreground">
									{item.fromValue ?? "—"}
									<span className="mx-1.5">→</span>
									{item.toValue ?? "—"}
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
