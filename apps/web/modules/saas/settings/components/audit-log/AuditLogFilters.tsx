"use client";

/**
 * AuditLogFilters
 *
 * Filter chip bar above the table. URL-synced via `useSearchParams` /
 * `useRouter` (we keep the dependency footprint small and avoid pulling
 * in `nuqs` for this single surface). Each chip is a Popover with a
 * Command-based multi-select keyboardable from the trigger.
 *
 * Filters are organized into "When · Who · What" groups so the toolbar
 * reads as a single coherent row even at narrow widths (items 14, 21).
 *
 * In personal mode the actor chip is rendered as a static badge (the
 * current user's email) because there are no peers to filter by.
 *
 * Item 9 removed the actor email substring chip; the Actor combobox now
 * carries the member dropdown AND the actor-type "Custom" sub-section.
 * Item 19 removed the "Errors only" switch — the severity multi-select
 * covers the same operator need.
 *
 * Spec: docs/audit-log/README.md §8.2,
 * §8.5.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import type { LucideIcon } from "lucide-react";
import {
	AlertOctagon,
	AlertTriangle,
	CheckCircle2,
	CheckIcon,
	Info,
	XCircle,
	XIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { AuditLogActionsHelpButton } from "./AuditLogActionsHelpButton";
import { AuditLogActorFilter } from "./AuditLogActorFilter";
import { AuditLogProjectFilter } from "./AuditLogProjectFilter";
import { describeActionKey } from "./audit-actions-catalog";
import type {
	AuditActorType,
	AuditLogFiltersState,
	AuditViewerMode,
	AuditViewerUser,
} from "./types";
import { EMPTY_FILTERS_STATE } from "./types";

interface AuditLogFiltersProps {
	mode: AuditViewerMode;
	organizationId: string | null;
	filters: AuditLogFiltersState;
	onFiltersChange: (next: AuditLogFiltersState) => void;
	/**
	 * Required in `personal` / `organization` mode (the actor chip pins to
	 * this user). In `explorer` mode pass `null` — the explorer has no
	 * view of the customer's user directory so the actor chip is hidden
	 * entirely.
	 */
	currentUser: AuditViewerUser | null;
	/**
	 * Optional taxonomy override. The in-product viewer queries
	 * `orpc.audit.taxonomy` directly. The explorer pre-computes a list
	 * from the page it observes and passes it in — the public REST surface
	 * does not expose the taxonomy endpoint, and re-rendering taxonomy
	 * from current rows is good enough for the filter chips.
	 */
	taxonomy?: { actions?: string[]; categories?: string[] };
}

const SEVERITY_OPTIONS = ["info", "warning", "error", "critical"] as const;
const OUTCOME_OPTIONS = ["success", "failure"] as const;

// Per-option icons matching the column-header tooltip legends so the
// filter dropdown reads the same visual language as the table. Tone
// classes use semantic CSS variables so they track light/dark theme
// automatically — no hardcoded hex values.
const SEVERITY_ICONS: Record<
	(typeof SEVERITY_OPTIONS)[number],
	{ icon: LucideIcon; toneClass: string }
> = {
	info: { icon: Info, toneClass: "text-muted-foreground" },
	warning: { icon: AlertTriangle, toneClass: "text-highlight" },
	error: { icon: AlertOctagon, toneClass: "text-destructive" },
	critical: { icon: AlertOctagon, toneClass: "text-destructive" },
};

const OUTCOME_ICONS: Record<
	(typeof OUTCOME_OPTIONS)[number],
	{ icon: LucideIcon; toneClass: string }
> = {
	success: { icon: CheckCircle2, toneClass: "text-secondary" },
	failure: { icon: XCircle, toneClass: "text-destructive" },
};

/**
 * Quick-time presets. `minutes` is preferred when present and produces a
 * (now - minutes) → now window; `days` falls back to a (today midnight)
 * or (now - days) → now window for the longer presets.
 */
