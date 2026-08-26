"use client";

import {
	type AiUsageLimitDto,
	useAiUsageLimits,
} from "@saas/payments/hooks/useAiUsageLimits";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import {
	TableBody,
	TableCell,
	TableHead,
	TableRow,
} from "@ui/components/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { format, formatDistanceToNow } from "date-fns";
import {
	ArrowDownIcon,
	ArrowUpDownIcon,
	ArrowUpIcon,
	CalendarIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronsUpDownIcon,
	DollarSignIcon,
	DownloadIcon,
	HelpCircleIcon,
	Loader2Icon,
	RotateCcwIcon,
	TimerIcon,
	UserIcon,
	XIcon,
	ZoomInIcon,
	ZoomOutIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useEffect, useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Tooltip as RechartsTooltip,
	ReferenceArea,
	ReferenceLine,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";
import { AiUsageLimitsCard } from "./AiUsageLimitsCard";

type PeriodKey = "24h" | "7d" | "30d" | "90d";
type TaskType =
	| "SIMPLE"
	| "COMPLEX"
	| "REASONING"
	| "CHAT"
	| "TOOL_CALLING"
	| "EMBEDDING"
	| "IMAGE"
	| "AUDIO"
	| "EVAL";
type StatusFilter = "all" | "success" | "error";
type SortBy = "createdAt" | "totalTokens" | "costMicroUsd" | "latencyMs";
type SortOrder = "asc" | "desc";

// Sentinel `null` represents "no project" inside the multi-select project
// filter. The backend accepts `null` elements in the projectIds array.
type ProjectIdSelection = string | null;

const PERIOD_OPTIONS: Array<{
	value: PeriodKey;
	label: string;
	periodHours?: number;
	periodDays?: number;
	caption: string;
}> = [
	{ value: "24h", label: "24h", periodHours: 24, caption: "Last 24 hours" },
	{ value: "7d", label: "7 days", periodDays: 7, caption: "Last 7 days" },
	{
		value: "30d",
		label: "30 days",
		periodDays: 30,
		caption: "Last 30 days",
	},
	{
		value: "90d",
		label: "90 days",
		periodDays: 90,
		caption: "Last 90 days",
	},
];

const TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
	{ value: "CHAT", label: "Chat" },
	{ value: "TOOL_CALLING", label: "Tool calling" },
	{ value: "REASONING", label: "Reasoning" },
	{ value: "COMPLEX", label: "Complex" },
	{ value: "SIMPLE", label: "Simple" },
	{ value: "EMBEDDING", label: "Embedding" },
	{ value: "IMAGE", label: "Image" },
	{ value: "AUDIO", label: "Audio" },
	{ value: "EVAL", label: "Eval" },
];

const TASK_TYPE_LABELS: Record<TaskType, string> = TASK_TYPE_OPTIONS.reduce(
	(acc, opt) => {
		acc[opt.value] = opt.label;
		return acc;
	},
	{} as Record<TaskType, string>,
);

const STALE_TIME = 60_000;
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

// Shared trigger className so SelectTriggers and Popover Buttons paint
// identically in both themes. Without this the Button-outline variant
// gets `dark:bg-input/30` while SelectTrigger uses `bg-background`,
// which is what made the filter row look two-toned in dark mode.
const FILTER_TRIGGER_CLASS =
	"h-9 w-full justify-between gap-2 rounded-md border border-border bg-card px-3 text-xs font-normal text-foreground hover:bg-muted/50 dark:bg-card dark:border-border dark:hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring";

type Timezone = "local" | "utc";
const TZ_STORAGE_KEY = "fabric.ai-usage.tz";

/**
 * Format a Date in either the user's local timezone or UTC. Implementation
 * detail: when tz="utc" we shift the Date by the local offset before
 * calling date-fns `format` so its local-zone formatting effectively
 * renders UTC values. Avoids a date-fns-tz dependency.
 */
function formatTz(d: Date | string, pattern: string, tz: Timezone): string {
	const date = typeof d === "string" ? new Date(d) : d;
	if (tz === "utc") {
		const shifted = new Date(
			date.getTime() + date.getTimezoneOffset() * 60_000,
		);
		return format(shifted, pattern);
	}
	return format(date, pattern);
}

function tzSuffix(tz: Timezone): string {
	if (tz === "utc") {
		return "UTC";
	}
	// Browser short TZ name (e.g. "PDT", "GMT+1") for local context.
	try {
		const dtf = new Intl.DateTimeFormat(undefined, {
			timeZoneName: "short",
		});
		const parts = dtf.formatToParts(new Date());
		const name = parts.find((p) => p.type === "timeZoneName")?.value;
		if (name) {
			return name;
		}
	} catch {}
	return "Local";
}

function useTimezone() {
	const [tz, setTzState] = useState<Timezone>("local");
	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(TZ_STORAGE_KEY);
			if (stored === "utc" || stored === "local") {
				setTzState(stored);
			}
		} catch {}
	}, []);
	const setTz = (next: Timezone) => {
		setTzState(next);
		try {
			window.localStorage.setItem(TZ_STORAGE_KEY, next);
		} catch {}
	};
	return [tz, setTz] as const;
}

function formatUsdFromMicros(microUsd: number): string {
	const usd = microUsd / 1_000_000;
	if (usd === 0) {
		return "$0.00";
	}
	if (usd < 0.001) {
		return "<$0.001";
	}
	if (usd < 1) {
		return `$${usd.toFixed(4)}`;
	}
	if (usd < 100) {
		return `$${usd.toFixed(2)}`;
	}
	return `$${Math.round(usd).toLocaleString()}`;
}

function formatTokens(n: number): string {
	if (n < 1_000) {
		return n.toLocaleString();
	}
	if (n < 1_000_000) {
		return `${(n / 1_000).toFixed(1)}k`;
	}
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatLatency(ms: number): string {
	if (ms < 1) {
		return "—";
	}
	if (ms < 1_000) {
		return `${ms}ms`;
	}
	const s = ms / 1_000;
	if (s < 60) {
		return `${s.toFixed(1)}s`;
	}
	const m = Math.floor(s / 60);
	return `${m}m ${Math.round(s - m * 60)}s`;
}

function formatModel(raw: string | null | undefined): string {
	if (!raw) {
		return "—";
	}
	const slash = raw.lastIndexOf("/");
	return slash >= 0 ? raw.slice(slash + 1) : raw;
}

function formatTaskType(value: string | null): string {
	if (!value) {
		return "—";
	}
	return value
		.toLowerCase()
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

type DateRange = { from: Date | undefined; to: Date | undefined };

type ActivityRow = {
	id: string;
	createdAt: string | Date;
	userId: string | null;
	userName: string | null;
	userEmail: string | null;
	provider: string;
	modelCanonicalName: string | null;
	providerModelId: string;
	taskType: string | null;
	agentId: string | null;
	conversationId: string | null;
	jobType?: string | null;
	projectId: string | null;
	projectName: string | null;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costMicroUsd: number;
	latencyMs: number;
	success: boolean;
	errorMessage: string | null;
};

function SummaryTile({
	label,
	value,
	subtitle,
	tooltip,
	onClick,
	active = false,
	loading = false,
}: {
	label: string;
	value: string;
	subtitle?: string;
	tooltip?: string;
	onClick?: () => void;
	active?: boolean;
	loading?: boolean;
}) {
	// While loading, the tile is purely decorative — disable click and key
	// handlers so users can't toggle a chart metric onto skeleton data.
	const interactive = Boolean(onClick) && !loading;
	const inner = (
		<>
			<CardHeader className="pb-1">
				<CardTitle
					className={cn(
						"flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider",
						active ? "text-primary" : "text-muted-foreground",
					)}
				>
					{label}
					{tooltip ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="text-muted-foreground/60 hover:text-muted-foreground"
									aria-label={`${label} details`}
									onClick={(e) => e.stopPropagation()}
								>
									<HelpCircleIcon className="h-3.5 w-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs text-xs">
								{tooltip}
							</TooltipContent>
						</Tooltip>
					) : null}
				</CardTitle>
			</CardHeader>
			<CardContent>
				{loading ? (
					<>
						<Skeleton className="h-7 w-24" />
						{subtitle ? (
							<Skeleton className="mt-2 h-2.5 w-20" />
						) : null}
					</>
				) : (
					<>
						<div className="font-display text-2xl font-semibold tabular-nums">
							{value}
						</div>
						{subtitle ? (
							<div className="mt-0.5 text-[11px] text-muted-foreground">
								{subtitle}
							</div>
						) : null}
					</>
				)}
			</CardContent>
		</>
	);
	const classes = cn(
		"transition-colors",
		active ? "bg-primary/10 ring-1 ring-primary/40" : "bg-muted/40",
		interactive && "cursor-pointer hover:bg-muted/60",
	);
	if (interactive) {
		return (
			<Card
				role="button"
				tabIndex={0}
				aria-pressed={active}
				aria-busy={loading}
				onClick={onClick}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onClick?.();
					}
				}}
				className={classes}
			>
				{inner}
			</Card>
		);
	}
	return (
		<Card aria-busy={loading} className={classes}>
			{inner}
		</Card>
	);
}

