"use client";

/**
 * StoryChangesCard — renders story (feature) change items for a Daily Brief.
 *
 * Items are grouped by storyCuid so multiple change events on the same
 * feature collapse into a single header with a timeline beneath it. Within
 * each group, events are ordered newest-first.
 */

import type { PartialFailure, StoryChangeItem } from "@repo/database";
import { BookmarkIcon } from "lucide-react";
import { useMemo } from "react";
import { formatRelativeOccurredAt, occurredAtMs } from "./format";
import { SourceCard } from "./SourceCard";

const KIND_LABEL: Record<StoryChangeItem["kind"], string> = {
	status_changed: "Status changed",
	created: "Created",
	assignee_changed: "Assignee changed",
	content_changed: "Content updated",
	priority_changed: "Priority changed",
};

interface FeatureGroup {
	storyCuid: string;
	storyIdentifier: string;
	title: string;
	events: StoryChangeItem[];
	latestOccurredAt: number;
}

function groupByFeature(items: StoryChangeItem[]): FeatureGroup[] {
	const map = new Map<string, FeatureGroup>();
	for (const item of items) {
		let group = map.get(item.storyCuid);
		if (!group) {
			group = {
				storyCuid: item.storyCuid,
				storyIdentifier: item.storyIdentifier,
				title: item.title,
				events: [],
				latestOccurredAt: 0,
			};
			map.set(item.storyCuid, group);
		}
		group.events.push(item);
		const t = occurredAtMs(item);
		if (t > group.latestOccurredAt) {
			group.latestOccurredAt = t;
		}
	}

	for (const group of map.values()) {
		group.events.sort((a, b) => occurredAtMs(b) - occurredAtMs(a));
	}

	return [...map.values()].sort(
		(a, b) => b.latestOccurredAt - a.latestOccurredAt,
	);
}

export interface StoryChangesCardProps {
	items: StoryChangeItem[];
	partialFailure?: PartialFailure;
	emptyMessage?: string;
}

export function StoryChangesCard({
	items,
	partialFailure,
	emptyMessage = "No feature changes in this window.",
}: StoryChangesCardProps) {
	const groups = useMemo(() => groupByFeature(items), [items]);

	return (
		<SourceCard
			title="Feature changes"
			sourceLabel="Source — Features"
			count={items.length}
			emptyMessage={emptyMessage}
			icon={<BookmarkIcon className="size-4" />}
			partialFailure={partialFailure}
		>
			<ul className="divide-y divide-border">
				{groups.map((group) => (
					<li
						key={group.storyCuid}
						className="py-3 first:pt-0 last:pb-0"
					>
						<header className="flex items-center gap-2">
							<span className="inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-muted-foreground">
								{group.storyIdentifier}
							</span>
							<p className="min-w-0 flex-1 truncate font-sans text-sm font-medium text-foreground">
								{group.title}
							</p>
							<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
								{group.events.length}{" "}
								{group.events.length === 1
									? "change"
									: "changes"}
							</span>
						</header>

						<ol className="mt-2 space-y-1.5 border-l border-border/60 pl-3">
							{group.events.map((event, index) => (
								<li
									key={`${group.storyCuid}-${event.kind}-${index}`}
									className="text-xs"
								>
									<div className="flex items-center gap-2">
										<span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
											{KIND_LABEL[event.kind]}
										</span>
										<span className="text-[11px] text-muted-foreground">
											{formatRelativeOccurredAt(
												event.occurredAt,
											)}
										</span>
									</div>
									{event.fromValue || event.toValue ? (
										<p className="mt-0.5 text-xs text-muted-foreground">
											{event.fromValue ?? "—"}
											<span className="mx-1.5">→</span>
											{event.toValue ?? "—"}
										</p>
									) : null}
								</li>
							))}
						</ol>
					</li>
				))}
			</ul>
		</SourceCard>
	);
}
