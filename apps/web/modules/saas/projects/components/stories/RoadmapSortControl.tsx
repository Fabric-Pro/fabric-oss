"use client";

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
import { cn } from "@ui/lib";
import {
	ArrowDownIcon,
	ArrowUpDownIcon,
	ArrowUpIcon,
	InfoIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type {
	RoadmapGroupBy,
	RoadmapViewMode,
} from "../../hooks/useRoadmapView";
import {
	type RoadmapSort,
	type RoadmapSortKey,
	SORT_KEY_DEFAULT_DIRECTIONS,
} from "../../lib/roadmap-sorts";

type TranslatedSortField =
	keyof typeof import("@repo/i18n/translations/en.json")["projects"]["stories"]["roadmapUi"]["sortFields"] &
		keyof typeof import("@repo/i18n/translations/de.json")["projects"]["stories"]["roadmapUi"]["sortFields"];
const SORT_LABEL_KEYS = {
	roadmapOrder: "sortFields.roadmapOrder",
	priority: "sortFields.priority",
	stage: "sortFields.stage",
	updated: "sortFields.updated",
	created: "sortFields.created",
	sync: "sortFields.sync",
	source: "sortFields.source",
	recentlyApproved: "sortFields.recentlyApproved",
} as const satisfies Record<
	RoadmapSortKey,
	`sortFields.${TranslatedSortField}`
>;
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
 * Roadmap sort control beside View, above the results.
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
	const t = useTranslations("projects.stories.roadmapUi");
	const dateSort =
		sort.key === "created" ||
		sort.key === "updated" ||
		sort.key === "recentlyApproved";
	const sortLabel =
		sort.key === "roadmapOrder"
			? t(SORT_LABEL_KEYS[sort.key])
			: t("sortLabel", {
					field: t(SORT_LABEL_KEYS[sort.key]),
					direction: t(
						dateSort
							? sort.direction === "desc"
								? "newestFirst"
								: "oldestFirst"
							: sort.direction === "desc"
								? "descending"
								: "ascending",
					),
				});
	return (
		<Popover>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							size="sm"
							variant="ghost"
							type="button"
							aria-label={t("sortAccessibleLabel", {
								sort: sortLabel,
							})}
							className="flex h-8 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
						>
							<ArrowUpDownIcon className="size-3.5 text-muted-foreground" />
							<span className="hidden max-w-32 truncate sm:inline">
								{sortLabel}
							</span>
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>
					{t("sortAccessibleLabel", { sort: sortLabel })}
				</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-60 p-2">
				<p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
					{t(mode === "plain" ? "sortAll" : "sortLanes")}
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
								<Button
									size="sm"
									variant="ghost"
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
										"flex flex-1 items-center justify-start gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors",
										active
											? "bg-primary/10 font-medium text-primary"
											: "text-foreground hover:bg-accent",
									)}
								>
									{t(SORT_LABEL_KEYS[key])}
									{(isRoadmapOrder || sortsGroups) && (
										<Tooltip>
											<TooltipTrigger asChild>
												<InfoIcon className="size-3 shrink-0 text-muted-foreground/60" />
											</TooltipTrigger>
											<TooltipContent>
												{isRoadmapOrder
													? t("roadmapOrderHelp")
													: t("groupSortHelp", {
															group: t(
																`sortFields.${groupBy === "priority" ? "priority" : "stage"}`,
															),
														})}
											</TooltipContent>
										</Tooltip>
									)}
								</Button>
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
													<Button
														size="icon-sm"
														variant="ghost"
														key={dir}
														type="button"
														aria-pressed={on}
														aria-label={t(
															dir === "asc"
																? "ascending"
																: "descending",
														)}
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
													</Button>
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