export function AiUsageActivityView({
	organizationId,
	organizationName,
}: {
	organizationId?: string;
	organizationName?: string;
}) {
	const tTooltips = useTranslations("tooltips.common");
	const [tz, setTz] = useTimezone();
	const [period, setPeriod] = useState<PeriodKey>("30d");
	const [customRange, setCustomRange] = useState<DateRange>({
		from: undefined,
		to: undefined,
	});
	const [customFromTime, setCustomFromTime] = useState<string>("00:00");
	const [customToTime, setCustomToTime] = useState<string>("23:59");
	const [calendarOpen, setCalendarOpen] = useState(false);
	// Metric the chart should plot — lifted up so the summary tiles
	// (top of page) can drive the chart selection.
	const [chartMetric, setChartMetric] = useState<ChartMetric>("cost");
	const [pageSize, setPageSize] = useState<PageSize>(25);
	// Multi-select filters store an empty array when "all" — that gets
	// translated to `undefined` (no filter) at the queryInput boundary so
	// we don't send empty arrays over the wire on every fetch.
	const [taskTypes, setTaskTypes] = useState<TaskType[]>([]);
	const [status, setStatus] = useState<StatusFilter>("all");
	const [providerModelIds, setProviderModelIds] = useState<string[]>([]);
	const [projectIds, setProjectIds] = useState<ProjectIdSelection[]>([]);
	const [memberIds, setMemberIds] = useState<string[]>([]);
	const [taskTypePickerOpen, setTaskTypePickerOpen] = useState(false);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	const [memberPickerOpen, setMemberPickerOpen] = useState(false);
	const [selectedRow, setSelectedRow] = useState<ActivityRow | null>(null);
	// Range filters in user-friendly units; converted at the API boundary.
	const [minCostUsd, setMinCostUsd] = useState<string>("");
	const [maxCostUsd, setMaxCostUsd] = useState<string>("");
	const [minLatencyMs, setMinLatencyMs] = useState<string>("");
	const [maxLatencyMs, setMaxLatencyMs] = useState<string>("");
	const [sortBy, setSortBy] = useState<SortBy>("createdAt");
	const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

	// AI usage limits — read once at this level so we can both (a) pass
	// `canManage` down to the new card and (b) compute the
	// recharts ReferenceLine overlay. The hook polls and
	// shares its cache with the card via TanStack Query, so this is not
	// a duplicate fetch. Defaults to `false` while loading — we never
	// flash the manage affordances before the auth gate has resolved.
	const limitsQuery = useAiUsageLimits(organizationId ?? null);
	const canManage = limitsQuery.data?.canManage ?? false;
	const activeLimits = limitsQuery.data?.limits ?? [];

	const periodOption = PERIOD_OPTIONS.find((o) => o.value === period);

	// Custom mode is active when EITHER bound is set — open-ended
	// ranges ("everything before X", "everything since X") are valid.
	const isCustom = Boolean(customRange.from || customRange.to);

	// "Active" = any filter / sort / period away from defaults. The
	// Reset button hides itself when nothing's been touched.
	const hasActiveFilters =
		taskTypes.length > 0 ||
		status !== "all" ||
		providerModelIds.length > 0 ||
		projectIds.length > 0 ||
		memberIds.length > 0 ||
		minCostUsd !== "" ||
		maxCostUsd !== "" ||
		minLatencyMs !== "" ||
		maxLatencyMs !== "" ||
		isCustom ||
		period !== "30d" ||
		sortBy !== "createdAt" ||
		sortOrder !== "desc";

	const resetAllFilters = () => {
		setTaskTypes([]);
		setStatus("all");
		setProviderModelIds([]);
		setProjectIds([]);
		setMemberIds([]);
		setMinCostUsd("");
		setMaxCostUsd("");
		setMinLatencyMs("");
		setMaxLatencyMs("");
		setCustomRange({ from: undefined, to: undefined });
		setCustomFromTime("00:00");
		setCustomToTime("23:59");
		setPeriod("30d");
		setSortBy("createdAt");
		setSortOrder("desc");
	};

	// Build the effective custom range Dates by merging the picked
	// dates with the optional HH:mm inputs. Validates the time string
	// quietly — empty/invalid → defaults (00:00 / 23:59).
	const parseTime = (value: string, fallback: [number, number]) => {
		const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
		if (!m) {
			return fallback;
		}
		const hh = Math.min(23, Math.max(0, Number.parseInt(m[1], 10)));
		const mm = Math.min(59, Math.max(0, Number.parseInt(m[2], 10)));
		return [hh, mm] as [number, number];
	};
	const customFromDate = useMemo(() => {
		if (!customRange.from) {
			return undefined;
		}
		const [h, m] = parseTime(customFromTime, [0, 0]);
		const d = new Date(customRange.from);
		d.setHours(h, m, 0, 0);
		return d;
	}, [customRange.from, customFromTime]);
	const customToDate = useMemo(() => {
		if (!customRange.to) {
			return undefined;
		}
		const [h, m] = parseTime(customToTime, [23, 59]);
		const d = new Date(customRange.to);
		d.setHours(h, m, 59, 999);
		return d;
	}, [customRange.to, customToTime]);

	const dateScope = useMemo<{
		periodDays?: number;
		periodHours?: number;
		from?: Date;
		to?: Date;
	}>(() => {
		// Custom: pass whichever bounds the user set. Backend supports
		// open-ended `from` only or `to` only via Prisma `gte` / `lte`.
		if (isCustom) {
			return {
				...(customFromDate ? { from: customFromDate } : {}),
				...(customToDate ? { to: customToDate } : {}),
			};
		}
		if (periodOption?.periodHours) {
			return { periodHours: periodOption.periodHours };
		}
		return { periodDays: periodOption?.periodDays ?? 30 };
	}, [isCustom, customFromDate, customToDate, periodOption]);

	const minCostMicroUsd = useMemo(() => {
		const n = Number.parseFloat(minCostUsd);
		return Number.isFinite(n) && n > 0
			? Math.round(n * 1_000_000)
			: undefined;
	}, [minCostUsd]);
	const maxCostMicroUsd = useMemo(() => {
		const n = Number.parseFloat(maxCostUsd);
		return Number.isFinite(n) && n > 0
			? Math.round(n * 1_000_000)
			: undefined;
	}, [maxCostUsd]);
	const minLatencyValue = useMemo(() => {
		const n = Number.parseInt(minLatencyMs, 10);
		return Number.isFinite(n) && n >= 0 ? n : undefined;
	}, [minLatencyMs]);
	const maxLatencyValue = useMemo(() => {
		const n = Number.parseInt(maxLatencyMs, 10);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	}, [maxLatencyMs]);

	const queryInput = useMemo(
		() => ({
			organizationId: organizationId ?? null,
			...dateScope,
			// Empty arrays are pruned to `undefined` so the BE schema
			// treats them as "no filter" without us serializing []s on
			// every request.
			taskTypes: taskTypes.length > 0 ? taskTypes : undefined,
			status: status === "all" ? undefined : status,
			providerModelIds:
				providerModelIds.length > 0 ? providerModelIds : undefined,
			projectIds: projectIds.length > 0 ? projectIds : undefined,
			userIds:
				organizationId && memberIds.length > 0 ? memberIds : undefined,
			minCostMicroUsd,
			maxCostMicroUsd,
			minLatencyMs: minLatencyValue,
			maxLatencyMs: maxLatencyValue,
			sortBy,
			sortOrder,
			limit: pageSize,
		}),
		[
			organizationId,
			dateScope,
			taskTypes,
			status,
			providerModelIds,
			projectIds,
			memberIds,
			minCostMicroUsd,
			maxCostMicroUsd,
			minLatencyValue,
			maxLatencyValue,
			sortBy,
			sortOrder,
			pageSize,
		],
	);

	const facetsQuery = useQuery(
		orpc.payments.getAiActivityFacets.queryOptions({
			input: { organizationId: organizationId ?? null, ...dateScope },
			staleTime: 5 * 60_000,
			placeholderData: keepPreviousData,
		}),
	);

	// Filter range expressed as concrete dates — used by the chart as
	// the "fully zoomed out" bounds. The chart owns its own time-series
	// query (so its granularity can adapt to zoom level without making
	// the table re-fetch).
	const filterRange = useMemo<{ from: Date; to: Date }>(() => {
		if (
			"from" in dateScope &&
			"to" in dateScope &&
			dateScope.from &&
			dateScope.to
		) {
			return { from: dateScope.from, to: dateScope.to };
		}
		const to = new Date();
		const from = new Date();
		if ("periodHours" in dateScope && dateScope.periodHours) {
			from.setTime(to.getTime() - dateScope.periodHours * 3_600_000);
		} else if ("periodDays" in dateScope && dateScope.periodDays) {
			from.setDate(to.getDate() - dateScope.periodDays);
		} else {
			from.setDate(to.getDate() - 30);
		}
		return { from, to };
	}, [dateScope]);

	// Filter set without `from/to/periodDays/periodHours` — the chart
	// will provide its own date window (the visible zoom range).
	const chartFilterInput = useMemo(
		() => ({
			organizationId: organizationId ?? null,
			taskTypes: taskTypes.length > 0 ? taskTypes : undefined,
			status: status === "all" ? undefined : status,
			providerModelIds:
				providerModelIds.length > 0 ? providerModelIds : undefined,
			projectIds: projectIds.length > 0 ? projectIds : undefined,
			userIds:
				organizationId && memberIds.length > 0 ? memberIds : undefined,
			minCostMicroUsd,
			maxCostMicroUsd,
			minLatencyMs: minLatencyValue,
			maxLatencyMs: maxLatencyValue,
		}),
		[
			organizationId,
			taskTypes,
			status,
			providerModelIds,
			projectIds,
			memberIds,
			minCostMicroUsd,
			maxCostMicroUsd,
			minLatencyValue,
			maxLatencyValue,
		],
	);

	// Cursor history is the chain of cursors used to reach each visited
	// page; index 0 is `undefined` (page 1). Going next pushes the
	// current page's `nextCursor`, going previous pops. Reset whenever
	// any filter changes.
	const [cursorHistory, setCursorHistory] = useState<
		Array<string | undefined>
	>([undefined]);

	// Stable filter signature so we can reset pagination only when the
	// underlying query changes shape, not on every parent re-render.
	const filterSignature = useMemo(
		() =>
			JSON.stringify({
				organizationId: organizationId ?? null,
				period: isCustom
					? `${customFromDate?.toISOString()}|${customToDate?.toISOString()}`
					: `preset-${period}`,
				// Sort the multi-select arrays so order-only changes don't
				// invalidate pagination (e.g. selecting CHAT then TOOL_CALLING
				// vs the reverse should be the same query).
				taskTypes: [...taskTypes].sort(),
				status,
				providerModelIds: [...providerModelIds].sort(),
				projectIds: [...projectIds]
					.map((p) => (p === null ? "__null__" : p))
					.sort(),
				memberIds: [...memberIds].sort(),
				minCostMicroUsd,
				maxCostMicroUsd,
				minLatencyValue,
				maxLatencyValue,
				sortBy,
				sortOrder,
				pageSize,
			}),
		[
			organizationId,
			period,
			isCustom,
			customFromDate,
			customToDate,
			taskTypes,
			status,
			providerModelIds,
			projectIds,
			memberIds,
			minCostMicroUsd,
			maxCostMicroUsd,
			minLatencyValue,
			maxLatencyValue,
			sortBy,
			sortOrder,
			pageSize,
		],
	);

	useEffect(() => {
		setCursorHistory([undefined]);
	}, [filterSignature]);

	const currentCursor = cursorHistory[cursorHistory.length - 1];
	const pageIndex = cursorHistory.length;

	const activityQuery = useQuery(
		orpc.payments.listAiActivity.queryOptions({
			input: { ...queryInput, cursor: currentCursor },
			staleTime: STALE_TIME,
			placeholderData: keepPreviousData,
		}),
	);

	const rows = (activityQuery.data?.rows ?? []) as ActivityRow[];

	const totals = activityQuery.data?.totals ?? {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costMicroUsd: 0,
		avgLatencyMs: 0,
	};

	const nextCursor = activityQuery.data?.nextCursor ?? null;
	const hasNextPage = Boolean(nextCursor);
	const hasPrevPage = cursorHistory.length > 1;

	const handleNextPage = () => {
		if (nextCursor) {
			setCursorHistory((h) => [...h, nextCursor]);
		}
	};
	const handlePrevPage = () => {
		setCursorHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
	};

	const isLoading = activityQuery.isPending;
	const isEmpty = !isLoading && rows.length === 0;
	const facets = facetsQuery.data;

	// Surface a hard permission error instead of silently rendering an
	// empty page. Org-context procedures throw FORBIDDEN unless the
	// caller is an org owner/admin; previously we caught nothing and
	// the user just saw "0 / 0 / $0.00", which looks like there's no
	// data when in fact there's plenty they're not allowed to see.
	const queryError = activityQuery.error ?? facetsQuery.error;
	const errorMessage =
		queryError && typeof queryError === "object" && queryError !== null
			? // oRPC errors expose a `message` and a `code`
				((queryError as { message?: string }).message ?? "")
			: "";
	const isForbidden =
		queryError &&
		typeof queryError === "object" &&
		queryError !== null &&
		((queryError as { code?: string }).code === "FORBIDDEN" ||
			(queryError as { status?: number }).status === 403 ||
			/forbidden|admin|permission/i.test(errorMessage));

	const periodLabel = isCustom
		? customRange.from && customRange.to
			? `${format(customRange.from, "MMM d")} – ${format(customRange.to, "MMM d, yyyy")}`
			: customRange.from
				? `Since ${format(customRange.from, "MMM d, yyyy")}`
				: customRange.to
					? `Until ${format(customRange.to, "MMM d, yyyy")}`
					: "Custom range"
		: (periodOption?.caption ?? "Last 30 days");

	const scopeCopy = organizationId
		? `All AI activity across ${organizationName ?? "this organization"} members.`
		: "Your personal AI activity (organization workspaces tracked separately).";

	// Recharts limit-line overlay — pick the
	// limits whose `window` matches the selected period AND whose
	// `dimension` matches the chart metric, so the overlay value sits on
	// the same axis scale as the plotted series. Custom date ranges and
	// the 90d preset deliberately render no overlay (no clean window
	// match — `LineChart` would draw a misleading line). For `requests`
	// and `latency` metrics there is no matching limit dimension, so we
	// also render no overlay. Returns chart-axis values:
	// - `tokens` → raw integer (matches `totalTokens` data key).
	// - `cost` → micro-USD ÷ 1_000_000 (matches `costUsd` data key).
	const limitOverlays = useMemo(() => {
		if (isCustom) {
			return [] as Array<ChartLimitOverlay>;
		}
		const matchingWindow: AiUsageLimitDto["window"] | null =
			period === "24h"
				? "HOURLY"
				: period === "7d"
					? "DAILY"
					: period === "30d"
						? "MONTHLY"
						: null; // 90d → no clean match
		if (matchingWindow === null) {
			return [] as Array<ChartLimitOverlay>;
		}
		const matchingDimension: AiUsageLimitDto["dimension"] | null =
			chartMetric === "tokens"
				? "TOKENS"
				: chartMetric === "cost"
					? "SPEND_USD"
					: null;
		if (matchingDimension === null) {
			return [] as Array<ChartLimitOverlay>;
		}
		return activeLimits
			.filter(
				(limit) =>
					limit.window === matchingWindow &&
					limit.dimension === matchingDimension,
			)
			.map((limit) => {
				const rawMax = Number(limit.maxValue);
				const yValue =
					limit.dimension === "SPEND_USD"
						? rawMax / 1_000_000
						: rawMax;
				return {
					id: limit.id,
					yValue,
					enforcement: limit.enforcement,
				} satisfies ChartLimitOverlay;
			});
	}, [activeLimits, chartMetric, isCustom, period]);

	const headerBlock = (
		<header className="space-y-3">
			<div className="flex items-center gap-3">
				<span
					className="block h-3.5 w-0.5 shrink-0 bg-primary"
					aria-hidden="true"
				/>
				<p className="font-sans text-[11px] font-normal uppercase tracking-[0.25em] text-primary">
					AI Usage
				</p>
			</div>
			<h1
				className="text-3xl leading-tight tracking-tight lg:text-4xl"
				style={{
					fontFamily:
						"var(--font-serif, 'EB Garamond', Georgia, serif)",
					fontWeight: 400,
				}}
			>
				Activity history
			</h1>
			<p className="max-w-2xl text-muted-foreground italic">
				Tokens, time, and cost for completed AI activities. Use this to
				monitor usage patterns and reason about cost and efficiency.
			</p>
			<p className="text-xs text-muted-foreground/80">{scopeCopy}</p>
		</header>
	);

	if (isForbidden) {
		return (
			<div className="flex flex-col gap-6">
				{headerBlock}
				<Card className="border-destructive/30 bg-destructive/5">
					<CardContent className="flex flex-col items-start gap-3 p-6">
						<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
							<XIcon className="size-4" />
							You don't have access to this organization's AI
							usage
						</div>
						<p className="max-w-2xl text-sm text-muted-foreground">
							Organization-wide AI activity is restricted to
							owners and admins
							{organizationName ? ` of ${organizationName}` : ""}.
							Ask an admin to grant you the role to see this page.
						</p>
						{errorMessage ? (
							<p className="text-[11px] text-muted-foreground/70">
								Server: {errorMessage}
							</p>
						) : null}
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<TooltipProvider delayDuration={300}>
			<div className="flex flex-col gap-6">
				{headerBlock}

				{/* Usage limits card — sits above the period-selector tablist.
				    Card owns its own Sheet, so no parent-side state lift is
				    required. The forbidden-card branch above returns before
				    reaching this point — org members never see this surface. */}
				<AiUsageLimitsCard
					organizationId={organizationId}
					canManage={canManage}
				/>

				{/* Top row: period presets + custom range */}
				<div className="flex flex-wrap items-center gap-2">
					<div
						role="tablist"
						aria-label="Time period"
						className="inline-flex rounded-md border border-border/60 bg-muted/40 p-0.5"
					>
						{PERIOD_OPTIONS.map((option) => {
							const active = !isCustom && option.value === period;
							return (
								<button
									key={option.value}
									type="button"
									role="tab"
									aria-selected={active}
									onClick={() => {
										setCustomRange({
											from: undefined,
											to: undefined,
										});
										setPeriod(option.value);
									}}
									className={cn(
										"rounded px-3 py-1.5 text-xs font-medium transition-colors",
										active
											? "bg-background text-foreground shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{option.label}
								</button>
							);
						})}
					</div>

					<div className="inline-flex items-center gap-1">
						<Popover
							open={calendarOpen}
							onOpenChange={setCalendarOpen}
						>
							<PopoverTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									className={cn(
										"h-8 gap-2 text-xs",
										isCustom && "border-primary/60",
									)}
								>
									<CalendarIcon className="size-3.5 opacity-70" />
									{customRange.from && customRange.to
										? `${format(customRange.from, "MMM d")} – ${format(customRange.to, "MMM d")}`
										: customRange.from
											? `Since ${format(customRange.from, "MMM d")}`
											: customRange.to
												? `Until ${format(customRange.to, "MMM d")}`
												: "Custom range"}
								</Button>
							</PopoverTrigger>
							<PopoverContent
								className="w-auto p-0"
								align="start"
							>
								<DateRangePopover
									range={customRange}
									setRange={setCustomRange}
									fromTime={customFromTime}
									setFromTime={setCustomFromTime}
									toTime={customToTime}
									setToTime={setCustomToTime}
									onApply={() => setCalendarOpen(false)}
								/>
							</PopoverContent>
						</Popover>
						{isCustom ? (
							<Button
								variant="ghost"
								size="sm"
								className="size-8 p-0 text-muted-foreground hover:text-foreground"
								onClick={() =>
									setCustomRange({
										from: undefined,
										to: undefined,
									})
								}
								aria-label="Clear custom range"
							>
								<XIcon className="size-3.5" />
							</Button>
						) : null}
					</div>

					{/* TZ toggle (Local / UTC) — pushes the period label
					    to the right while staying compact. Persists to
					    localStorage so it follows the user across visits. */}
					<div
						role="tablist"
						aria-label="Timezone"
						className="ml-auto inline-flex rounded-md border border-border/60 bg-muted/40 p-0.5"
					>
						{(
							[
								{ value: "local", label: "Local" },
								{ value: "utc", label: "UTC" },
							] as const
						).map((opt) => {
							const active = tz === opt.value;
							return (
								<button
									key={opt.value}
									type="button"
									role="tab"
									aria-selected={active}
									onClick={() => setTz(opt.value)}
									className={cn(
										"rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
										active
											? "bg-background text-foreground shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{opt.label}
								</button>
							);
						})}
					</div>
					<div className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
						{periodLabel}{" "}
						<span className="font-medium text-primary">
							{tzSuffix(tz)}
						</span>
					</div>
				</div>

				{/* Filter row — every trigger uses the same shared
				    FILTER_TRIGGER_CLASS so Select primitives and
				    popover-Button primitives paint identically in
				    both themes. Layout is a CSS grid with
				    auto-fitting cells so widths even out and the
				    row wraps cleanly without orphan rows. */}
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
							Filters
						</p>
						{hasActiveFilters ? (
							<button
								type="button"
								onClick={resetAllFilters}
								className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
							>
								<XIcon className="size-3" />
								Reset all filters
							</button>
						) : null}
					</div>
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7">
						<TaskTypeFilter
							value={taskTypes}
							onChange={setTaskTypes}
							open={taskTypePickerOpen}
							onOpenChange={setTaskTypePickerOpen}
						/>

						<ModelFilter
							facetsModels={facets?.models ?? []}
							value={providerModelIds}
							onChange={setProviderModelIds}
							open={modelPickerOpen}
							onOpenChange={setModelPickerOpen}
						/>

						<ProjectFilter
							facetsProjects={facets?.projects ?? []}
							value={projectIds}
							onChange={setProjectIds}
							open={projectPickerOpen}
							onOpenChange={setProjectPickerOpen}
						/>

						<RangeFilter
							label="Cost"
							unit="$"
							min={minCostUsd}
							max={maxCostUsd}
							onChange={(min, max) => {
								setMinCostUsd(min);
								setMaxCostUsd(max);
							}}
							icon={
								<DollarSignIcon className="size-3.5 opacity-60" />
							}
							placeholder={{ min: "0.00", max: "10.00" }}
						/>

						<RangeFilter
							label="Latency"
							unit="ms"
							min={minLatencyMs}
							max={maxLatencyMs}
							onChange={(min, max) => {
								setMinLatencyMs(min);
								setMaxLatencyMs(max);
							}}
							icon={<TimerIcon className="size-3.5 opacity-60" />}
							placeholder={{ min: "0", max: "10000" }}
						/>

						{organizationId ? (
							<MemberFilter
								facetsUsers={facets?.users ?? []}
								value={memberIds}
								onChange={setMemberIds}
								open={memberPickerOpen}
								onOpenChange={setMemberPickerOpen}
							/>
						) : null}

						<Select
							value={status}
							onValueChange={(v) => setStatus(v as StatusFilter)}
						>
							<SelectTrigger
								className={FILTER_TRIGGER_CLASS}
								aria-label="Filter by status"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All status</SelectItem>
								<SelectItem value="success">Success</SelectItem>
								<SelectItem value="error">Errors</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>

				<div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
					{/* Click a tile to plot that metric in the chart below.
					    Active tile is highlighted in success green. */}
					<SummaryTile
						label="Requests"
						value={totals.requests.toLocaleString()}
						subtitle={periodLabel}
						onClick={() => setChartMetric("requests")}
						active={chartMetric === "requests"}
						loading={isLoading}
					/>
					<SummaryTile
						label="Total tokens"
						value={formatTokens(totals.totalTokens)}
						subtitle={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
						tooltip="Token counts come straight from each AI provider's response (input + output) and are stored on every completed call."
						onClick={() => setChartMetric("tokens")}
						active={chartMetric === "tokens"}
						loading={isLoading}
					/>
					<SummaryTile
						label="Total cost"
						value={formatUsdFromMicros(totals.costMicroUsd)}
						subtitle="USD"
						tooltip="Per-call cost: (inputTokens × inputCostPer1M + outputTokens × outputCostPer1M) ÷ 1M, summed across the filtered range. Stored at micro-USD precision."
						onClick={() => setChartMetric("cost")}
						active={chartMetric === "cost"}
						loading={isLoading}
					/>
					<SummaryTile
						label="Avg latency"
						value={formatLatency(totals.avgLatencyMs)}
						subtitle="Per request"
						onClick={() => setChartMetric("latency")}
						active={chartMetric === "latency"}
						loading={isLoading}
					/>
				</div>

				<UsageTrendChart
					queryInput={chartFilterInput}
					filterFrom={filterRange.from}
					filterTo={filterRange.to}
					periodLabel={periodLabel}
					metric={chartMetric}
					tz={tz}
					limitOverlays={limitOverlays}
				/>

				<Card>
					<CardHeader className="border-b">
						<div className="flex items-center justify-between gap-3">
							<CardTitle className="text-base font-semibold">
								Activity log
							</CardTitle>
							<div className="flex items-center gap-3">
								<span className="text-xs tabular-nums text-muted-foreground">
									{totals.requests > 0
										? `${(
												(pageIndex - 1) * pageSize + 1
											).toLocaleString()}–${(
												(pageIndex - 1) * pageSize +
													rows.length
											).toLocaleString()} of ${totals.requests.toLocaleString()}`
										: "—"}
								</span>
								<Button
									variant="outline"
									size="sm"
									className="h-8 gap-1.5 text-xs"
									onClick={() =>
										exportCsv(
											queryInput,
											organizationId,
											tz,
										)
									}
									disabled={totals.requests === 0}
									aria-label="Export current view as CSV"
								>
									<DownloadIcon className="size-3.5" />
									Export CSV
								</Button>
							</div>
						</div>
					</CardHeader>
					<CardContent className="p-0">
						{/* Use a raw table so the scroll container is THIS div
						    and `position: sticky` on <thead> binds correctly.
						    The shared <Table> primitive wraps in its own
						    overflow:auto div which would steal the sticky
						    context. */}
						<div className="max-h-[60vh] overflow-y-auto">
							<table className="w-full caption-bottom text-sm">
								<thead className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_0_var(--border)]">
									<TableRow>
										<TableHead className="pl-6">
											<SortHeader
												label="When"
												field="createdAt"
												sortBy={sortBy}
												sortOrder={sortOrder}
												onSort={(f, o) => {
													setSortBy(f);
													setSortOrder(o);
												}}
											/>
										</TableHead>
										<TableHead>Activity</TableHead>
										{organizationId ? (
											<TableHead>Member</TableHead>
										) : null}
										<TableHead>Model</TableHead>
										<TableHead className="text-right">
											<SortHeader
												label="Tokens (in / out)"
												field="totalTokens"
												align="right"
												sortBy={sortBy}
												sortOrder={sortOrder}
												onSort={(f, o) => {
													setSortBy(f);
													setSortOrder(o);
												}}
											/>
										</TableHead>
										<TableHead className="text-right">
											<SortHeader
												label="Latency"
												field="latencyMs"
												align="right"
												sortBy={sortBy}
												sortOrder={sortOrder}
												onSort={(f, o) => {
													setSortBy(f);
													setSortOrder(o);
												}}
											/>
										</TableHead>
										<TableHead className="text-right">
											<SortHeader
												label="Cost"
												field="costMicroUsd"
												align="right"
												sortBy={sortBy}
												sortOrder={sortOrder}
												onSort={(f, o) => {
													setSortBy(f);
													setSortOrder(o);
												}}
											/>
										</TableHead>
										<TableHead className="pr-6 text-right">
											Status
										</TableHead>
									</TableRow>
								</thead>
								<TableBody>
									{isLoading ? (
										<TableRow>
											<TableCell
												colSpan={organizationId ? 8 : 7}
												className="h-24 text-center text-sm text-muted-foreground"
											>
												<Loader2Icon className="mx-auto size-4 animate-spin" />
											</TableCell>
										</TableRow>
									) : isEmpty ? (
										<TableRow>
											<TableCell
												colSpan={organizationId ? 8 : 7}
												className="h-32 text-center text-sm text-muted-foreground"
											>
												No AI activity for this filter —
												try widening the period or
												clearing filters.
											</TableCell>
										</TableRow>
									) : (
										rows.map((row) => {
											const createdAt = new Date(
												row.createdAt,
											);
											return (
												<TableRow
													key={row.id}
													className="cursor-pointer"
													onClick={() =>
														setSelectedRow(row)
													}
												>
													<TableCell
														className="whitespace-nowrap pl-6 text-sm"
														title={`${formatTz(createdAt, "PPpp", tz)} ${tzSuffix(tz)}`}
													>
														<div className="font-medium">
															{formatDistanceToNow(
																createdAt,
																{
																	addSuffix: true,
																},
															)}
														</div>
														<div className="text-xs tabular-nums text-muted-foreground">
															{formatTz(
																createdAt,
																"MMM d, HH:mm",
																tz,
															)}
														</div>
													</TableCell>
													<TableCell className="text-sm">
														<div className="font-medium">
															{formatTaskType(
																row.taskType,
															)}
														</div>
														{row.jobType ? (
															<div className="text-xs break-words text-muted-foreground">
																{row.jobType}
															</div>
														) : null}
														{row.projectName ? (
															<div className="text-xs text-muted-foreground">
																{
																	row.projectName
																}
															</div>
														) : null}
													</TableCell>
													{organizationId ? (
														<TableCell className="text-sm">
															<div className="font-medium">
																{row.userName ??
																	row.userEmail ??
																	"—"}
															</div>
															{row.userName &&
															row.userEmail ? (
																<div className="text-xs text-muted-foreground">
																	{
																		row.userEmail
																	}
																</div>
															) : null}
														</TableCell>
													) : null}
													<TableCell className="text-sm">
														<div className="font-medium">
															{formatModel(
																row.modelCanonicalName ??
																	row.providerModelId,
															)}
														</div>
														<div className="text-xs text-muted-foreground">
															{row.provider}
														</div>
													</TableCell>
													<TableCell className="whitespace-nowrap text-right text-sm tabular-nums">
														<div className="font-medium">
															{formatTokens(
																row.totalTokens,
															)}
														</div>
														<div className="text-xs text-muted-foreground">
															{/* Neither figure is focusable, so the
																portalled tooltips are pointer-only.
																`aria-label` would replace the visible
																count in the accessible name; an
																`sr-only` child adds the explanation
																alongside it. */}
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<span>
																		{formatTokens(
																			row.inputTokens,
																		)}{" "}
																		in
																		<span className="sr-only">
																			{tTooltips(
																				"inputTokens",
																			)}
																		</span>
																	</span>
																</TooltipTrigger>
																<TooltipContent>
																	{tTooltips(
																		"inputTokens",
																	)}
																</TooltipContent>
															</Tooltip>{" "}
															<span className="opacity-50">
																·
															</span>{" "}
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<span>
																		{formatTokens(
																			row.outputTokens,
																		)}{" "}
																		out
																		<span className="sr-only">
																			{tTooltips(
																				"outputTokens",
																			)}
																		</span>
																	</span>
																</TooltipTrigger>
																<TooltipContent>
																	{tTooltips(
																		"outputTokens",
																	)}
																</TooltipContent>
															</Tooltip>
														</div>
													</TableCell>
													<TableCell className="whitespace-nowrap text-right text-sm tabular-nums">
														{formatLatency(
															row.latencyMs,
														)}
													</TableCell>
													<TableCell className="whitespace-nowrap text-right text-sm tabular-nums">
														{formatUsdFromMicros(
															row.costMicroUsd,
														)}
													</TableCell>
													<TableCell className="pr-6 text-right">
														<Badge
															variant={
																row.success
																	? "secondary"
																	: "destructive"
															}
															className="font-normal"
														>
															{row.success
																? "Success"
																: "Error"}
														</Badge>
													</TableCell>
												</TableRow>
											);
										})
									)}
								</TableBody>
							</table>
						</div>
						<div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-6 py-3 text-xs text-muted-foreground">
							<div className="flex flex-wrap items-center gap-3 tabular-nums">
								<span>
									{isEmpty ? (
										"No matching activity"
									) : (
										<>
											Page{" "}
											<span className="font-medium text-foreground">
												{pageIndex}
											</span>
											{totals.requests > 0 ? (
												<>
													{" "}
													of{" "}
													<span className="font-medium text-foreground">
														{Math.max(
															1,
															Math.ceil(
																totals.requests /
																	pageSize,
															),
														).toLocaleString()}
													</span>
												</>
											) : null}
										</>
									)}
									{activityQuery.isFetching ? (
										<Loader2Icon className="ml-2 inline size-3 animate-spin opacity-60" />
									) : null}
								</span>
								<span className="flex items-center gap-1.5">
									<span className="text-muted-foreground/70">
										Rows
									</span>
									<Select
										value={String(pageSize)}
										onValueChange={(v) =>
											setPageSize(
												Number.parseInt(
													v,
													10,
												) as PageSize,
											)
										}
									>
										<SelectTrigger
											className="h-7 w-[4.5rem] text-xs"
											aria-label="Rows per page"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{PAGE_SIZE_OPTIONS.map((n) => (
												<SelectItem
													key={n}
													value={String(n)}
												>
													{n}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</span>
							</div>
							<div className="flex items-center gap-1.5">
								<Button
									variant="outline"
									size="sm"
									className="h-8 gap-1 text-xs"
									onClick={handlePrevPage}
									disabled={!hasPrevPage}
									aria-label="Previous page"
								>
									<ChevronLeftIcon className="size-3.5" />
									Prev
								</Button>
								<Button
									variant="outline"
									size="sm"
									className="h-8 gap-1 text-xs"
									onClick={handleNextPage}
									disabled={!hasNextPage}
									aria-label="Next page"
								>
									Next
									<ChevronRightIcon className="size-3.5" />
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>

				<Sheet
					open={selectedRow !== null}
					onOpenChange={(open) => {
						if (!open) {
							setSelectedRow(null);
						}
					}}
				>
					<SheetContent side="right" className="sm:max-w-md">
						{selectedRow ? (
							<>
								<SheetHeader>
									<SheetTitle>
										{formatTaskType(selectedRow.taskType)}{" "}
										activity
									</SheetTitle>
									<SheetDescription>
										{formatTz(
											selectedRow.createdAt,
											"PPpp",
											tz,
										)}{" "}
										{tzSuffix(tz)}
									</SheetDescription>
								</SheetHeader>
								<dl className="mt-6 space-y-4 px-4 text-sm">
									<DetailRow
										label="Status"
										value={
											<Badge
												variant={
													selectedRow.success
														? "secondary"
														: "destructive"
												}
												className="font-normal"
											>
												{selectedRow.success
													? "Success"
													: "Error"}
											</Badge>
										}
									/>
									<DetailRow
										label="Provider"
										value={selectedRow.provider}
									/>
									<DetailRow
										label="Model"
										value={formatModel(
											selectedRow.modelCanonicalName ??
												selectedRow.providerModelId,
										)}
									/>
									<DetailRow
										label="Project"
										value={selectedRow.projectName ?? "—"}
									/>
									{selectedRow.jobType ? (
										<DetailRow
											label="Job"
											value={selectedRow.jobType}
										/>
									) : null}
									{organizationId ? (
										<DetailRow
											label="Member"
											value={
												selectedRow.userName ??
												selectedRow.userEmail ??
												"—"
											}
										/>
									) : null}
									<DetailRow
										label="Input tokens"
										value={formatTokens(
											selectedRow.inputTokens,
										)}
									/>
									<DetailRow
										label="Output tokens"
										value={formatTokens(
											selectedRow.outputTokens,
										)}
									/>
									<DetailRow
										label="Total tokens"
										value={formatTokens(
											selectedRow.totalTokens,
										)}
									/>
									<DetailRow
										label="Latency"
										value={formatLatency(
											selectedRow.latencyMs,
										)}
									/>
									<DetailRow
										label="Cost"
										value={formatUsdFromMicros(
											selectedRow.costMicroUsd,
										)}
									/>
									<DetailRow
										label="Request ID"
										value={
											<code className="select-all font-mono text-xs">
												{selectedRow.id}
											</code>
										}
									/>
									{selectedRow.errorMessage ? (
										<div>
											<dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
												Error message
											</dt>
											<dd className="mt-1 whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
												{selectedRow.errorMessage}
											</dd>
										</div>
									) : null}
								</dl>
							</>
						) : null}
					</SheetContent>
				</Sheet>
			</div>
		</TooltipProvider>
	);
}

function DetailRow({
	label,
	value,
}: {
	label: string;
	value: React.ReactNode;
}) {
	return (
		<div className="flex items-start justify-between gap-4">
			<dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
				{label}
			</dt>
			<dd className="text-right tabular-nums">{value}</dd>
		</div>
	);
}

function SortHeader({
	label,
	field,
	sortBy,
	sortOrder,
	onSort,
	align = "left",
}: {
	label: string;
	field: SortBy;
	sortBy: SortBy;
	sortOrder: SortOrder;
	onSort: (field: SortBy, order: SortOrder) => void;
	align?: "left" | "right";
}) {
	const active = sortBy === field;
	const Icon = !active
		? ArrowUpDownIcon
		: sortOrder === "asc"
			? ArrowUpIcon
			: ArrowDownIcon;
	return (
		<button
			type="button"
			onClick={() => {
				if (active) {
					onSort(field, sortOrder === "asc" ? "desc" : "asc");
				} else {
					// Default to descending — most useful for "biggest first"
					// reads on cost/tokens/latency.
					onSort(field, "desc");
				}
			}}
			className={cn(
				"inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:text-foreground",
				align === "right" && "ml-auto",
			)}
			aria-label={`Sort by ${label}`}
		>
			{label}
			<Icon
				className={cn("size-3", active ? "opacity-100" : "opacity-40")}
			/>
		</button>
	);
}

function RangeFilter({
	label,
	unit,
	icon,
	min,
	max,
	onChange,
	placeholder,
}: {
	label: string;
	unit: string;
	icon?: React.ReactNode;
	min: string;
	max: string;
	onChange: (min: string, max: string) => void;
	placeholder?: { min?: string; max?: string };
}) {
	const [open, setOpen] = useState(false);
	const [draftMin, setDraftMin] = useState(min);
	const [draftMax, setDraftMax] = useState(max);

	useEffect(() => {
		if (open) {
			setDraftMin(min);
			setDraftMax(max);
		}
	}, [open, min, max]);

	const active = Boolean(min || max);
	const summary = active
		? `${min ? `${min}${unit}` : "0"}–${max ? `${max}${unit}` : "∞"}`
		: label;

	return (
		<div className="inline-flex items-center gap-1">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className={cn(
							FILTER_TRIGGER_CLASS,
							active && "border-primary/60",
						)}
						aria-label={`${label} range filter`}
					>
						<span className="flex items-center gap-1.5 truncate">
							{icon}
							<span className="truncate">{summary}</span>
						</span>
						<ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					className="w-[16rem] space-y-3 p-3"
					align="start"
				>
					<p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
						{label} range ({unit})
					</p>
					<div className="grid grid-cols-2 gap-2">
						<div className="space-y-1">
							<Label
								htmlFor={`range-${label}-min`}
								className="text-[10px] uppercase tracking-wider text-muted-foreground"
							>
								Min
							</Label>
							<Input
								id={`range-${label}-min`}
								type="number"
								inputMode="decimal"
								className="h-8 text-xs"
								placeholder={placeholder?.min}
								value={draftMin}
								onChange={(e) =>
									setDraftMin(e.currentTarget.value)
								}
							/>
						</div>
						<div className="space-y-1">
							<Label
								htmlFor={`range-${label}-max`}
								className="text-[10px] uppercase tracking-wider text-muted-foreground"
							>
								Max
							</Label>
							<Input
								id={`range-${label}-max`}
								type="number"
								inputMode="decimal"
								className="h-8 text-xs"
								placeholder={placeholder?.max}
								value={draftMax}
								onChange={(e) =>
									setDraftMax(e.currentTarget.value)
								}
							/>
						</div>
					</div>
					<div className="flex justify-between gap-2">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 text-xs"
							onClick={() => {
								setDraftMin("");
								setDraftMax("");
								onChange("", "");
								setOpen(false);
							}}
						>
							Clear
						</Button>
						<Button
							size="sm"
							className="h-7 text-xs"
							onClick={() => {
								onChange(draftMin, draftMax);
								setOpen(false);
							}}
						>
							Apply
						</Button>
					</div>
				</PopoverContent>
			</Popover>
			{active ? (
				<Button
					variant="ghost"
					size="sm"
					className="size-8 p-0 text-muted-foreground hover:text-foreground"
					onClick={() => onChange("", "")}
					aria-label={`Clear ${label} filter`}
				>
					<XIcon className="size-3.5" />
				</Button>
			) : null}
		</div>
	);
}

// Compact hour + minute selectors — replaces the browser's native
// `<input type="time">` (whose chrome looks awful in dark mode and
// varies per browser). Two cmdk-backed Selects keep the calendar
// popover visually consistent with the rest of the app.
// 12-hour AM/PM time picker. Stores 24h "HH:mm" internally so the
// data round-trips with backend / URL state, but presents 1–12 +
// AM/PM to the user. Three compact Selects keep the popover visually
// consistent with the rest of the design system instead of the
// browser's native <input type="time"> chrome.
function TimePicker({
	value,
	onChange,
	ariaLabel,
}: {
	value: string;
	onChange: (next: string) => void;
	ariaLabel: string;
}) {
	const [hPart = "0", mPart = "0"] = value.split(":");
	const hour24 = Math.min(23, Math.max(0, Number.parseInt(hPart, 10) || 0));
	const minute = Math.min(59, Math.max(0, Number.parseInt(mPart, 10) || 0));
	const period: "AM" | "PM" = hour24 >= 12 ? "PM" : "AM";
	const hour12 = ((hour24 + 11) % 12) + 1; // 0→12, 13→1, etc.

	const set = (h12: number, m: number, p: "AM" | "PM") => {
		const h24 = p === "AM" ? h12 % 12 : (h12 % 12) + 12;
		onChange(
			`${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
		);
	};

	return (
		<div
			className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card px-1 py-0.5"
			aria-label={ariaLabel}
		>
			<Select
				value={String(hour12)}
				onValueChange={(v) =>
					set(Number.parseInt(v, 10), minute, period)
				}
			>
				<SelectTrigger className="h-7 w-[2.75rem] border-0 bg-transparent px-1.5 py-0 text-xs tabular-nums hover:bg-muted/50 focus:ring-0 focus-visible:ring-0">
					<SelectValue />
				</SelectTrigger>
				<SelectContent className="max-h-[14rem]">
					{Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
						<SelectItem key={h} value={String(h)}>
							{String(h).padStart(2, "0")}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<span className="text-muted-foreground">:</span>
			<Select
				value={String(minute)}
				onValueChange={(v) =>
					set(hour12, Number.parseInt(v, 10), period)
				}
			>
				<SelectTrigger className="h-7 w-[2.75rem] border-0 bg-transparent px-1.5 py-0 text-xs tabular-nums hover:bg-muted/50 focus:ring-0 focus-visible:ring-0">
					<SelectValue />
				</SelectTrigger>
				<SelectContent className="max-h-[14rem]">
					{Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
						<SelectItem key={m} value={String(m)}>
							{String(m).padStart(2, "0")}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select
				value={period}
				onValueChange={(v) => set(hour12, minute, v as "AM" | "PM")}
			>
				<SelectTrigger className="h-7 w-[2.75rem] border-0 bg-transparent px-1.5 py-0 text-xs hover:bg-muted/50 focus:ring-0 focus-visible:ring-0">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="AM">AM</SelectItem>
					<SelectItem value="PM">PM</SelectItem>
				</SelectContent>
			</Select>
		</div>
	);
}

// Modern date-range popover: preset sidebar + two-month calendar +
// From/To time row + Apply. Mirrors the pattern Linear, Datadog,
// Stripe etc. use for date-range selection.
// Two-column "Start date | End date" picker. Each column lets the
// user choose Year, Month, Day, Hour, Minute, AM/PM independently
// — fully explicit, no calendar nav required. A custom day grid
// keeps the spatial sense of a calendar without depending on
// react-day-picker (which kept fighting us).
const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const WEEKDAY_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function DateRangePopover({
	range,
	setRange,
	fromTime,
	setFromTime,
	toTime,
	setToTime,
	onApply,
}: {
	range: { from: Date | undefined; to: Date | undefined };
	setRange: (r: { from: Date | undefined; to: Date | undefined }) => void;
	fromTime: string;
	setFromTime: (s: string) => void;
	toTime: string;
	setToTime: (s: string) => void;
	onApply: () => void;
}) {
	const today = new Date();

	const handleStartChange = (next: Date) => {
		setRange({
			from: next,
			// Push end forward only if it's currently set and now lower
			// than the new start.
			to:
				range.to && range.to.getTime() < next.getTime()
					? next
					: range.to,
		});
		setFromTime(formatHHmm(next));
	};
	const handleEndChange = (next: Date) => {
		setRange({
			from:
				range.from && range.from.getTime() > next.getTime()
					? next
					: range.from,
			to: next,
		});
		setToTime(formatHHmm(next));
	};

	const startValue = range.from
		? mergeDateAndTime(range.from, fromTime)
		: undefined;
	const endValue = range.to ? mergeDateAndTime(range.to, toTime) : undefined;

	const summary = (() => {
		if (range.from && range.to) {
			return `${format(mergeDateAndTime(range.from, fromTime), "PPp")} → ${format(mergeDateAndTime(range.to, toTime), "PPp")}`;
		}
		if (range.from) {
			return `Since ${format(mergeDateAndTime(range.from, fromTime), "PPp")} (no end limit)`;
		}
		if (range.to) {
			return `Until ${format(mergeDateAndTime(range.to, toTime), "PPp")} (no start limit)`;
		}
		return "Set a start, an end, or both. Leave one empty for an open-ended range.";
	})();

	return (
		<div className="w-[42rem] max-w-[95vw]">
			<div className="grid grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
				<DateTimePanel
					label="Start date"
					value={startValue}
					onChange={handleStartChange}
					onClear={() => {
						setRange({ from: undefined, to: range.to });
						setFromTime("00:00");
					}}
					placeholderHint="Leave empty for everything before the end date."
					initial={combine(startOfDay(today), 0, 0)}
					max={range.to ?? today}
				/>
				<DateTimePanel
					label="End date"
					value={endValue}
					onChange={handleEndChange}
					onClear={() => {
						setRange({ from: range.from, to: undefined });
						setToTime("23:59");
					}}
					placeholderHint="Leave empty for everything since the start date."
					initial={combine(endOfDay(today), 23, 59)}
					min={range.from}
					max={today}
				/>
			</div>
			<div className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-4 py-2.5">
				<div className="text-[11px] tabular-nums text-muted-foreground">
					{summary}
				</div>
				<Button
					size="sm"
					className="h-8 text-xs"
					// Apply enabled if at least one bound is set —
					// open-ended ranges are valid.
					disabled={!range.from && !range.to}
					onClick={onApply}
				>
					Apply range
				</Button>
			</div>
		</div>
	);
}

function DateTimePanel({
	label,
	value,
	onChange,
	onClear,
	placeholderHint,
	initial,
	min,
	max,
}: {
	label: string;
	// `undefined` means the user hasn't set this side yet — open-ended.
	value: Date | undefined;
	onChange: (next: Date) => void;
	onClear: () => void;
	placeholderHint: string;
	initial: Date;
	min?: Date;
	max?: Date;
}) {
	const today = new Date();

	if (!value) {
		return (
			<div className="flex flex-col gap-3 p-4">
				<p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
					{label}
				</p>
				<div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-muted/20 p-4">
					<p className="text-xs text-muted-foreground">
						{placeholderHint}
					</p>
					<Button
						variant="outline"
						size="sm"
						className="h-8 self-start text-xs"
						onClick={() => onChange(clamp(initial, min, max))}
					>
						Set {label.toLowerCase()}
					</Button>
				</div>
			</div>
		);
	}

	const minYear = today.getFullYear() - 5;
	const maxYear = today.getFullYear();
	const years = Array.from(
		{ length: maxYear - minYear + 1 },
		(_, i) => minYear + i,
	).reverse();

	const year = value.getFullYear();
	const month = value.getMonth();
	const day = value.getDate();

	const setYear = (y: number) => {
		const next = new Date(value);
		next.setFullYear(y);
		const dim = daysInMonth(y, next.getMonth());
		if (next.getDate() > dim) {
			next.setDate(dim);
		}
		onChange(clamp(next, min, max));
	};
	const setMonth = (m: number) => {
		const next = new Date(value);
		next.setMonth(m);
		const dim = daysInMonth(next.getFullYear(), m);
		if (next.getDate() > dim) {
			next.setDate(dim);
		}
		onChange(clamp(next, min, max));
	};
	const setDay = (d: number) => {
		const next = new Date(value);
		next.setDate(d);
		onChange(clamp(next, min, max));
	};
	const setTime = (hhmm: string) => {
		const [h = "0", m = "0"] = hhmm.split(":");
		const next = new Date(value);
		next.setHours(
			Number.parseInt(h, 10) || 0,
			Number.parseInt(m, 10) || 0,
			0,
			0,
		);
		onChange(clamp(next, min, max));
	};

	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center justify-between">
				<p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
					{label}
				</p>
				<button
					type="button"
					onClick={onClear}
					className="text-[11px] text-muted-foreground hover:text-foreground"
				>
					Clear
				</button>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<Select
					value={String(year)}
					onValueChange={(v) => setYear(Number.parseInt(v, 10))}
				>
					<SelectTrigger
						className={FILTER_TRIGGER_CLASS}
						aria-label={`${label} year`}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent className="max-h-[14rem]">
						{years.map((y) => (
							<SelectItem key={y} value={String(y)}>
								{y}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={String(month)}
					onValueChange={(v) => setMonth(Number.parseInt(v, 10))}
				>
					<SelectTrigger
						className={FILTER_TRIGGER_CLASS}
						aria-label={`${label} month`}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent className="max-h-[14rem]">
						{MONTH_NAMES.map((m, i) => {
							const monthStart = new Date(year, i, 1);
							const monthEnd = new Date(year, i + 1, 0);
							const disabled =
								(min && monthEnd < startOfDay(min)) ||
								(max && monthStart > endOfDay(max));
							return (
								<SelectItem
									key={m}
									value={String(i)}
									disabled={Boolean(disabled)}
								>
									{m}
								</SelectItem>
							);
						})}
					</SelectContent>
				</Select>
			</div>
			<DayGrid
				year={year}
				month={month}
				selectedDay={day}
				onSelectDay={setDay}
				min={min}
				max={max}
			/>
			<div className="flex items-center justify-between gap-2 pt-1">
				<span className="text-[10px] uppercase tracking-wider text-muted-foreground">
					Time
				</span>
				<TimePicker
					value={formatHHmm(value)}
					onChange={setTime}
					ariaLabel={`${label} time`}
				/>
			</div>
		</div>
	);
}

function DayGrid({
	year,
	month,
	selectedDay,
	onSelectDay,
	min,
	max,
}: {
	year: number;
	month: number;
	selectedDay: number;
	onSelectDay: (d: number) => void;
	min?: Date;
	max?: Date;
}) {
	const firstWeekday = new Date(year, month, 1).getDay();
	const dim = daysInMonth(year, month);
	const today = new Date();
	const todayIsCurrentMonth =
		today.getFullYear() === year && today.getMonth() === month;

	const cells: Array<number | null> = [];
	for (let i = 0; i < firstWeekday; i++) {
		cells.push(null);
	}
	for (let d = 1; d <= dim; d++) {
		cells.push(d);
	}

	const isDisabled = (d: number) => {
		const candidate = new Date(year, month, d);
		if (min && candidate < startOfDay(min)) {
			return true;
		}
		if (max && candidate > endOfDay(max)) {
			return true;
		}
		return false;
	};

	return (
		<div className="space-y-1">
			<div className="grid grid-cols-7 gap-0.5 text-center">
				{WEEKDAY_NAMES.map((w) => (
					<div
						key={w}
						className="py-1 text-[10px] font-medium text-muted-foreground/70"
					>
						{w}
					</div>
				))}
			</div>
			<div className="grid grid-cols-7 gap-0.5">
				{cells.map((d, i) => {
					if (d === null) {
						// eslint-disable-next-line react/no-array-index-key
						return <div key={`pad-${month}-${i}`} />;
					}
					const disabled = isDisabled(d);
					const selected = d === selectedDay;
					const isToday =
						todayIsCurrentMonth && d === today.getDate();
					return (
						<button
							key={d}
							type="button"
							disabled={disabled}
							onClick={() => onSelectDay(d)}
							className={cn(
								"h-8 w-full rounded-md text-xs tabular-nums transition-colors",
								selected
									? "bg-primary text-primary-foreground"
									: disabled
										? "cursor-not-allowed text-muted-foreground/30"
										: "hover:bg-muted",
								!selected &&
									isToday &&
									"ring-1 ring-primary/40",
							)}
						>
							{d}
						</button>
					);
				})}
			</div>
		</div>
	);
}

function daysInMonth(year: number, month: number): number {
	return new Date(year, month + 1, 0).getDate();
}

function combine(d: Date, h: number, m: number): Date {
	const out = new Date(d);
	out.setHours(h, m, 0, 0);
	return out;
}

function mergeDateAndTime(d: Date, hhmm: string): Date {
	const [h = "0", m = "0"] = hhmm.split(":");
	return combine(d, Number.parseInt(h, 10) || 0, Number.parseInt(m, 10) || 0);
}

function clamp(d: Date, min?: Date, max?: Date): Date {
	if (min && d < min) {
		return new Date(min);
	}
	if (max && d > max) {
		return new Date(max);
	}
	return d;
}

function startOfDay(d: Date): Date {
	const out = new Date(d);
	out.setHours(0, 0, 0, 0);
	return out;
}

function endOfDay(d: Date): Date {
	const out = new Date(d);
	out.setHours(23, 59, 59, 999);
	return out;
}

function formatHHmm(d: Date): string {
	return `${String(d.getHours()).padStart(2, "0")}:${String(
		d.getMinutes(),
	).padStart(2, "0")}`;
}

type FacetUser = {
	id: string;
	name: string | null;
	email: string | null;
	requests: number;
	removed: boolean;
};

/**
 * Render the trigger label for a multi-select filter:
 * - "All <items>" when nothing is selected
 * - the single item name when exactly one is selected
 * - "{N} selected" when more than one is selected
 */
function multiSelectLabel<T>(
	value: T[],
	allLabel: string,
	getName: (item: T) => string,
): string {
	if (value.length === 0) {
		return allLabel;
	}
	if (value.length === 1) {
		const name = getName(value[0]!);
		return name || allLabel;
	}
	return `${value.length} selected`;
}

/**
 * Toggle membership of `item` in `value` and call `onChange` with the
 * updated array. Equality is by reference (or primitive value) — this is
 * fine for strings, nulls, and our typed task-type unions.
 */
function toggleMembership<T>(
	value: T[],
	item: T,
	onChange: (next: T[]) => void,
): void {
	const next = value.includes(item)
		? value.filter((v) => v !== item)
		: [...value, item];
	onChange(next);
}

function TaskTypeFilter({
	value,
	onChange,
	open,
	onOpenChange,
}: {
	value: TaskType[];
	onChange: (next: TaskType[]) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const triggerLabel = multiSelectLabel(
		value,
		"All activity",
		(v) => TASK_TYPE_LABELS[v] ?? v,
	);

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className={FILTER_TRIGGER_CLASS}
					aria-label="Filter by activity type"
				>
					<span className="truncate">{triggerLabel}</span>
					<ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[16rem] p-0" align="start">
				<Command>
					<CommandInput
						placeholder="Search activity..."
						className="h-9"
					/>
					<CommandList>
						<CommandEmpty>No activity types.</CommandEmpty>
						<CommandGroup>
							{TASK_TYPE_OPTIONS.map((option) => {
								const selected = value.includes(option.value);
								return (
									<CommandItem
										key={option.value}
										value={option.label}
										onSelect={() => {
											toggleMembership(
												value,
												option.value,
												onChange,
											);
										}}
									>
										<CheckIcon
											className={cn(
												"mr-2 size-3.5",
												selected
													? "opacity-100"
													: "opacity-0",
											)}
										/>
										<span className="truncate text-sm">
											{option.label}
										</span>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
					{value.length > 0 ? (
						<MultiSelectClearFooter
							onClear={() => onChange([])}
							count={value.length}
						/>
					) : null}
				</Command>
			</PopoverContent>
		</Popover>
	);
}

type FacetModel = {
	providerModelId: string;
	modelCanonicalName: string | null;
	provider: string;
	requests: number;
};

function ModelFilter({
	facetsModels,
	value,
	onChange,
	open,
	onOpenChange,
}: {
	facetsModels: FacetModel[];
	value: string[];
	onChange: (next: string[]) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const labelByValue = useMemo(() => {
		const map = new Map<string, string>();
		for (const m of facetsModels) {
			map.set(
				m.providerModelId,
				formatModel(m.modelCanonicalName ?? m.providerModelId),
			);
		}
		return map;
	}, [facetsModels]);

	const triggerLabel = multiSelectLabel(
		value,
		"All models",
		(v) => labelByValue.get(v) ?? formatModel(v),
	);

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className={FILTER_TRIGGER_CLASS}
					aria-label="Filter by model"
				>
					<span className="truncate">{triggerLabel}</span>
					<ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[20rem] p-0" align="start">
				<Command>
					<CommandInput
						placeholder="Search models..."
						className="h-9"
					/>
					<CommandList className="max-h-[24rem]">
						<CommandEmpty>No models.</CommandEmpty>
						<CommandGroup>
							{facetsModels.map((m) => {
								const selected = value.includes(
									m.providerModelId,
								);
								const label = formatModel(
									m.modelCanonicalName ?? m.providerModelId,
								);
								return (
									<CommandItem
										key={m.providerModelId}
										value={`${label} ${m.providerModelId}`}
										onSelect={() => {
											toggleMembership(
												value,
												m.providerModelId,
												onChange,
											);
										}}
									>
										<CheckIcon
											className={cn(
												"mr-2 size-3.5",
												selected
													? "opacity-100"
													: "opacity-0",
											)}
										/>
										<div className="flex min-w-0 flex-1 items-center justify-between gap-2">
											<span className="truncate text-sm">
												{label}
											</span>
											<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
												{m.requests}
											</span>
										</div>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
					{value.length > 0 ? (
						<MultiSelectClearFooter
							onClear={() => onChange([])}
							count={value.length}
						/>
					) : null}
				</Command>
			</PopoverContent>
		</Popover>
	);
}

type FacetProject = { id: string; name: string };

// Special sentinel used inside the project Command list to identify the
// "No project" row (which maps to a literal `null` in the projectIds
// array sent to the BE). Outside the picker we just store `null`.
const NO_PROJECT_SENTINEL = "__no_project__";

function ProjectFilter({
	facetsProjects,
	value,
	onChange,
	open,
	onOpenChange,
}: {
	facetsProjects: FacetProject[];
	value: ProjectIdSelection[];
	onChange: (next: ProjectIdSelection[]) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const projectsById = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of facetsProjects) {
			map.set(p.id, p.name);
		}
		return map;
	}, [facetsProjects]);

	const triggerLabel = multiSelectLabel(value, "All projects", (v) =>
		v === null ? "No project" : (projectsById.get(v) ?? "Project"),
	);

	const togglePick = (pick: ProjectIdSelection) => {
		toggleMembership(value, pick, onChange);
	};

	const noProjectSelected = value.includes(null);

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className={FILTER_TRIGGER_CLASS}
					aria-label="Filter by project"
				>
					<span className="truncate">{triggerLabel}</span>
					<ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[18rem] p-0" align="start">
				<Command>
					<CommandInput
						placeholder="Search projects..."
						className="h-9"
					/>
					<CommandList className="max-h-[24rem]">
						<CommandEmpty>No projects.</CommandEmpty>
						<CommandGroup>
							<CommandItem
								value={NO_PROJECT_SENTINEL}
								onSelect={() => togglePick(null)}
							>
								<CheckIcon
									className={cn(
										"mr-2 size-3.5",
										noProjectSelected
											? "opacity-100"
											: "opacity-0",
									)}
								/>
								<span className="truncate text-sm italic text-muted-foreground">
									No project
								</span>
							</CommandItem>
							{facetsProjects.map((p) => {
								const selected = value.includes(p.id);
								return (
									<CommandItem
										key={p.id}
										value={`${p.name} ${p.id}`}
										onSelect={() => togglePick(p.id)}
									>
										<CheckIcon
											className={cn(
												"mr-2 size-3.5",
												selected
													? "opacity-100"
													: "opacity-0",
											)}
										/>
										<span className="truncate text-sm">
											{p.name}
										</span>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
					{value.length > 0 ? (
						<MultiSelectClearFooter
							onClear={() => onChange([])}
							count={value.length}
						/>
					) : null}
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function MemberFilter({
	facetsUsers,
	value,
	onChange,
	open,
	onOpenChange,
}: {
	facetsUsers: FacetUser[];
	value: string[];
	onChange: (next: string[]) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const labelByValue = useMemo(() => {
		const map = new Map<string, string>();
		for (const u of facetsUsers) {
			map.set(
				u.id,
				u.name ?? u.email ?? `Removed user (${u.id.slice(0, 8)})`,
			);
		}
		return map;
	}, [facetsUsers]);

	const triggerLabel = multiSelectLabel(
		value,
		"All members",
		(v) => labelByValue.get(v) ?? "Removed user",
	);

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className={FILTER_TRIGGER_CLASS}
					aria-label="Filter by member"
				>
					<span className="flex items-center gap-1.5 truncate">
						<UserIcon className="size-3.5 opacity-60" />
						<span className="truncate">{triggerLabel}</span>
					</span>
					<ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[18rem] p-0" align="start">
				<Command>
					<CommandInput
						placeholder="Search by name or email..."
						className="h-9"
					/>
					<CommandList>
						<CommandEmpty>No members.</CommandEmpty>
						<CommandGroup>
							{facetsUsers.map((u) => {
								const selected = value.includes(u.id);
								const label =
									u.name ??
									u.email ??
									`Removed user (${u.id.slice(0, 8)})`;
								return (
									<CommandItem
										key={u.id}
										value={`${label} ${u.email ?? ""} ${u.id}`}
										onSelect={() => {
											toggleMembership(
												value,
												u.id,
												onChange,
											);
										}}
									>
										<CheckIcon
											className={cn(
												"mr-2 size-3.5",
												selected
													? "opacity-100"
													: "opacity-0",
											)}
										/>
										<div className="flex min-w-0 flex-1 items-center justify-between gap-2">
											<div className="min-w-0">
												<div className="truncate text-sm">
													{label}
													{u.removed ? (
														<Badge
															variant="outline"
															className="ml-2 px-1 py-0 text-[10px] font-normal"
														>
															removed
														</Badge>
													) : null}
												</div>
												{u.name && u.email ? (
													<div className="truncate text-[11px] text-muted-foreground">
														{u.email}
													</div>
												) : null}
											</div>
											<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
												{u.requests}
											</span>
										</div>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
					{value.length > 0 ? (
						<MultiSelectClearFooter
							onClear={() => onChange([])}
							count={value.length}
						/>
					) : null}
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function MultiSelectClearFooter({
	onClear,
	count,
}: {
	onClear: () => void;
	count: number;
}) {
	return (
		<div className="flex items-center justify-between border-t border-border bg-muted/30 px-2 py-1.5">
			<span className="text-[11px] tabular-nums text-muted-foreground">
				{count} selected
			</span>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-7 px-2 text-[11px]"
				onClick={onClear}
			>
				Clear
			</Button>
		</div>
	);
}

type ChartPoint = {
	date: string;
	requests: number;
	totalTokens: number;
	costMicroUsd: number;
};

// Custom tooltip showing every metric (cost / requests / tokens /
// latency) for the hovered bucket. Memoized so recharts' high-frequency
// mouse moves don't churn React.
const ChartTooltipContent = memo(function ChartTooltipContent({
	active,
	payload,
	label,
	tz,
}: {
	active?: boolean;
	payload?: Array<{
		payload: ChartPoint & { costUsd: number; avgLatencyMs: number };
	}>;
	label?: string;
	tz: Timezone;
}) {
	if (!active || !payload?.length) {
		return null;
	}
	const p = payload[0]?.payload;
	if (!p) {
		return null;
	}
	const cost = p.costUsd;
	return (
		<div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-foreground shadow-md">
			<div className="mb-1.5 font-medium">
				{label ? `${formatTz(label, "PPp", tz)} ${tzSuffix(tz)}` : ""}
			</div>
			<dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
				<dt className="text-muted-foreground">Cost</dt>
				<dd className="text-right font-medium text-primary">
					{cost === 0
						? "$0.00"
						: cost < 0.001
							? `$${cost.toFixed(6)}`
							: `$${cost.toFixed(4)}`}
				</dd>
				<dt className="text-muted-foreground">Requests</dt>
				<dd className="text-right">{p.requests.toLocaleString()}</dd>
				<dt className="text-muted-foreground">Tokens</dt>
				<dd className="text-right">{p.totalTokens.toLocaleString()}</dd>
				<dt className="text-muted-foreground">Latency</dt>
				<dd className="text-right">
					{p.avgLatencyMs > 0 ? formatLatency(p.avgLatencyMs) : "—"}
				</dd>
			</dl>
		</div>
	);
});

type ChartMetric = "cost" | "requests" | "tokens" | "latency";

/**
 * Chart-axis representation of an active AI usage limit. Computed in the
 * parent and passed into `UsageTrendChart` for the recharts ReferenceLine
 * overlay. Stays minimal so the chart does not
 * need to re-derive metric/period coupling — it just renders one
 * horizontal line per entry at `yValue`.
 */
interface ChartLimitOverlay {
	id: string;
	yValue: number;
	enforcement: AiUsageLimitDto["enforcement"];
}

const CHART_METRICS: Record<ChartMetric, { label: string; dataKey: string }> = {
	cost: { label: "Cost", dataKey: "costUsd" },
	requests: { label: "Requests", dataKey: "requests" },
	tokens: { label: "Tokens", dataKey: "totalTokens" },
	latency: { label: "Latency", dataKey: "avgLatencyMs" },
};

function granularityForSpan(spanMs: number): "day" | "hour" | "minute" {
	const ONE_DAY = 86_400_000;
	if (spanMs <= ONE_DAY * 1.5) {
		return "minute";
	}
	if (spanMs <= ONE_DAY * 8) {
		return "hour";
	}
	return "day";
}

function formatTickByGranularity(
	v: string,
	granularity: "day" | "hour" | "minute",
	tz: Timezone,
): string {
	if (granularity === "minute") {
		return formatTz(v, "HH:mm", tz);
	}
	if (granularity === "hour") {
		return formatTz(v, "MMM d, HH:00", tz);
	}
	return formatTz(v, "MMM d", tz);
}

function UsageTrendChart({
	queryInput,
	filterFrom,
	filterTo,
	periodLabel,
	metric,
	tz,
	limitOverlays,
}: {
	queryInput: Record<string, unknown>;
	filterFrom: Date;
	filterTo: Date;
	periodLabel: string;
	metric: ChartMetric;
	tz: Timezone;
	/**
	 * Active AI usage limits already filtered by the parent for the
	 * selected period + chart metric. Empty array
	 * = no overlay. Each entry maps to one horizontal `ReferenceLine`.
	 */
	limitOverlays: ChartLimitOverlay[];
}) {
	// Visual zoom window — independent of the table's filter window.
	const [zoom, setZoom] = useState<{ from: Date; to: Date } | null>(null);
	// Drag-to-select state for in-chart zoom.
	const [dragStart, setDragStart] = useState<string | null>(null);
	const [dragEnd, setDragEnd] = useState<string | null>(null);

	const viewFrom = zoom?.from ?? filterFrom;
	const viewTo = zoom?.to ?? filterTo;
	const span = viewTo.getTime() - viewFrom.getTime();
	const granularity = granularityForSpan(span);
	const isZoomed = zoom !== null;

	// Reset zoom when the filter range itself shifts (period switch,
	// custom range, etc.). Comparing ISO strings keeps useEffect stable
	// against new Date references for the same point in time.
	const filterKey = `${filterFrom.toISOString()}|${filterTo.toISOString()}`;
	useEffect(() => {
		setZoom(null);
		setDragStart(null);
		setDragEnd(null);
	}, [filterKey]);

	const seriesQuery = useQuery(
		orpc.payments.getAiActivityTimeSeries.queryOptions({
			input: {
				...queryInput,
				from: viewFrom,
				to: viewTo,
				granularity,
			},
			staleTime: STALE_TIME,
			placeholderData: keepPreviousData,
		}),
	);

	const data = useMemo(() => {
		const points = (seriesQuery.data?.points ?? []) as Array<
			ChartPoint & { avgLatencyMs?: number }
		>;
		return points.map((p) => ({
			date: p.date,
			requests: p.requests,
			totalTokens: p.totalTokens,
			costMicroUsd: p.costMicroUsd,
			costUsd: p.costMicroUsd / 1_000_000,
			avgLatencyMs: p.avgLatencyMs ?? 0,
		}));
	}, [seriesQuery.data]);

	const hasAny = data.some(
		(d) =>
			d.costUsd > 0 ||
			d.requests > 0 ||
			d.totalTokens > 0 ||
			d.avgLatencyMs > 0,
	);

	const totalCost = data.reduce((s, d) => s + d.costUsd, 0);
	const totalRequests = data.reduce((s, d) => s + d.requests, 0);

	const activeMetric = CHART_METRICS[metric];

	const yTickFormatter = (v: number) => {
		switch (metric) {
			case "cost":
				if (v === 0) {
					return "$0";
				}
				if (v < 0.01) {
					return `$${v.toFixed(3)}`;
				}
				if (v < 1) {
					return `$${v.toFixed(2)}`;
				}
				return `$${v.toFixed(0)}`;
			case "tokens":
				return formatTokens(v);
			case "latency":
				return formatLatency(v);
			default:
				return v.toLocaleString();
		}
	};

	// Pan the visible window left/right by 25% of the current span,
	// clamped to the filter range. No-op when not zoomed (full range).
	const pan = (dir: "left" | "right") => {
		if (!isZoomed) {
			return;
		}
		const shift = (dir === "left" ? -1 : 1) * span * 0.25;
		let newFrom = new Date(viewFrom.getTime() + shift);
		let newTo = new Date(viewTo.getTime() + shift);
		if (newFrom.getTime() < filterFrom.getTime()) {
			newFrom = filterFrom;
			newTo = new Date(newFrom.getTime() + span);
		}
		if (newTo.getTime() > filterTo.getTime()) {
			newTo = filterTo;
			newFrom = new Date(newTo.getTime() - span);
		}
		setZoom({ from: newFrom, to: newTo });
	};

	// Click-zoom around the current view's center. Min span 1 minute so
	// we never collapse to a single point.
	const stepZoom = (dir: "in" | "out") => {
		const factor = dir === "in" ? 0.5 : 2;
		const newSpan = Math.max(60_000, span * factor);
		const center = (viewFrom.getTime() + viewTo.getTime()) / 2;
		let newFrom = new Date(center - newSpan / 2);
		let newTo = new Date(center + newSpan / 2);
		if (newFrom.getTime() < filterFrom.getTime()) {
			newFrom = filterFrom;
		}
		if (newTo.getTime() > filterTo.getTime()) {
			newTo = filterTo;
		}
		if (
			newFrom.getTime() <= filterFrom.getTime() &&
			newTo.getTime() >= filterTo.getTime()
		) {
			setZoom(null);
		} else {
			setZoom({ from: newFrom, to: newTo });
		}
	};

	const resetZoom = () => {
		setZoom(null);
		setDragStart(null);
		setDragEnd(null);
	};

	// Drag-to-zoom on the chart body. Recharts hands us `activeLabel`
	// (the x-axis value at the cursor) on each mouse event. We only
	// commit the zoom on mouse-up if the drag covered some span.
	const handleMouseDown = (e: { activeLabel?: string | number }) => {
		const label = e?.activeLabel;
		if (label === undefined || label === null) {
			return;
		}
		const v = String(label);
		setDragStart(v);
		setDragEnd(v);
	};
	const handleMouseMove = (e: { activeLabel?: string | number }) => {
		const label = e?.activeLabel;
		if (dragStart && label !== undefined && label !== null) {
			setDragEnd(String(label));
		}
	};
	const handleMouseUp = () => {
		if (dragStart && dragEnd && dragStart !== dragEnd) {
			const a = new Date(dragStart);
			const b = new Date(dragEnd);
			const [from, to] = a.getTime() < b.getTime() ? [a, b] : [b, a];
			// Clamp to filter range for safety.
			const clampedFrom =
				from.getTime() < filterFrom.getTime() ? filterFrom : from;
			const clampedTo = to.getTime() > filterTo.getTime() ? filterTo : to;
			if (clampedTo.getTime() - clampedFrom.getTime() >= 60_000) {
				setZoom({ from: clampedFrom, to: clampedTo });
			}
		}
		setDragStart(null);
		setDragEnd(null);
	};

	const isLoading = seriesQuery.isPending;
	const showSelection = dragStart && dragEnd && dragStart !== dragEnd;

	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<CardTitle className="text-base font-semibold">
							{activeMetric.label} over time
						</CardTitle>
						<p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
							{totalRequests.toLocaleString()} requests ·{" "}
							{totalCost === 0
								? "$0.00"
								: totalCost < 1
									? `$${totalCost.toFixed(4)}`
									: `$${totalCost.toFixed(2)}`}{" "}
							total
							{isZoomed ? (
								<>
									{" · "}
									<span className="font-medium text-primary">
										{formatTz(viewFrom, "MMM d, HH:mm", tz)}{" "}
										→ {formatTz(viewTo, "MMM d, HH:mm", tz)}{" "}
										{tzSuffix(tz)}
									</span>
								</>
							) : null}
						</p>
					</div>
					<div className="flex flex-wrap items-center justify-end gap-2">
						{/* Metric switcher — pill bar with the active metric
						    highlighted in success green. */}
						{/* Pan + zoom controls. Pan disabled when not
						    zoomed (full range = nothing to scroll). */}
						<div className="inline-flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
							<Button
								variant="ghost"
								size="sm"
								className="size-7 p-0"
								onClick={() => pan("left")}
								disabled={
									!isZoomed ||
									viewFrom.getTime() <= filterFrom.getTime()
								}
								aria-label="Pan left"
								title="Pan left"
							>
								<ChevronLeftIcon className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="size-7 p-0"
								onClick={() => stepZoom("in")}
								disabled={!hasAny || span <= 60_000}
								aria-label="Zoom in"
								title="Zoom in (drag on chart works too)"
							>
								<ZoomInIcon className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="size-7 p-0"
								onClick={() => stepZoom("out")}
								disabled={!hasAny || !isZoomed}
								aria-label="Zoom out"
								title="Zoom out"
							>
								<ZoomOutIcon className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="size-7 p-0"
								onClick={() => pan("right")}
								disabled={
									!isZoomed ||
									viewTo.getTime() >= filterTo.getTime()
								}
								aria-label="Pan right"
								title="Pan right"
							>
								<ChevronRightIcon className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="size-7 p-0"
								onClick={resetZoom}
								disabled={!isZoomed}
								aria-label="Reset zoom"
								title="Reset zoom"
							>
								<RotateCcwIcon className="size-3.5" />
							</Button>
						</div>
						<span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
							{periodLabel}
						</span>
					</div>
				</div>
			</CardHeader>
			<CardContent className="pl-2">
				<div className="h-[260px] w-full">
					{isLoading ? (
						<div className="flex h-full items-center justify-center text-muted-foreground">
							<Loader2Icon className="size-4 animate-spin" />
						</div>
					) : (
						<ResponsiveContainer width="100%" height="100%">
							<AreaChart
								data={data}
								margin={{
									top: 12,
									right: 20,
									left: 12,
									bottom: 4,
								}}
								onMouseDown={handleMouseDown}
								onMouseMove={handleMouseMove}
								onMouseUp={handleMouseUp}
								onMouseLeave={handleMouseUp}
								style={{
									cursor: dragStart
										? "ew-resize"
										: "crosshair",
									userSelect: "none",
								}}
							>
								<defs>
									{/* Success-green gradient — matches the
									    Status pill on success rows. */}
									<linearGradient
										id="usageMetricGradient"
										x1="0"
										y1="0"
										x2="0"
										y2="1"
									>
										<stop
											offset="0%"
											stopColor="var(--primary)"
											stopOpacity={0.55}
										/>
										<stop
											offset="100%"
											stopColor="var(--primary)"
											stopOpacity={0.05}
										/>
									</linearGradient>
								</defs>
								<CartesianGrid
									strokeDasharray="3 3"
									stroke="var(--foreground)"
									opacity={0.12}
									vertical={false}
								/>
								<XAxis
									dataKey="date"
									tick={{
										fontSize: 11,
										fill: "var(--foreground)",
										fillOpacity: 0.65,
									}}
									tickFormatter={(v: string) =>
										formatTickByGranularity(
											v,
											granularity,
											tz,
										)
									}
									tickLine={false}
									axisLine={false}
									minTickGap={28}
								/>
								<YAxis
									tick={{
										fontSize: 11,
										fill: "var(--foreground)",
										fillOpacity: 0.65,
									}}
									tickFormatter={yTickFormatter}
									tickLine={false}
									axisLine={false}
									width={56}
								/>
								<RechartsTooltip
									cursor={{
										stroke: "var(--primary)",
										strokeOpacity: 0.35,
										strokeWidth: 1.5,
									}}
									content={(p) => (
										<ChartTooltipContent
											active={p.active}
											payload={
												p.payload as unknown as Array<{
													payload: ChartPoint & {
														costUsd: number;
														avgLatencyMs: number;
													};
												}>
											}
											label={p.label as string}
											tz={tz}
										/>
									)}
								/>
								<Area
									type="monotone"
									dataKey={activeMetric.dataKey}
									stroke="var(--primary)"
									strokeWidth={2.25}
									fill="url(#usageMetricGradient)"
									activeDot={{
										r: 4,
										strokeWidth: 2,
										stroke: "var(--background)",
									}}
									// Skip the per-point draw animation —
									// keeps filter/zoom changes feeling
									// instant.
									isAnimationActive={false}
								/>
								{showSelection ? (
									<ReferenceArea
										x1={dragStart}
										x2={dragEnd}
										strokeOpacity={0.4}
										stroke="var(--primary)"
										fill="var(--primary)"
										fillOpacity={0.12}
									/>
								) : null}
								{/* AI usage limit-line overlay. One horizontal
								    reference line per active limit whose window
								    matches the selected period and whose dimension
								    matches the chart metric. Stroke colour
								    resolves to a CSS-variable token (no hardcoded
								    hex per `frontend/css.md`); the right-edge
								    label carries the i18n "Limit" copy and acts
								    as the screen-reader equivalent (every line
								    has a unique `key` for stable diffing). */}
								{limitOverlays.map((overlay) => (
									<ReferenceLine
										key={overlay.id}
										y={overlay.yValue}
										stroke="var(--highlight)"
										strokeOpacity={0.5}
										strokeDasharray="4 4"
										strokeWidth={1.5}
										ifOverflow="extendDomain"
										label={{
											value: "Limit",
											position: "right",
											fill: "var(--highlight)",
											fontSize: 10,
											fontWeight: 500,
										}}
									/>
								))}
							</AreaChart>
						</ResponsiveContainer>
					)}
					{!isLoading ? (
						<p className="mt-1 px-2 text-[10px] text-muted-foreground/60">
							{hasAny
								? "Drag horizontally on the chart to zoom into a range · use the pan / zoom buttons to navigate"
								: "No activity in this range — chart shows zeros across the full window."}
						</p>
					) : null}
				</div>
			</CardContent>
		</Card>
	);
}

async function exportCsv(
	queryInput: Record<string, unknown>,
	organizationId: string | undefined,
	tz: Timezone,
) {
	const tzLabel = tz === "utc" ? "utc" : "local";
	const header = [
		`timestamp_${tzLabel}`,
		"taskType",
		"jobType",
		"provider",
		"model",
		"project",
		...(organizationId ? ["userId", "userName", "userEmail"] : []),
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"latencyMs",
		"costUsd",
		"status",
		"errorMessage",
	];
	const rows: string[][] = [];

	// Walk pages until we reach the end (or the safety cap below).
	let cursor: string | undefined;
	let safety = 1_000; // 1000 pages × 100 rows/page = 100k rows max
	const exportInput = {
		...queryInput,
		limit: 100,
		cursor: undefined as string | undefined,
	};
	while (safety-- > 0) {
		exportInput.cursor = cursor;
		const page = (await orpcClient.payments.listAiActivity(
			exportInput,
		)) as {
			rows: Array<{
				id: string;
				createdAt: string | Date;
				provider: string;
				modelCanonicalName: string | null;
				providerModelId: string;
				taskType: string | null;
				jobType: string | null;
				projectName: string | null;
				userId: string | null;
				userName: string | null;
				userEmail: string | null;
				inputTokens: number;
				outputTokens: number;
				totalTokens: number;
				latencyMs: number;
				costMicroUsd: number;
				success: boolean;
				errorMessage: string | null;
			}>;
			nextCursor: string | null;
		};
		for (const r of page.rows) {
			// In UTC mode the row's stored UTC instant is what we
			// emit (its toISOString is already UTC). In local mode
			// we emit a local-timezone ISO-ish string that round-
			// trips the wall-clock value the user saw in the table.
			const created =
				tz === "utc"
					? new Date(r.createdAt).toISOString()
					: formatTz(r.createdAt, "yyyy-MM-dd'T'HH:mm:ss", "local");
			const fields = [
				created,
				r.taskType ?? "",
				r.jobType ?? "",
				r.provider,
				r.modelCanonicalName ?? r.providerModelId,
				r.projectName ?? "",
				...(organizationId
					? [r.userId ?? "", r.userName ?? "", r.userEmail ?? ""]
					: []),
				String(r.inputTokens),
				String(r.outputTokens),
				String(r.totalTokens),
				String(r.latencyMs),
				(r.costMicroUsd / 1_000_000).toFixed(6),
				r.success ? "success" : "error",
				r.errorMessage ?? "",
			];
			rows.push(fields);
		}
		if (!page.nextCursor) {
			break;
		}
		cursor = page.nextCursor;
	}

	const escape = (v: string) => {
		// Neutralize spreadsheet formula prefixes (OWASP CSV injection) —
		// errorMessage and project names are tenant-influenced strings.
		const guarded = /^[=+\-@\t]/.test(v) ? `'${v}` : v;
		return /[",\n]/.test(guarded)
			? `"${guarded.replace(/"/g, '""')}"`
			: guarded;
	};
	const body =
		[header, ...rows].map((line) => line.map(escape).join(",")).join("\n") +
		"\n";
	const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	const stamp = format(new Date(), "yyyy-MM-dd-HHmm");
	a.download = `ai-usage-${stamp}.csv`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