const DATE_RANGE_PRESETS = [
	{ key: "last5Minutes", minutes: 5 },
	{ key: "lastHour", minutes: 60 },
	{ key: "today", days: 0 },
	{ key: "last7Days", days: 7 },
	{ key: "last30Days", days: 30 },
	{ key: "last90Days", days: 90 },
] as const;

/**
 * Serialize filter state to URL search params. We avoid encoding `null`
 * or empty arrays so the URL stays clean — empty filters are the
 * default.
 */
function serializeFilters(state: AuditLogFiltersState): URLSearchParams {
	const params = new URLSearchParams();
	if (state.actions.length) {
		params.set("actions", state.actions.join(","));
	}
	if (state.categories.length) {
		params.set("categories", state.categories.join(","));
	}
	if (state.actorIds.length) {
		params.set("actorIds", state.actorIds.join(","));
	}
	if (state.actorTypes.length) {
		params.set("actorTypes", state.actorTypes.join(","));
	}
	if (state.projectId) {
		params.set("projectId", state.projectId);
	}
	if (state.severities.length) {
		params.set("severities", state.severities.join(","));
	}
	if (state.outcomes.length) {
		params.set("outcomes", state.outcomes.join(","));
	}
	if (state.dateFrom) {
		params.set("dateFrom", state.dateFrom);
	}
	if (state.dateTo) {
		params.set("dateTo", state.dateTo);
	}
	if (state.correlationId) {
		params.set("correlationId", state.correlationId);
	}
	if (state.ipAddressContains) {
		params.set("ipAddressContains", state.ipAddressContains);
	}
	return params;
}

const VALID_ACTOR_TYPES: AuditActorType[] = [
	"user",
	"api_key",
	"system",
	"agent",
];

function deserializeFilters(params: URLSearchParams): AuditLogFiltersState {
	const parseList = (key: string): string[] => {
		const raw = params.get(key);
		if (!raw) {
			return [];
		}
		return raw.split(",").filter(Boolean);
	};
	const projectId = params.get("projectId") ?? undefined;
	const dateFrom = params.get("dateFrom") ?? undefined;
	const dateTo = params.get("dateTo") ?? undefined;
	const correlationId = params.get("correlationId") ?? undefined;
	const ipAddressContains = params.get("ipAddressContains") ?? undefined;
	const actorTypesRaw = parseList("actorTypes");
	const actorTypes = actorTypesRaw.filter((v): v is AuditActorType =>
		(VALID_ACTOR_TYPES as readonly string[]).includes(v),
	) as AuditActorType[];
	return {
		actions: parseList("actions"),
		categories: parseList("categories"),
		actorIds: parseList("actorIds"),
		actorTypes,
		projectId: projectId || undefined,
		severities: parseList("severities"),
		outcomes: parseList("outcomes"),
		dateFrom,
		dateTo,
		correlationId: correlationId || undefined,
		ipAddressContains: ipAddressContains || undefined,
	};
}

/**
 * Multi-select chip — Popover trigger that opens a Command list. The
 * trigger label shows the count of selected items so the active filter
 * state is visible without opening the popover.
 */
