"use client";

/**
 * RoadmapContextStrip
 *
 * A single quiet, borderless line of roadmap counts (work items · lanes · synced
 * · unsynced) that sits under the tab bar — it replaces the tall two-column hero
 * WITHOUT adding another bordered band, so the work-item table stays the focus.
 * An "About" popover preserves the longer eyebrow / title / description /
 * quick-focus copy the old hero used to show.
 *
 * Conflict/failure ("needs review") triage lives in the toolbar below via
 * ReviewCenterInbox, so it is intentionally NOT duplicated here.
 *
 * Tokens only (--foreground / --muted-foreground) so it tracks the live theme in
 * light and dark.
 */

import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { InfoIcon } from "lucide-react";

export type RoadmapStats = {
	/** Visible work items (matches the old hero badge — excludes hidden/closed). */
	workItems: number;
	/** Priority lanes that currently hold at least one item. */
	lanes: number;
	/** Items linked to the PM tool. */
	synced: number;
	/** Items not yet linked to the PM tool. */
	unsynced: number;
};

function Metric({
	value,
	label,
	tip,
}: {
	value: number;
	label: string;
	tip: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/* Focusable so the explanation is reachable by keyboard, not just hover. */}
				<button
					type="button"
					className="inline cursor-help whitespace-nowrap rounded-sm border-0 bg-transparent p-0 text-inherit appearance-none outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
				>
					<span className="font-medium text-foreground/90 tabular-nums">
						{value}
					</span>{" "}
					{label}
				</button>
			</TooltipTrigger>
			<TooltipContent>{tip}</TooltipContent>
		</Tooltip>
	);
}

function Dot() {
	return (
		<span aria-hidden="true" className="text-muted-foreground/40">
			·
		</span>
	);
}

type Props = {
	stats: RoadmapStats;
	/** Active lane grouping — drives the "lanes" tooltip wording. */
	groupBy: "priority" | "stage";
};

export function RoadmapContextStrip({ stats, groupBy }: Props) {
	const lanesTip =
		groupBy === "stage"
			? "Delivery-stage lanes that currently hold at least one work item."
			: "Priority lanes (Critical / High / Medium / Low) that currently hold at least one work item.";
	return (
		<div className="flex items-center gap-x-3 px-0.5 text-muted-foreground text-sm">
			{/* Left zone wraps freely (label + stats); the About action stays pinned
			    on the right at every width. */}
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5">
				{/* Editorial identity. Uses .app-editorial-label so the bar is the
				    project's --primary token (not the hardcoded marketing red). */}
				<span className="app-editorial-label shrink-0">
					Project Roadmap
				</span>
				{/* Stats wrap as one group so the dots stay glued to their metrics. */}
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
					<Metric
						value={stats.workItems}
						label={`work item${stats.workItems === 1 ? "" : "s"}`}
						tip="Work items currently on the roadmap. Synced + unsynced always adds up to this."
					/>
					<Dot />
					<Metric
						value={stats.lanes}
						label={`lane${stats.lanes === 1 ? "" : "s"}`}
						tip={lanesTip}
					/>
					<Dot />
					<Metric
						value={stats.synced}
						label="synced"
						tip="Work items linked to a ticket in your PM tool."
					/>
					<Dot />
					<Metric
						value={stats.unsynced}
						label="unsynced"
						tip="Work items not yet linked to your PM tool."
					/>
				</div>
			</div>

			<Popover>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
						aria-label="About this roadmap"
					>
						<InfoIcon className="size-3.5" />
						About
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-[340px] space-y-3">
					<p className="app-editorial-label">Project Roadmap</p>
					<h3 className="font-medium text-[0.95rem] text-foreground leading-snug">
						Work item flow, delivery stages, and execution pressure
					</h3>
					<p className="text-[0.8rem] text-muted-foreground leading-relaxed">
						Track how planned work moves through the roadmap, where
						the highest-priority work sits, and how much of the
						backlog is already connected to the delivery system.
					</p>
					<div className="rounded-lg border border-border/70 bg-muted/40 p-3">
						<p className="font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.18em]">
							Quick Focus
						</p>
						<p className="mt-1.5 text-[0.8rem] text-foreground/85 leading-relaxed">
							Shape the work item list here, then sync the
							polished roadmap into your PM system when the
							priority order looks right.
						</p>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}
