"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ChevronRightIcon, HistoryIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { StoryPriority } from "../../../lib/stories/types";
import { PriorityBand } from "./PriorityBand";
import { PriorityHistoryDialog } from "./PriorityHistoryDialog";

/** How many hops the inline trail shows before deferring to the dialog. */
const TRAIL_LIMIT = 5;

type Props = {
	projectId: string;
	organizationId: string | null;
	storyId: string;
	identifier: string;
	/** Fallback for the "created as" anchor when the item has no history yet. */
	currentPriority: StoryPriority;
	enabled: boolean;
};

/**
 * A work item's priority history as a compact horizontal trail.
 *
 * The vertical list this replaced was the right shape for a dedicated history
 * page and the wrong one inside a row: an item re-banded weekly pushed the rest
 * of the list off-screen, and the thing people actually want from a row — "which
 * way has this been moving?" — took several lines to answer.
 *
 * So the row shows the TRAJECTORY (`Created P2 → P1 → P0`, newest last, capped
 * at {@link TRAIL_LIMIT} hops) and nothing else; who/when/why for every hop
 * lives one click away in {@link PriorityHistoryDialog}. The oldest node is the
 * band the item was created with, which is what makes the trail readable as a
 * story rather than a fragment.
 */
export function PriorityTrail({
	projectId,
	organizationId,
	storyId,
	identifier,
	currentPriority,
	enabled,
}: Props) {
	const t = useTranslations("projects.stories.priority");
	const [dialogOpen, setDialogOpen] = useState(false);

	// Only the first page — the trail never shows more than TRAIL_LIMIT hops, so
	// paging here would fetch rows nothing renders.
	const { data, isPending, isError } = useQuery({
		...orpc.projects.stories.priorityHistory.queryOptions({
			input: {
				projectId,
				organizationId,
				storyId,
				limit: TRAIL_LIMIT + 1,
			},
		}),
		enabled,
	});

	if (isPending) {
		return (
			<div
				aria-busy="true"
				className="h-6 w-48 rounded bg-muted motion-safe:animate-pulse"
			/>
		);
	}
	if (isError) {
		return (
			<p className="text-muted-foreground text-xs">{t("historyError")}</p>
		);
	}

	const { items, initialPriority, totalCount } = data;
	// Newest-first from the API; the trail reads left-to-right through time.
	const shown = [...items].slice(0, TRAIL_LIMIT).reverse();
	const hasMore = totalCount > shown.length;

	// The anchor: what it started as. With no history at all, that is simply the
	// band it still has.
	const startedAt = initialPriority ?? currentPriority;

	// The history icon leads the pipeline (no separate "Priority history" label —
	// the trail reads as one line). Its hover/focus hint says the trail is only
	// the tail of a longer record when it is, and points at "View all" for the
	// who/when/why on every hop. Carried on the aria-label too, so keyboard and
	// screen-reader users get it, not just a hovering mouse.
	const trailHint = hasMore
		? t("trailHintTruncated", { shown: shown.length, total: totalCount })
		: t("trailHintFull");

	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
			{/* `overflow-x-auto` so a long trail scrolls inside itself instead of
			    widening the row on a phone. */}
			<div className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto pb-0.5">
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => setDialogOpen(true)}
							aria-label={trailHint}
							className="inline-flex shrink-0 items-center rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<HistoryIcon aria-hidden className="size-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{trailHint}
					</TooltipContent>
				</Tooltip>

				{/* Each hop carries its attribution as REAL sr-only text (an
				    aria-label on a role-less span is skipped in browse mode) —
				    the hover Tooltip is a mouse-only enhancement, and the
				    complete record is one focusable "View all" click away in
				    the dialog. The band itself is announced by the chip's own
				    sr-only text, so the attribution never repeats it. */}
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex items-center gap-1">
							<span className="sr-only">
								{t("trailCreatedAs")}:{" "}
							</span>
							<PriorityBand
								priority={startedAt}
								responsive={false}
								className="opacity-70"
							/>
						</span>
					</TooltipTrigger>
					<TooltipContent>{t("trailCreatedAs")}</TooltipContent>
				</Tooltip>

				{hasMore && (
					<>
						<ChevronRightIcon
							aria-hidden
							className="size-3 shrink-0 text-muted-foreground/50"
						/>
						<span className="shrink-0 text-[11px] text-muted-foreground/70">
							{t("trailEllipsis", {
								count: totalCount - shown.length,
							})}
						</span>
					</>
				)}

				{shown.map((entry) => (
					<span
						key={entry.id}
						className="inline-flex shrink-0 items-center gap-1"
					>
						<ChevronRightIcon
							aria-hidden
							className="size-3 shrink-0 text-muted-foreground/50"
						/>
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex items-center gap-1">
									<PriorityBand
										priority={entry.toPriority}
										responsive={false}
									/>
									{entry.source === "AI" && (
										<SparklesIcon
											aria-hidden
											className="size-2.5 text-secondary"
										/>
									)}
									<span className="sr-only">
										{[
											entry.source === "AI"
												? t("sourceAi")
												: t("sourceManual"),
											entry.actorName ?? undefined,
											entry.reason ?? undefined,
										]
											.filter(Boolean)
											.join(", ")}
									</span>
								</span>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								{entry.source === "AI"
									? t("sourceAi")
									: t("sourceManual")}
								{entry.actorName ? ` · ${entry.actorName}` : ""}
								{entry.reason ? ` — ${entry.reason}` : ""}
							</TooltipContent>
						</Tooltip>
					</span>
				))}
			</div>

			<Button
				variant="ghost"
				size="sm"
				className="h-6 px-2 text-xs"
				onClick={() => setDialogOpen(true)}
			>
				{totalCount === 0
					? t("trailViewEmpty")
					: t("trailViewAll", { count: totalCount })}
			</Button>

			<PriorityHistoryDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				projectId={projectId}
				organizationId={organizationId}
				storyId={storyId}
				identifier={identifier}
				currentPriority={currentPriority}
			/>
		</div>
	);
}
