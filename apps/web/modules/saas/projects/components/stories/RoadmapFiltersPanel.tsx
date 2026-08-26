"use client";

/**
 * RoadmapFiltersPanel
 *
 * The grouped body of the roadmap filters. Pure + prop-driven. Two tiers:
 *  - "primary": Type / Priority / Stage — always inline on the canvas.
 *  - "more":    Sync / Source / Dates / Flags — under the "More filters"
 *               disclosure.
 *
 * Layout is a TIGHT horizontal flow: each facet group is a small editorial
 * label sitting directly beside its control, and the groups wrap as a unit — so
 * there is no wide-column blank space. Every facet (Type / Priority / Stage /
 * Sync / Source) is the same compact `FacetMultiSelect` dropdown with a
 * FIXED-WIDTH trigger, so selecting a value tints it rose (`--primary`) without
 * ever changing its width — neighbouring facets never reflow. Tokens only —
 * correct in light + dark.
 */

import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@ui/components/command";
import { DatePicker } from "@ui/components/date-picker";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
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
import type { ReactNode } from "react";
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

function isoToDate(value: string | null): Date | undefined {
	if (!value) {
		return undefined;
	}
	const d = new Date(`${value}T00:00:00`);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

type ToggleOption<T extends string> = {
	value: T;
	label: string;
	/** A leading dot / icon / badge mirroring how the value reads on the cards. */
	leading?: ReactNode;
};

// The single facet control for the whole roadmap toolbar (Type / Priority /
// Stage / Sync / Source). An editorial label sits left of a FIXED-WIDTH trigger
// that tints rose when active and summarises the selection ("Any" / the single
// value / "N selected"). Because the trigger never changes width, toggling a
// value can't reflow its neighbours — that sibling reflow was the old filter
// "flicker". The popover is a cmdk checkbox list so several values toggle on
// without the row growing; the in-popover search box only appears for the
// longer option lists (Stage, Source) where scanning warrants it.
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
			? "Any"
			: activeCount === 1
				? count === 1
					? (options.find((o) => o.value === selected[0])?.label ??
						"1")
					: (extraOption?.label ?? "1")
				: `${activeCount} selected`;
	// A search box only earns its place on longer lists (Stage = 5, Source = 11);
	// on the short facets (Type / Priority / Sync) it's clutter, and dropping it
	// also keeps cmdk from filtering.
	const searchable = options.length > 4;
	const trigger = (
		<PopoverTrigger asChild>
			<button
				type="button"
				aria-label={`${label} filter`}
				className={cn(
					// Fixed width → the trigger never grows/shrinks with the
					// summary, so toggling a value can't reflow the row.
					"inline-flex w-36 items-center justify-between gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
					activeCount > 0
						? "border-primary/50 bg-primary/10 text-primary"
						: "border-border bg-transparent text-muted-foreground hover:border-foreground/40 hover:text-foreground",
				)}
			>
				<span className="truncate">{summary}</span>
				<ChevronDownIcon
					aria-hidden
					className="size-3.5 shrink-0 opacity-70"
				/>
			</button>
		</PopoverTrigger>
	);
	return (
		<div className="flex items-baseline gap-2.5">
			<span className="app-editorial-label shrink-0 translate-y-0.5">
				{label}
			</span>
			<Popover>
				{/* Long single-value summaries truncate; surface the full text on
					hover/focus. Multi/none summaries are always short, so the tooltip
					is force-closed for them via `open={false}` rather than by swapping
					the element out — keeping the tooltip mounted keeps the tree shape
					stable, so toggling the first/last facet while the popover is open
					can't remount (and re-focus) the trigger button. */}
				<Tooltip open={activeCount > 0 ? undefined : false}>
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

function DateRangeRow({
	label,
	from,
	to,
	onFromChange,
	onToChange,
}: {
	label: string;
	from: string | null;
	to: string | null;
	onFromChange: (value: string | null) => void;
	onToChange: (value: string | null) => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-24 shrink-0 text-muted-foreground text-xs">
				{label}
			</span>
			<DatePicker
				value={isoToDate(from)}
				onChange={(d) => onFromChange(dateToIso(d))}
				placeholder="From"
				className="h-8 flex-1"
			/>
			<DatePicker
				value={isoToDate(to)}
				onChange={(d) => onToChange(dateToIso(d))}
				placeholder="To"
				className="h-8 flex-1"
			/>
		</div>
	);
}

function RecencyRadio({
	label,
	value,
	onChange,
}: {
	label: string;
	value: RecencyWindowDays | null;
	onChange: (next: RecencyWindowDays | null) => void;
}) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-40 shrink-0 whitespace-nowrap text-muted-foreground text-xs">
				{label}
			</span>
			<RadioGroup
				value={value === null ? "none" : String(value)}
				onValueChange={(v) =>
					onChange(
						v === "none" ? null : (Number(v) as RecencyWindowDays),
					)
				}
				className="flex flex-1 flex-wrap items-center gap-x-8 gap-y-1"
				aria-label={label}
			>
				<Label className="flex items-center gap-1 text-xs text-muted-foreground">
					<RadioGroupItem value="none" /> Any
				</Label>
				{RECENCY_WINDOW_OPTIONS.map((days) => (
					<Label
						key={`${label}-${days}`}
						className="flex items-center gap-1 text-xs"
					>
						<RadioGroupItem value={String(days)} /> {days}d
					</Label>
				))}
			</RadioGroup>
		</div>
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
	<span className="flex size-5 items-center justify-center rounded-full border border-highlight/40 bg-highlight/10 text-highlight-foreground dark:text-muted-foreground">
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
			<div className="flex flex-wrap items-baseline gap-x-7 gap-y-3">
				<FacetMultiSelect
					label="Type"
					options={KIND_OPTIONS}
					selected={filters.kind}
					onChange={(kind) => onChange({ kind })}
				/>
				<FacetMultiSelect
					label="Priority"
					options={PRIORITY_OPTIONS}
					selected={filters.priority}
					onChange={(priority) => onChange({ priority })}
				/>
				<FacetMultiSelect
					label="Stage"
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
		<div className="space-y-5">
			{/* Uniform facet dropdowns: Sync / Source / Flags on one row,
			    consistent with the Type / Priority / Stage primary row. */}
			<div className="flex flex-wrap items-baseline gap-x-7 gap-y-3">
				<FacetMultiSelect
					label="Sync"
					options={SYNC_OPTIONS}
					selected={filters.sync}
					onChange={(sync) => onChange({ sync })}
				/>
				<FacetMultiSelect
					label="Source"
					options={SOURCE_OPTIONS}
					selected={filters.source}
					onChange={(source) => onChange({ source })}
				/>
				<FacetMultiSelect
					label="Size"
					options={SIZE_OPTIONS}
					selected={filters.size}
					onChange={(size) => onChange({ size })}
				/>
				<FacetMultiSelect
					label="Flags"
					options={FLAG_OPTIONS}
					selected={selectedFlags}
					onChange={handleFlagsChange}
				/>
				{(tagOptions.length > 0 || filters.tags.length > 0) && (
					<FacetMultiSelect
						label="Tags"
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
										label: "Match all (AND)",
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
			</div>

			{/* Dates: From/To ranges on the left, recency windows
			    (Any / 7d / 30d / 90d) on the right. Stacks on small screens. */}
			<div className="space-y-2.5">
				<span className="app-editorial-label">Dates</span>
				<div className="grid grid-cols-1 gap-x-10 gap-y-2 lg:grid-cols-2">
					<div className="space-y-2">
						<DateRangeRow
							label="Created"
							from={filters.createdFrom}
							to={filters.createdTo}
							onFromChange={(createdFrom) =>
								onChange({ createdFrom })
							}
							onToChange={(createdTo) => onChange({ createdTo })}
						/>
						<DateRangeRow
							label="Last updated"
							from={filters.updatedFrom}
							to={filters.updatedTo}
							onFromChange={(updatedFrom) =>
								onChange({ updatedFrom })
							}
							onToChange={(updatedTo) => onChange({ updatedTo })}
						/>
						<DateRangeRow
							label="Last synced"
							from={filters.syncedFrom}
							to={filters.syncedTo}
							onFromChange={(syncedFrom) =>
								onChange({ syncedFrom })
							}
							onToChange={(syncedTo) => onChange({ syncedTo })}
						/>
					</div>
					<div className="space-y-2">
						<RecencyRadio
							label="Recently approved"
							value={filters.recentlyApproved}
							onChange={(recentlyApproved) =>
								onChange({ recentlyApproved })
							}
						/>
						<RecencyRadio
							label="Recently added"
							value={filters.recentlyAdded}
							onChange={(recentlyAdded) =>
								onChange({ recentlyAdded })
							}
						/>
						<RecencyRadio
							label="Date Modified"
							value={filters.recentlyChanged}
							onChange={(recentlyChanged) =>
								onChange({ recentlyChanged })
							}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
