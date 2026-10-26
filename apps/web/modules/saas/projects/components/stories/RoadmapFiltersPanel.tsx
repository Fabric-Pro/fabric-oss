"use client";

/**
 * The roadmap filters have two tiers: primary Type / Priority / Stage controls
 * share the wrapping search toolbar; secondary facets occupy the More filters
 * row, with compact date ranges and recency windows in the same wrapping row.
 *
 * FacetMultiSelect uses a fixed-width trigger and truncates its summary so a
 * selection does not shift neighbouring controls. Its cmdk checkbox list keeps
 * multi-selection inside the popover instead of growing the toolbar. Longer
 * option lists get search; shorter lists remain directly scannable.
 *
 * Active styling uses the primary theme token rather than a fixed colour.
 * Filter values remain controlled by the caller; More filters owns visibility
 * of the entire secondary tier, including date controls.
 */

import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@ui/components/command";
import {
	DateRangePicker,
	type DateRangePickerLabels,
} from "@ui/components/date-range-picker";
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
	BugIcon,
	CheckIcon,
	ChevronDownIcon,
	CopyIcon,
	EyeOffIcon,
	FileTextIcon,
	HelpCircleIcon,
	ListChecksIcon,
	OctagonXIcon,
	PuzzleIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import {
	FILTERABLE_KINDS,
	FILTERABLE_PRIORITIES,
	FILTERABLE_SIZES,
	FILTERABLE_SOURCES,
	FILTERABLE_STAGES,
	FILTERABLE_SYNC_STATUSES,
	RECENCY_WINDOW_OPTIONS,
	type RecencyWindowDays,
	type RoadmapFilters,
	STORY_KIND_LABELS,
	STORY_SIZE_LABELS,
	STORY_SOURCE_LABELS,
	type StorySize,
	type StorySource,
	type SyncFilter,
} from "../../lib/roadmap-filters";
import type { StoryKind, StoryPriority } from "../../lib/stories/types";
import {
	getPriorityColor,
	getPriorityLabel,
	MATURATION_STATUS_META,
	type MaturationStatus,
} from "../../lib/stories/types";
import { sourceIcon } from "./SourceChip";

const SYNC_LABELS: Record<SyncFilter, string> = {
	synced: "Synced",
	unsynced: "Unsynced",
};

