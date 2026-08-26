"use client";

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
import { cn } from "@ui/lib";
import {
	ArrowDownIcon,
	ArrowUpDownIcon,
	ArrowUpIcon,
	InfoIcon,
} from "lucide-react";
import type {
	RoadmapGroupBy,
	RoadmapViewMode,
} from "../../hooks/useRoadmapView";
import {
	type RoadmapSort,
	type RoadmapSortKey,
	SORT_KEY_DEFAULT_DIRECTIONS,
	SORT_KEY_LABELS,
} from "../../lib/roadmap-sorts";

const SORT_FIELDS: RoadmapSortKey[] = [
	"roadmapOrder",
	"priority",
	"stage",
	"updated",
	"created",
	"sync",
	"source",
];

/**
 * Standalone Roadmap sort control for the toolbar (left of the history icon).
 * Changing the sort re-sorts immediately and is persisted per user + project at
 * once — like the show-hidden toggle, with no explicit save (see useRoadmapView).
 * Clicking the active field flips its direction; the manual roadmap order has none.
 */
export function RoadmapSortControl({
	sort,
	onSortChange,
	mode,
	groupBy,
}: {
	sort: RoadmapSort;
	onSortChange: (sort: RoadmapSort) => void;
	mode: RoadmapViewMode;
	groupBy: RoadmapGroupBy;
}) {
	return (
		<Popover>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label="Sort work items"
							className="flex h-8 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
						>
							<ArrowUpDownIcon className="size-3.5 text-muted-foreground" />
							<span className="hidden max-w-[8rem] truncate sm:inline">
								{SORT_KEY_LABELS[sort.key]}
							</span>
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>Sort</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-60 p-2">
				<p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
					Sort {mode === "plain" ? "(all items)" : "(within lanes)"}
				</p>
				<div className="space-y-0.5">
					{SORT_FIELDS.map((key) => {
						// When the sort dimension matches the grouping dimension
						// it orders the LANES themselves instead of within a lane.
						const sortsGroups =
							mode !== "plain" &&
							((groupBy === "priority" && key === "priority") ||
								(groupBy === "stage" && key === "stage"));
						const active = sort.key === key;
						const isRoadmapOrder = key === "roadmapOrder";
						return (
							<div key={key} className="flex items-center gap-1">
								<button
									type="button"
									onClick={() =>
										onSortChange(
											active && !isRoadmapOrder
												? {
														key,
														direction:
															sort.direction ===
															"asc"
																? "desc"
																: "asc",
													}
												: {
														key,
														direction:
															SORT_KEY_DEFAULT_DIRECTIONS[
																key
															],
													},
										)
									}
									className={cn(
										"flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors",
										active
											? "bg-primary/10 font-medium text-primary"
											: "text-foreground hover:bg-accent",
									)}
								>
									{SORT_KEY_LABELS[key]}
									{(isRoadmapOrder || sortsGroups) && (
										<Tooltip>
											<TooltipTrigger asChild>
												<InfoIcon className="size-3 shrink-0 text-muted-foreground/60" />
											</TooltipTrigger>
											<TooltipContent>
												{isRoadmapOrder
													? "Roadmap order — the project's saved order (priority first, then each item's saved position)."
													: `Orders the ${
															groupBy ===
															"priority"
																? "Priority"
																: "Stage"
														} lanes themselves — ascending keeps the default order, descending reverses it.`}
											</TooltipContent>
										</Tooltip>
									)}
								</button>
								{active && !isRoadmapOrder && (
									<div className="flex shrink-0 rounded border border-border/60 p-0.5">
										{(["asc", "desc"] as const).map(
											(dir) => {
												const Arrow =
													dir === "asc"
														? ArrowUpIcon
														: ArrowDownIcon;
												const on =
													sort.direction === dir;
												return (
													<button
														key={dir}
														type="button"
														aria-pressed={on}
														aria-label={
															dir === "asc"
																? "Ascending"
																: "Descending"
														}
														onClick={() =>
															onSortChange({
																key,
																direction: dir,
															})
														}
														className={cn(
															"flex size-5 items-center justify-center rounded transition-colors",
															on
																? "bg-primary text-primary-foreground"
																: "text-muted-foreground/50 hover:text-foreground",
														)}
													>
														<Arrow className="size-3" />
													</button>
												);
											},
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