function MultiSelectChip({
	label,
	ariaLabel,
	options,
	values,
	onToggle,
	placeholder,
	renderOption,
	renderIcon,
	renderOptionTooltip,
	tooltip,
}: {
	label: string;
	ariaLabel: string;
	options: string[];
	values: string[];
	onToggle: (value: string) => void;
	placeholder: string;
	renderOption?: (value: string) => string;
	/**
	 * Optional per-option icon. When provided the icon renders both in
	 * each Command item and (for single-selected state) inside the
	 * trigger button, so the chip reads visually like the column-header
	 * legend tooltips. Tone class is forwarded through `text-*` so colors
	 * track the active theme via CSS variables.
	 */
	renderIcon?: (
		value: string,
	) => { icon: LucideIcon; toneClass: string } | null;
	/**
	 * Optional per-option hover description. When provided, hovering a
	 * row in the Command list shows a tooltip explaining the option —
	 * used by the Action filter to surface the audit-action catalog
	 * descriptions next to each event key without forcing the user to
	 * open the help dialog.
	 */
	renderOptionTooltip?: (value: string) => string | null;
	tooltip?: string;
}) {
	const count = values.length;
	const singleSelected = count === 1 ? values[0] : null;
	const singleIcon = singleSelected
		? (renderIcon?.(singleSelected) ?? null)
		: null;
	const SingleIcon = singleIcon?.icon;
	const trigger = (
		<PopoverTrigger asChild>
			<Button
				variant="outline"
				size="sm"
				aria-label={ariaLabel}
				className="h-9 gap-2 text-sm"
			>
				<span className="text-muted-foreground">{label}:</span>
				{SingleIcon && singleIcon ? (
					<SingleIcon
						className={cn(
							"size-3.5 shrink-0",
							singleIcon.toneClass,
						)}
						aria-hidden
					/>
				) : null}
				<span className="text-foreground">
					{count === 0
						? placeholder
						: count === 1
							? (renderOption?.(singleSelected!) ??
								singleSelected!)
							: `${count} selected`}
				</span>
			</Button>
		</PopoverTrigger>
	);
	return (
		<Popover>
			{tooltip ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>{trigger}</TooltipTrigger>
						<TooltipContent>{tooltip}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : (
				trigger
			)}
			<PopoverContent className="w-72 p-0" align="start">
				<Command>
					<CommandInput
						placeholder={`Search ${label.toLowerCase()}`}
					/>
					<CommandList>
						<CommandEmpty>No matches.</CommandEmpty>
						<CommandGroup>
							{options.map((option) => {
								const selected = values.includes(option);
								const optionIcon = renderIcon?.(option) ?? null;
								const OptionIcon = optionIcon?.icon;
								const optionTip =
									renderOptionTooltip?.(option) ?? null;
								const item = (
									<CommandItem
										key={option}
										value={option}
										onSelect={() => onToggle(option)}
									>
										<div className="mr-2 flex h-4 w-4 items-center justify-center">
											{selected ? (
												<CheckIcon className="size-3.5" />
											) : null}
										</div>
										{OptionIcon && optionIcon ? (
											<OptionIcon
												className={cn(
													"mr-2 size-3.5 shrink-0",
													optionIcon.toneClass,
												)}
												aria-hidden
											/>
										) : null}
										<span className="truncate">
											{renderOption?.(option) ?? option}
										</span>
									</CommandItem>
								);
								if (!optionTip) {
									return item;
								}
								return (
									<TooltipProvider key={option}>
										<Tooltip delayDuration={250}>
											<TooltipTrigger asChild>
												{item}
											</TooltipTrigger>
											<TooltipContent
												side="right"
												align="start"
												surface="popover"
												className="max-w-xs text-xs leading-relaxed"
											>
												{optionTip}
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/**
 * Convert an ISO timestamp to the `YYYY-MM-DDTHH:mm` shape that the
 * native `<input type="datetime-local">` accepts. Returns an empty
 * string when the input is missing — that empties the input.
 *
 * Reads the value in UTC so the input matches the UTC timestamp column
 * in the table. The chip label and the audit table both display UTC,
 * so the operator never has to mentally translate between zones — what
 * they type is what they see.
 */
function isoToUtcInputValue(iso: string | undefined): string {
	if (!iso) {
		return "";
	}
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return "";
	}
	const pad = (n: number) => String(n).padStart(2, "0");
	const yyyy = d.getUTCFullYear();
	const mm = pad(d.getUTCMonth() + 1);
	const dd = pad(d.getUTCDate());
	const hh = pad(d.getUTCHours());
	const min = pad(d.getUTCMinutes());
	return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

/**
 * Convert a `YYYY-MM-DDTHH:mm` value emitted by `<input
 * type="datetime-local">` to a full ISO string. Interprets the value
 * as UTC (matching the table column + the chip label). Empty input →
 * undefined so the URL filter clears the value.
 */
function utcInputValueToIso(value: string): string | undefined {
	if (!value) {
		return undefined;
	}
	// Append the `Z` so Date treats the components as UTC instead of
	// local. Format from `datetime-local` is `YYYY-MM-DDTHH:mm`, never
	// includes seconds in this picker, so append `:00Z` for an
	// unambiguous round trip.
	const iso = `${value}:00Z`;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return undefined;
	}
	return d.toISOString();
}

function DateRangeChip({
	label,
	ariaLabel,
	value,
	onChange,
	tooltip,
}: {
	label: string;
	ariaLabel: string;
	value: { dateFrom?: string; dateTo?: string };
	onChange: (next: { dateFrom?: string; dateTo?: string }) => void;
	tooltip?: string;
}) {
	const t = useTranslations();
	const activeLabel = useMemo(() => {
		if (!value.dateFrom && !value.dateTo) {
			return "—";
		}
		// Always render in UTC so the chip telegraphs the active window
		// in the same timezone as the table's TIMESTAMP column — no
		// mental translation between local + UTC. Date-only when the
		// time aligns to midnight UTC; full date+time otherwise.
		const fmt = (iso?: string) => {
			if (!iso) {
				return "…";
			}
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) {
				return "…";
			}
			const isMidnight =
				d.getUTCHours() === 0 &&
				d.getUTCMinutes() === 0 &&
				d.getUTCSeconds() === 0;
			return isMidnight
				? new Intl.DateTimeFormat(undefined, {
						timeZone: "UTC",
						month: "short",
						day: "numeric",
					}).format(d)
				: new Intl.DateTimeFormat(undefined, {
						timeZone: "UTC",
						month: "short",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
						hour12: false,
					}).format(d);
		};
		return `${fmt(value.dateFrom)} → ${fmt(value.dateTo)} UTC`;
	}, [value.dateFrom, value.dateTo]);

	const applyPreset = (preset: (typeof DATE_RANGE_PRESETS)[number]) => {
		const now = new Date();
		const to = new Date(now);
		const from = new Date(now);
		if ("minutes" in preset) {
			from.setMinutes(from.getMinutes() - preset.minutes);
		} else if (preset.days <= 0) {
			from.setHours(0, 0, 0, 0);
		} else {
			from.setDate(from.getDate() - preset.days);
		}
		onChange({
			dateFrom: from.toISOString(),
			dateTo: to.toISOString(),
		});
	};

	const fromInputId = useId();
	const toInputId = useId();
	const fromInputValue = isoToUtcInputValue(value.dateFrom);
	const toInputValue = isoToUtcInputValue(value.dateTo);
	const handleFromChange = (raw: string) => {
		onChange({
			dateFrom: utcInputValueToIso(raw),
			dateTo: value.dateTo,
		});
	};
	const handleToChange = (raw: string) => {
		onChange({
			dateFrom: value.dateFrom,
			dateTo: utcInputValueToIso(raw),
		});
	};

	const trigger = (
		<PopoverTrigger asChild>
			<Button
				variant="outline"
				size="sm"
				aria-label={ariaLabel}
				className="h-9 gap-2 text-sm"
			>
				<span className="text-muted-foreground">{label}:</span>
				<span className="text-foreground">{activeLabel}</span>
			</Button>
		</PopoverTrigger>
	);

	return (
		<Popover>
			{tooltip ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>{trigger}</TooltipTrigger>
						<TooltipContent>{tooltip}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : (
				trigger
			)}
			<PopoverContent
				className="flex max-h-[min(440px,calc(100vh-8rem))] w-80 flex-col overflow-y-auto p-3"
				align="start"
				collisionPadding={16}
			>
				<div
					className="flex flex-col gap-1"
					role="radiogroup"
					aria-label={ariaLabel}
				>
					<p className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
						{t("settings.auditLog.filters.dateRange.presetHeading")}
					</p>
					{DATE_RANGE_PRESETS.map((preset) => (
						<Button
							key={preset.key}
							variant="ghost"
							size="sm"
							className="justify-start"
							role="radio"
							aria-checked={false}
							onClick={() => applyPreset(preset)}
						>
							{t(
								`settings.auditLog.filters.dateRange.presets.${preset.key}`,
							)}
						</Button>
					))}
				</div>
				<div className="my-3 border-t border-border/40" />
				<div className="flex flex-col gap-3">
					<p className="px-1 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
						{t("settings.auditLog.filters.dateRange.customHeading")}
					</p>
					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor={fromInputId}
							className="text-[11px] font-medium text-muted-foreground"
						>
							{t("settings.auditLog.filters.dateRange.fromLabel")}
						</Label>
						<Input
							id={fromInputId}
							type="datetime-local"
							value={fromInputValue}
							onChange={(e) => handleFromChange(e.target.value)}
							max={toInputValue || undefined}
							className="h-9 text-sm"
							data-testid="audit-date-from-input"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor={toInputId}
							className="text-[11px] font-medium text-muted-foreground"
						>
							{t("settings.auditLog.filters.dateRange.toLabel")}
						</Label>
						<Input
							id={toInputId}
							type="datetime-local"
							value={toInputValue}
							onChange={(e) => handleToChange(e.target.value)}
							min={fromInputValue || undefined}
							className="h-9 text-sm"
							data-testid="audit-date-to-input"
						/>
					</div>
					<p className="text-[10px] text-muted-foreground/80">
						{t("settings.auditLog.filters.dateRange.timezoneHint")}
					</p>
				</div>
				<div className="mt-3 border-t border-border/40 pt-2">
					<Button
						variant="ghost"
						size="sm"
						className="w-full justify-start text-muted-foreground"
						onClick={() =>
							onChange({
								dateFrom: undefined,
								dateTo: undefined,
							})
						}
						data-testid="audit-date-clear"
					>
						<XIcon className="size-3.5" />
						<span className="ml-2">
							{t("settings.auditLog.filters.dateRange.clear")}
						</span>
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/**
 * Debounced text input for "contains" filters. Emits onCommit only after
 * 300ms of no further typing — keeps the URL/query stable while the user
 * is still typing.
 */
function DebouncedTextChip({
	id,
	label,
	ariaLabel,
	placeholder,
	value,
	onCommit,
	tooltip,
	font = "default",
}: {
	id: string;
	label: string;
	ariaLabel: string;
	placeholder: string;
	value: string;
	onCommit: (next: string) => void;
	tooltip?: string;
	font?: "default" | "mono";
}) {
	const [local, setLocal] = useState(value);
	const lastSentRef = useRef(value);
	useEffect(() => {
		if (value !== lastSentRef.current) {
			setLocal(value);
			lastSentRef.current = value;
		}
	}, [value]);

	useEffect(() => {
		if (local === lastSentRef.current) {
			return;
		}
		const t = window.setTimeout(() => {
			lastSentRef.current = local;
			onCommit(local);
		}, 300);
		return () => window.clearTimeout(t);
	}, [local, onCommit]);

	const inner = (
		<div className="flex items-center gap-1">
			<Label htmlFor={id} className="text-sm text-muted-foreground">
				{label}:
			</Label>
			<Input
				id={id}
				type="text"
				value={local}
				onChange={(event) => setLocal(event.target.value)}
				placeholder={placeholder}
				aria-label={ariaLabel}
				className={
					font === "mono"
						? "h-9 w-44 text-sm font-mono"
						: "h-9 w-48 text-sm"
				}
			/>
		</div>
	);

	if (!tooltip) {
		return inner;
	}
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>{inner}</TooltipTrigger>
				<TooltipContent>{tooltip}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

/**
 * Visual group header inside the filter toolbar — editorial label.
 *
 * The thin vertical bar on the left echoes the app's editorial-label
 * pattern (uppercase prefix with a primary-tinted accent stripe), so
 * the When / Who / What / Where groups read as named sections rather
 * than a flat run of chips.
 */
function GroupLabel({ children }: { children: React.ReactNode }) {
	return (
		<span className="inline-flex select-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
			<span
				aria-hidden="true"
				className="inline-block h-3 w-0.5 rounded-sm bg-primary/60"
			/>
			{children}
		</span>
	);
}

/**
 * Wraps one logical filter group (label + chips) as a single flex-wrap
 * unit. The outer toolbar then wraps **between** groups rather than
 * shuffling individual chips across rows — so the relationship between
 * a group label and its chips stays intact at any viewport width.
 */
function FilterGroup({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-x-2 gap-y-1.5",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function AuditLogFilters({
	mode,
	organizationId,
	filters,
	onFiltersChange,
	currentUser,
	taxonomy: taxonomyOverride,
}: AuditLogFiltersProps) {
	const t = useTranslations();
	const router = useRouter();
	const searchParams = useSearchParams();
	const isExplorer = mode === "explorer";

	// Hydrate filter state from URL on mount.
	useEffect(() => {
		const next = deserializeFilters(searchParams ?? new URLSearchParams());
		if (mode === "personal" && currentUser) {
			next.actorIds = [currentUser.id];
		}
		if (JSON.stringify(next) !== JSON.stringify(filters)) {
			onFiltersChange(next);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		// In explorer mode the URL is owned by the page (api-key entry,
		// base URL history). Skip URL sync so the explorer's hash/query
		// doesn't churn on filter edits.
		if (isExplorer) {
			return;
		}
		const params = serializeFilters(filters);
		const qs = params.toString();
		router.replace(qs ? `?${qs}` : "?", { scroll: false });
	}, [filters, router, isExplorer]);

	// Skip the in-product taxonomy query entirely when in explorer mode —
	// the explorer's data source is the public REST proxy which has no
	// taxonomy endpoint. The caller is expected to pass `taxonomy` with
	// values derived from the rows already on screen.
	const { data: taxonomyData } = useQuery({
		queryKey: ["audit-log", "taxonomy"] as const,
		queryFn: () => orpcClient.audit.taxonomy({}),
		staleTime: 1000 * 60 * 60,
		enabled: !isExplorer,
	});
	const taxonomy = taxonomyOverride ?? taxonomyData;

	const toggleList = useCallback(
		(field: keyof AuditLogFiltersState) => (value: string) => {
			const current = (filters[field] as string[]) ?? [];
			const next = current.includes(value)
				? current.filter((v) => v !== value)
				: [...current, value];
			onFiltersChange({
				...filters,
				[field]: next,
			} as AuditLogFiltersState);
		},
		[filters, onFiltersChange],
	);

	const setDateRange = useCallback(
		(next: { dateFrom?: string; dateTo?: string }) => {
			onFiltersChange({
				...filters,
				dateFrom: next.dateFrom,
				dateTo: next.dateTo,
			});
		},
		[filters, onFiltersChange],
	);

	const resetFilters = useCallback(() => {
		onFiltersChange(
			mode === "personal" && currentUser
				? { ...EMPTY_FILTERS_STATE, actorIds: [currentUser.id] }
				: EMPTY_FILTERS_STATE,
		);
	}, [mode, currentUser, onFiltersChange]);

	// Filter order matches the table columns left-to-right (items 14, 21):
	//   When     -> Date range
	//   Who      -> Actor (incl. actor-type "Custom"); Project
	//   What     -> Correlation, Action, Category, Severity, Outcome
	//   Where    -> IP

	return (
		<div
			// position:sticky kept so the toolbar stays at the viewport top
			// when scrolling long event lists. We set z-20 so the toolbar
			// sits above the table rows but below the metadata Sheet (z-50).
			//
			// Stack groups vertically so each (label + chips) pair owns one
			// row — the relationship between the editorial group label
			// and its chips is unmistakable at every viewport width, and
			// the eye scans down a clean column rather than a wrapped grid.
			//
			// The wrapper itself uses the lighter `bg-muted/40` surface so
			// the toolbar feels like a "tray" against the page background
			// rather than a heavily outlined panel. Pairs better with the
			// in-card AuditLogTable that sits directly underneath it.
			className="sticky top-0 z-20 flex flex-col gap-2 rounded-lg border border-border/40 bg-muted/40 px-3 py-3"
			role="toolbar"
			aria-label={t("settings.auditLog.label")}
		>
			{/* When group */}
			<FilterGroup>
				<GroupLabel>
					{t("settings.auditLog.filterGroups.when")}
				</GroupLabel>
				<DateRangeChip
					label={t("settings.auditLog.filters.dateRange.label")}
					ariaLabel={t(
						"settings.auditLog.filters.dateRange.ariaLabel",
					)}
					value={{
						dateFrom: filters.dateFrom,
						dateTo: filters.dateTo,
					}}
					onChange={setDateRange}
					tooltip={t("settings.auditLog.tooltips.filterDateRange")}
				/>
			</FilterGroup>

			{/* Who group. Hidden entirely in explorer mode — the proxy
				procedure has no view of the customer's member directory or
				project list, so the chips would be empty / meaningless. */}
			{!isExplorer ? (
				<FilterGroup>
					<GroupLabel>
						{t("settings.auditLog.filterGroups.who")}
					</GroupLabel>
					{mode === "personal" && currentUser ? (
						<Badge
							variant="outline"
							className="h-9 px-3 text-sm"
							title={t(
								"settings.auditLog.filters.actor.personalLockedTitle",
							)}
						>
							<span className="text-muted-foreground">
								{t("settings.auditLog.filters.actor.label")}:
							</span>
							<span className="ml-1 text-foreground">
								{currentUser.email}
							</span>
						</Badge>
					) : organizationId ? (
						<>
							<AuditLogActorFilter
								organizationId={organizationId}
								selectedActorId={filters.actorIds[0]}
								selectedActorTypes={filters.actorTypes}
								onSelect={(member) =>
									onFiltersChange({
										...filters,
										actorIds: member ? [member.id] : [],
									})
								}
								onActorTypesChange={(types) =>
									onFiltersChange({
										...filters,
										actorTypes: types,
									})
								}
							/>
							<AuditLogProjectFilter
								organizationId={organizationId}
								selectedProjectId={filters.projectId}
								onSelect={(project) =>
									onFiltersChange({
										...filters,
										projectId: project
											? project.id
											: undefined,
									})
								}
							/>
						</>
					) : null}
				</FilterGroup>
			) : null}

			{/* What group */}
			<FilterGroup>
				<GroupLabel>
					{t("settings.auditLog.filterGroups.what")}
				</GroupLabel>
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<div className="flex items-center gap-1">
								<Label
									htmlFor="audit-correlation-id"
									className="text-sm text-muted-foreground"
								>
									{t(
										"settings.auditLog.filters.correlation.label",
									)}
									:
								</Label>
								<Input
									id="audit-correlation-id"
									type="text"
									data-audit-filter-search
									value={filters.correlationId ?? ""}
									onChange={(event) =>
										onFiltersChange({
											...filters,
											correlationId:
												event.target.value || undefined,
										})
									}
									placeholder={t(
										"settings.auditLog.filters.correlation.placeholder",
									)}
									aria-label={t(
										"settings.auditLog.filters.correlation.ariaLabel",
									)}
									className="h-9 w-44 text-sm font-mono"
								/>
							</div>
						</TooltipTrigger>
						<TooltipContent>
							{t("settings.auditLog.tooltips.filterCorrelation")}
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
				<div className="inline-flex items-center gap-1">
					<MultiSelectChip
						label={t("settings.auditLog.filters.action.label")}
						ariaLabel={t(
							"settings.auditLog.filters.action.ariaLabel",
						)}
						options={taxonomy?.actions ?? []}
						values={filters.actions}
						onToggle={toggleList("actions")}
						placeholder={t(
							"settings.auditLog.filters.action.placeholder",
						)}
						tooltip={t("settings.auditLog.tooltips.filterAction")}
						renderOptionTooltip={(value) =>
							describeActionKey(value)
						}
					/>
					<AuditLogActionsHelpButton />
				</div>
				<MultiSelectChip
					label={t("settings.auditLog.filters.category.label")}
					ariaLabel={t(
						"settings.auditLog.filters.category.ariaLabel",
					)}
					options={taxonomy?.categories ?? []}
					values={filters.categories}
					onToggle={toggleList("categories")}
					placeholder={t(
						"settings.auditLog.filters.category.placeholder",
					)}
					tooltip={t("settings.auditLog.tooltips.filterCategory")}
				/>
				<MultiSelectChip
					label={t("settings.auditLog.filters.severity.label")}
					ariaLabel={t(
						"settings.auditLog.filters.severity.ariaLabel",
					)}
					options={[...SEVERITY_OPTIONS]}
					values={filters.severities}
					onToggle={toggleList("severities")}
					placeholder={t(
						"settings.auditLog.filters.severity.placeholder",
					)}
					renderOption={(value) =>
						t(
							`settings.auditLog.severities.${value as "info" | "warning" | "error" | "critical"}`,
						)
					}
					renderIcon={(value) =>
						SEVERITY_ICONS[
							value as (typeof SEVERITY_OPTIONS)[number]
						] ?? null
					}
					tooltip={t("settings.auditLog.tooltips.filterSeverity")}
				/>
				<MultiSelectChip
					label={t("settings.auditLog.filters.outcome.label")}
					ariaLabel={t("settings.auditLog.filters.outcome.ariaLabel")}
					options={[...OUTCOME_OPTIONS]}
					values={filters.outcomes}
					onToggle={toggleList("outcomes")}
					placeholder={t(
						"settings.auditLog.filters.outcome.placeholder",
					)}
					renderOption={(value) =>
						t(
							`settings.auditLog.outcomes.${value as "success" | "failure"}`,
						)
					}
					renderIcon={(value) =>
						OUTCOME_ICONS[
							value as (typeof OUTCOME_OPTIONS)[number]
						] ?? null
					}
					tooltip={t("settings.auditLog.tooltips.filterOutcome")}
				/>
			</FilterGroup>

			{/* Where group */}
			<FilterGroup>
				<GroupLabel>
					{t("settings.auditLog.filterGroups.where")}
				</GroupLabel>
				<DebouncedTextChip
					id="audit-ip-address"
					label={t("settings.auditLog.filters.ipAddress.label")}
					ariaLabel={t(
						"settings.auditLog.filters.ipAddress.ariaLabel",
					)}
					placeholder={t(
						"settings.auditLog.filters.ipAddress.placeholder",
					)}
					value={filters.ipAddressContains ?? ""}
					onCommit={(next) =>
						onFiltersChange({
							...filters,
							ipAddressContains: next || undefined,
						})
					}
					tooltip={t("settings.auditLog.tooltips.filterIpAddress")}
					font="mono"
				/>
			</FilterGroup>

			{/* Reset filters — own row, right-aligned to telegraph "destructive
				vs additive" affordance away from the chip rows */}
			<div className="-mb-1 flex justify-end pt-1">
				<Button
					variant="ghost"
					size="sm"
					onClick={resetFilters}
					className="h-8 text-muted-foreground"
				>
					<XIcon className="mr-1 size-3.5" />
					{t("settings.auditLog.filters.reset")}
				</Button>
			</div>
		</div>
	);
}