function dateToIso(d: Date | undefined): string | null {
	if (!d) {
		return null;
	}
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

type ToggleOption<T extends string> = {
	value: T;
	label: string;
	/** A leading dot / icon / badge mirroring how the value reads on the cards. */
	leading?: ReactNode;
};

// Facets and recency controls share their complete button presentation.
function FacetTrigger({
	label,
	summary,
	active = false,
	className,
	...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
	label: string;
	summary: string;
	active?: boolean;
}) {
	const t = useTranslations("projects.stories.roadmapUi");
	const text = t("facetLabel", { label, value: summary });
	const valueOffset = text.lastIndexOf(summary);
	return (
		<Button
			{...props}
			variant="outline"
			type="button"
			className={cn(
				"inline-flex h-9 w-40 shrink-0 items-center justify-between gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
				active
					? "border-primary/50 bg-primary/10 text-primary"
					: "border-border bg-transparent text-muted-foreground hover:border-foreground/40 hover:text-foreground",
				className,
			)}
		>
			<span className="flex min-w-0 flex-1 items-center">
				<span className="truncate whitespace-pre">
					{text.slice(0, valueOffset)}
				</span>
				<span className="max-w-full shrink-0 truncate">{summary}</span>
				{text.slice(valueOffset + summary.length)}
			</span>
			<ChevronDownIcon
				aria-hidden
				className="size-3.5 shrink-0 opacity-70"
			/>
		</Button>
	);
}

// Fixed-width triggers keep selected values from shifting neighbouring controls.
function FacetMultiSelect<T extends string>({
	label,
	options,
	selected,
	onChange,
	extraOption,
}: {
	label: string;
	options: ToggleOption<T>[];
	selected: T[];
	onChange: (next: T[]) => void;
	// An optional standalone toggle rendered below a divider. Used by the Stage
	// facet to host "Hidden" — the CLOSED stage rather than one of the maturity
	// stages — so it rides its own boolean instead of the `selected` array.
	extraOption?: {
		label: string;
		leading?: ReactNode;
		checked: boolean;
		onToggle: () => void;
	};
}) {
	const t = useTranslations("projects.stories.roadmapUi");
	const [open, setOpen] = useState(false);
	const set = new Set(selected);
	const toggle = (value: T) =>
		onChange(
			set.has(value)
				? selected.filter((v) => v !== value)
				: [...selected, value],
		);
	const count = selected.length;
	const extraActive = extraOption?.checked ?? false;
	// The trigger's active styling + summary count both the multiselect values
	// and the standalone extra toggle.
	const activeCount = count + (extraActive ? 1 : 0);
	const summary =
		activeCount === 0
			? t("any")
			: activeCount === 1
				? count === 1
					? (options.find((o) => o.value === selected[0])?.label ??
						"1")
					: (extraOption?.label ?? "1")
				: t("selected", { count: activeCount });
	// A search box only earns its place on longer lists (Stage = 5, Source = 11);
	// on the short facets (Type / Priority / Sync) it's clutter, and dropping it
	// also keeps cmdk from filtering.
	const searchable = options.length > 4;
	const trigger = (
		<PopoverTrigger asChild>
			<FacetTrigger
				label={label}
				summary={summary}
				active={activeCount > 0}
			/>
		</PopoverTrigger>
	);
	return (
		<div className="flex items-baseline gap-2.5">
			<Popover open={open} onOpenChange={setOpen}>
				{/* Long single-value summaries truncate; surface the full text on
					hover/focus. Multi/none summaries are always short, and the open
					popover already shows the value, so the tooltip is `disabled` in
					those cases rather than swapped out — keeping the tooltip mounted keeps the tree shape
					stable, so toggling the first/last facet while the popover is open
					can't remount (and re-focus) the trigger button. */}
				<Tooltip disabled={open || activeCount !== 1}>
					<TooltipTrigger asChild>{trigger}</TooltipTrigger>
					<TooltipContent>{summary}</TooltipContent>
				</Tooltip>
				<PopoverContent align="start" className="w-56 p-0">
					<Command shouldFilter={searchable}>
						{searchable && (
							<CommandInput
								placeholder={`Search ${label.toLowerCase()}…`}
								className="h-9"
							/>
						)}
						<CommandList>
							{searchable && (
								<CommandEmpty>None found.</CommandEmpty>
							)}
							<CommandGroup>
								{options.map((o) => {
									const isSel = set.has(o.value);
									return (
										<CommandItem
											key={o.value}
											value={o.label}
											onSelect={() => toggle(o.value)}
											className="gap-2"
										>
											<span
												className={cn(
													"flex size-4 items-center justify-center rounded-[4px] border transition-colors",
													isSel
														? "border-primary bg-primary text-primary-foreground"
														: "border-muted-foreground/40",
												)}
											>
												{isSel && (
													<CheckIcon
														aria-hidden
														className="size-3"
													/>
												)}
											</span>
											{o.leading && (
												<span className="flex size-5 shrink-0 items-center justify-center">
													{o.leading}
												</span>
											)}
											<span className="flex-1">
												{o.label}
											</span>
										</CommandItem>
									);
								})}
							</CommandGroup>
							{extraOption && (
								<>
									<CommandSeparator />
									<CommandGroup>
										<CommandItem
											value={extraOption.label}
											onSelect={extraOption.onToggle}
											className="gap-2"
										>
											<span
												className={cn(
													"flex size-4 items-center justify-center rounded-[4px] border transition-colors",
													extraOption.checked
														? "border-primary bg-primary text-primary-foreground"
														: "border-muted-foreground/40",
												)}
											>
												{extraOption.checked && (
													<CheckIcon
														aria-hidden
														className="size-3"
													/>
												)}
											</span>
											{extraOption.leading && (
												<span className="flex size-5 shrink-0 items-center justify-center">
													{extraOption.leading}
												</span>
											)}
											<span className="flex-1">
												{extraOption.label}
											</span>
										</CommandItem>
									</CommandGroup>
								</>
							)}
							{activeCount > 0 && (
								<>
									<CommandSeparator />
									<CommandGroup>
										<CommandItem
											onSelect={() => {
												onChange([]);
												if (extraOption?.checked) {
													extraOption.onToggle();
												}
											}}
											className="justify-center text-muted-foreground text-xs"
										>
											Clear {label.toLowerCase()}
										</CommandItem>
									</CommandGroup>
								</>
							)}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</div>
	);
}

function RecencySelect({
	label,
	value,
	onChange,
}: {
	label: string;
	value: RecencyWindowDays | null;
	onChange: (next: RecencyWindowDays | null) => void;
}) {
	const t = useTranslations("projects.stories.roadmapUi");
	const [open, setOpen] = useState(false);
	const selected = value === null ? "none" : String(value);
	const options = [
		{ value: "none", label: t("anyTime") },
		...RECENCY_WINDOW_OPTIONS.map((days) => ({
			value: String(days),
			label: t("lastDays", { days }),
		})),
	];
	const summary =
		options.find((option) => option.value === selected)?.label ??
		t("anyTime");
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<FacetTrigger
					label={label}
					summary={summary}
					active={value !== null}
				/>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-56 p-0">
				<Command
					shouldFilter={false}
					defaultValue={selected}
					tabIndex={0}
				>
					<CommandList>
						<CommandGroup>
							{options.map((option) => (
								<CommandItem
									key={option.value}
									value={option.value}
									className="justify-between"
									onSelect={() => {
										onChange(
											option.value === "none"
												? null
												: (Number(
														option.value,
													) as RecencyWindowDays),
										);
										setOpen(false);
									}}
								>
									{option.label}
									{option.value === selected && (
										<CheckIcon
											aria-hidden
											className="size-3.5"
										/>
									)}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

const KIND_OPTIONS: ToggleOption<StoryKind>[] = FILTERABLE_KINDS.map(
	(value) => ({
		value,
		label: STORY_KIND_LABELS[value],
		leading:
			value === "BUG" ? (
				<BugIcon className="size-3.5 text-destructive" />
			) : (
				<PuzzleIcon className="size-3.5 text-muted-foreground" />
			),
	}),
);
const PRIORITY_OPTIONS: ToggleOption<StoryPriority>[] =
	FILTERABLE_PRIORITIES.map((value) => ({
		value,
		label: getPriorityLabel(value),
		leading: (
			<span
				className="size-2 rounded-full"
				style={{ backgroundColor: getPriorityColor(value) }}
			/>
		),
	}));
// Stage pills follow Maturation V2 status order (To Do → Discovery → Requirements Complete).
// Defensive sort keeps options ordered by MATURATION_STATUS_META.order if FILTERABLE_STAGES declaration order drifts.
const STAGE_OPTIONS: ToggleOption<MaturationStatus>[] = [...FILTERABLE_STAGES]
	.sort(
		(a, b) =>
			MATURATION_STATUS_META[a].order - MATURATION_STATUS_META[b].order,
	)
	.map((value) => {
		const meta = MATURATION_STATUS_META[value];
		return {
			value,
			label: meta.label,
			leading: (
				<span
					className="size-2 rounded-full"
					style={{ backgroundColor: meta.color }}
				/>
			),
		};
	});
const SYNC_OPTIONS: ToggleOption<SyncFilter>[] = FILTERABLE_SYNC_STATUSES.map(
	(value) => ({ value, label: SYNC_LABELS[value] }),
);
const SOURCE_OPTIONS: ToggleOption<StorySource>[] = FILTERABLE_SOURCES.map(
	(value) => {
		const Icon = sourceIcon(value);
		return {
			value,
			label: STORY_SOURCE_LABELS[value],
			leading: <Icon className="size-3.5 text-muted-foreground/70" />,
		};
	},
);
const SIZE_OPTIONS: ToggleOption<StorySize>[] = FILTERABLE_SIZES.map(
	(value) => ({
		value,
		label: STORY_SIZE_LABELS[value],
		leading: (
			<span className="text-[9px] font-semibold tabular-nums text-muted-foreground">
				{value}
			</span>
		),
	}),
);

// The four boolean flag filters, surfaced as ONE multiselect dropdown (the same
// FacetMultiSelect control as every other facet) instead of a stack of toggles.
// Each option maps to its matching boolean on `RoadmapFilters`.
type FlagKey =
	| "missingDesc"
	| "missingAc"
	| "duplicatesOnly"
	| "needsMoreInfo"
	| "blocked";
// A flag reads as the SAME amber chip the table cards use (border-highlight /
// bg-highlight / text-highlight-foreground), with its icon — so the filter and
// the cards present flags identically.
const flagLeading = (Icon: typeof FileTextIcon) => (
	<span className="flex size-5 items-center justify-center rounded-full border border-highlight/40 bg-highlight/10 text-highlight-ink dark:text-muted-foreground">
		{/* Inline size: cmdk's CommandItem forces `[&_svg]:size-4` (16px), which
		    would override a Tailwind size class and crowd the 20px chip. Pin it to
		    14px so the icon sits with breathing room, matching the table chips. */}
		<Icon
			className="shrink-0"
			style={{ width: "0.875rem", height: "0.875rem" }}
		/>
	</span>
);
const FLAG_OPTIONS: ToggleOption<FlagKey>[] = [
	{
		value: "missingDesc",
		label: "Missing description",
		leading: flagLeading(FileTextIcon),
	},
	{
		value: "missingAc",
		label: "Missing acceptance criteria",
		leading: flagLeading(ListChecksIcon),
	},
	{
		value: "duplicatesOnly",
		label: "Possible duplicates",
		leading: flagLeading(CopyIcon),
	},
	{
		value: "needsMoreInfo",
		label: "Needs more info",
		leading: flagLeading(HelpCircleIcon),
	},
	{
		value: "blocked",
		label: "Blocked",
		leading: flagLeading(OctagonXIcon),
	},
];

export type RoadmapFiltersPanelProps = {
	filters: RoadmapFilters;
	onChange: (next: Partial<RoadmapFilters>) => void;
	tier: "primary" | "more";
	/** Distinct project tags for the tag facet (empty until loaded / flag off). */
	tagOptions?: string[];
};

export function RoadmapFiltersPanel({
	filters,
	onChange,
	tier,
	tagOptions = [],
}: RoadmapFiltersPanelProps) {
	const tRange = useTranslations("common.dateRangePicker");
	const rangeLabels: DateRangePickerLabels = {
		any: tRange("any"),
		clear: tRange("clear"),
		from: (date) => tRange("from", { date }),
		until: (date) => tRange("until", { date }),
		lastDays: (days) => tRange("lastDays", { days }),
		thisMonth: tRange("thisMonth"),
	};

	const t = useTranslations("projects.stories.roadmapUi");
	const selectedFlags = FLAG_OPTIONS.filter((o) => filters[o.value]).map(
		(o) => o.value,
	);
	const handleFlagsChange = (next: FlagKey[]) => {
		const set = new Set(next);
		onChange({
			missingDesc: set.has("missingDesc"),
			missingAc: set.has("missingAc"),
			duplicatesOnly: set.has("duplicatesOnly"),
			needsMoreInfo: set.has("needsMoreInfo"),
			blocked: set.has("blocked"),
		});
	};

	if (tier === "primary") {
		return (
			<div className="flex flex-wrap items-center gap-2">
				<FacetMultiSelect
					label={t("type")}
					options={KIND_OPTIONS}
					selected={filters.kind}
					onChange={(kind) => onChange({ kind })}
				/>
				<FacetMultiSelect
					label={t("priority")}
					options={PRIORITY_OPTIONS}
					selected={filters.priority}
					onChange={(priority) => onChange({ priority })}
				/>
				<FacetMultiSelect
					label={t("stage")}
					options={STAGE_OPTIONS}
					selected={filters.stage}
					onChange={(stage) =>
						onChange({
							stage,
							// Picking a maturity stage exits "Hidden" mode — hidden
							// items are CLOSED, which isn't a maturity stage, so the
							// two can't both be active without resolving to nothing.
							...(stage.length > 0 ? { hiddenOnly: false } : {}),
						})
					}
					extraOption={{
						label: "Hidden",
						leading: (
							<EyeOffIcon
								className="shrink-0 text-muted-foreground"
								style={{
									width: "0.875rem",
									height: "0.875rem",
								}}
							/>
						),
						checked: filters.hiddenOnly,
						onToggle: () =>
							onChange({
								hiddenOnly: !filters.hiddenOnly,
								// Entering "Hidden" clears the maturity-stage picks so
								// the two facets never contradict each other.
								...(filters.hiddenOnly ? {} : { stage: [] }),
							}),
					}}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-2">
			{/* Uniform facet dropdowns: Sync / Source / Flags on one row,
			    consistent with the Type / Priority / Stage primary row. */}
			<FacetMultiSelect
				label={t("sync")}
				options={SYNC_OPTIONS}
				selected={filters.sync}
				onChange={(sync) => onChange({ sync })}
			/>
			<FacetMultiSelect
				label={t("source")}
				options={SOURCE_OPTIONS}
				selected={filters.source}
				onChange={(source) => onChange({ source })}
			/>
			<FacetMultiSelect
				label={t("size")}
				options={SIZE_OPTIONS}
				selected={filters.size}
				onChange={(size) => onChange({ size })}
			/>
			<FacetMultiSelect
				label={t("flags")}
				options={FLAG_OPTIONS}
				selected={selectedFlags}
				onChange={handleFlagsChange}
			/>
			{(tagOptions.length > 0 || filters.tags.length > 0) && (
				<FacetMultiSelect
					label={t("tags")}
					options={[
						// union(options, currently-selected) so a URL-supplied
						// value not in tagOptions still appears as checked.
						...new Set([...tagOptions, ...filters.tags]),
					].map((value) => ({ value, label: value }))}
					selected={filters.tags}
					onChange={(tags) =>
						onChange({
							tags,
							...(tags.length < 2 ? { tagsLogic: "OR" } : {}),
						})
					}
					extraOption={
						filters.tags.length >= 2
							? {
									label: t("matchAll"),
									checked: filters.tagsLogic === "AND",
									onToggle: () =>
										onChange({
											tagsLogic:
												filters.tagsLogic === "AND"
													? "OR"
													: "AND",
										}),
								}
							: undefined
					}
				/>
			)}
			<RecencySelect
				label={t("recentlyApproved")}
				value={filters.recentlyApproved}
				onChange={(recentlyApproved) => onChange({ recentlyApproved })}
			/>
			<RecencySelect
				label={t("recentlyAdded")}
				value={filters.recentlyAdded}
				onChange={(recentlyAdded) => onChange({ recentlyAdded })}
			/>
			<RecencySelect
				label={t("recentlyEdited")}
				value={filters.recentlyChanged}
				onChange={(recentlyChanged) => onChange({ recentlyChanged })}
			/>
			<DateRangePicker
				label={t("created")}
				labels={rangeLabels}
				value={{
					from: filters.createdFrom ?? undefined,
					to: filters.createdTo ?? undefined,
				}}
				onChange={(next) =>
					onChange({
						createdFrom: dateToIso(next.from),
						createdTo: dateToIso(next.to),
					})
				}
			/>
			<DateRangePicker
				label={t("lastActivity")}
				labels={rangeLabels}
				value={{
					from: filters.updatedFrom ?? undefined,
					to: filters.updatedTo ?? undefined,
				}}
				onChange={(next) =>
					onChange({
						updatedFrom: dateToIso(next.from),
						updatedTo: dateToIso(next.to),
					})
				}
			/>
			<DateRangePicker
				label={t("lastSynced")}
				labels={rangeLabels}
				value={{
					from: filters.syncedFrom ?? undefined,
					to: filters.syncedTo ?? undefined,
				}}
				onChange={(next) =>
					onChange({
						syncedFrom: dateToIso(next.from),
						syncedTo: dateToIso(next.to),
					})
				}
			/>
		</div>
	);
}
