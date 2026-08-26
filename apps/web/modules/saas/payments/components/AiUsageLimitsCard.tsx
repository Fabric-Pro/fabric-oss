"use client";

/**
 * `AiUsageLimitsCard` — the "Usage limits" surface that lives at the top
 * of the AI Usage page. Renders one row per
 * active limit with a live progress bar, used/max copy, the active
 * window's timezone hint, and a HARD/SOFT enforcement badge. Members of
 * an organization without owner/admin role see the empty list (the
 * server already filters these per b) and never see the
 * "Manage limits" / per-row edit affordances.
 * Visual language follows the marketing-page reference set out in
 * `CLAUDE.md` "Design Context": editorial section label (thin red bar +
 * uppercase `tracking-[0.25em]`), warm stone surfaces, no glassmorphism,
 * no hardcoded hex — every colour resolves to a CSS variable token.
 * Data fetching uses the hooks (`useAiUsageLimits` /
 * `useAiUsageLimitsStatus`) — both share the same `aiUsageLimitsKeys`
 * cache root so the edit Sheet's mutation invalidates this card in one
 * shot.
 * Per [`frontend/components.md`] (single-responsibility client component,
 * named export), [`frontend/accessibility.md`] (`aria-labelledby`,
 * `role="progressbar"`, icon-only controls have `aria-label`),
 * [`frontend/css.md`] (design-token colours; specific-property transitions),
 * and [`ai/ai-copy-tone.md`] (calm/advisory copy).
 */

import {
	type AiUsageLimitDto,
	type AiUsageLimitStatus,
	useAiUsageLimits,
	useAiUsageLimitsStatus,
} from "@saas/payments/hooks/useAiUsageLimits";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	ClockIcon,
	FolderIcon,
	PencilIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { AiUsageLimitEditSheet } from "./AiUsageLimitEditSheet";

interface AiUsageLimitsCardProps {
	/** Org-context organisation id. Undefined = personal context. */
	organizationId?: string;
	/**
	 * Whether the caller can manage limits. Hides the "Manage limits"
	 * button and the per-row edit affordance when false (org members
	 * below admin per b — they additionally see an empty
	 * `statuses` array from the procedure, so the empty-state CTA is
	 * also hidden).
	 */
	canManage: boolean;
}

type SheetMode =
	| { kind: "closed" }
	| { kind: "create" }
	| { kind: "edit"; limit: AiUsageLimitDto };

const HEADING_ID = "ai-usage-limits-heading";

/**
 * Map the wire window enum to its human-readable label. Falls back to
 * lower-cased enum value if a future enum variant is added before the
 * matching i18n key — calm copy preferred over a thrown error in the
 * card itself per `ai/ai-copy-tone.md`.
 */
function windowLabelKey(
	window: AiUsageLimitDto["window"],
):
	| "rowWindowHourly"
	| "rowWindowDaily"
	| "rowWindowWeekly"
	| "rowWindowMonthly" {
	switch (window) {
		case "HOURLY":
			return "rowWindowHourly";
		case "DAILY":
			return "rowWindowDaily";
		case "WEEKLY":
			return "rowWindowWeekly";
		case "MONTHLY":
			return "rowWindowMonthly";
	}
}

/**
 * Compute a relative-time label for "time until the window resets",
 * truncated to minutes (never seconds). Returns `null` when the windowEnd
 * is missing or already passed — the parent renders nothing in that case
 * because the underlying counter has already rolled.
 *
 * Format ladder (largest non-zero unit only):
 *   ≥ 1 day  → `Resets in 2d 4h`
 *   ≥ 1 h    → `Resets in 5h 23m`
 *   ≥ 1 min  → `Resets in 12m`
 *   < 1 min  → `Resets shortly`
 */
function formatTimeUntilReset(
	windowEndIso: string | undefined,
	now: number,
	t: (key: string, values?: Record<string, string | number>) => string,
): string | null {
	if (!windowEndIso) {
		return null;
	}
	const endMs = Date.parse(windowEndIso);
	if (!Number.isFinite(endMs)) {
		return null;
	}
	const remainingMs = endMs - now;
	if (remainingMs <= 0) {
		return null;
	}

	const totalMinutes = Math.floor(remainingMs / 60_000);
	if (totalMinutes < 1) {
		return t("rowResetsShortly");
	}
	const days = Math.floor(totalMinutes / (24 * 60));
	const hoursAfterDays = Math.floor((totalMinutes % (24 * 60)) / 60);
	const hoursTotal = Math.floor(totalMinutes / 60);
	const minutesAfterHours = totalMinutes % 60;

	if (days >= 1) {
		return t("rowResetsInDaysHours", { d: days, h: hoursAfterDays });
	}
	if (hoursTotal >= 1) {
		return t("rowResetsInHoursMinutes", {
			h: hoursTotal,
			m: minutesAfterHours,
		});
	}
	return t("rowResetsInMinutes", { m: totalMinutes });
}

/**
 * Real-time clock that ticks every 60s — minutes are the smallest unit
 * displayed in the reset countdown, so a 60s cadence avoids unnecessary
 * re-renders while keeping the label visually fresh. NOT a server-polling
 * hook — purely client-local `Date.now()`. The status query owns the
 * authoritative `windowEnd`; this hook only re-computes the label.
 */
function useMinuteTick(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) {
			return;
		}
		// Align the first tick to the next minute boundary so all rows tick
		// in lock-step. After that, a steady 60s interval.
		const alignmentMs = 60_000 - (Date.now() % 60_000);
		let intervalId: ReturnType<typeof setInterval> | null = null;
		const timeoutId = setTimeout(() => {
			setNow(Date.now());
			intervalId = setInterval(() => setNow(Date.now()), 60_000);
		}, alignmentMs);
		return () => {
			clearTimeout(timeoutId);
			if (intervalId !== null) {
				clearInterval(intervalId);
			}
		};
	}, [active]);
	return now;
}

/**
 * The marketing-page reference uses TZ city abbreviations in parens
 * ("this month (PT)"). Convert the IANA TZ string to a short abbreviation
 * for display via Intl. Falls back to the raw IANA name if the runtime
 * cannot derive a `timeZoneName: "short"` part (e.g., older browsers).
 */
function shortTimezoneName(timezone: string): string {
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			timeZoneName: "short",
		});
		const parts = formatter.formatToParts(new Date());
		const tzPart = parts.find((part) => part.type === "timeZoneName");
		return tzPart?.value ?? timezone;
	} catch {
		return timezone;
	}
}

/**
 * Compact number formatting for tokens — matches the precedent in
 * `AiUsageActivityView.tsx:218` so the card and the surrounding page use
 * the same display rules.
 */
function formatTokens(n: bigint | number): string {
	const value = typeof n === "bigint" ? Number(n) : n;
	if (value < 1_000) {
		return value.toLocaleString("en-US");
	}
	if (value < 1_000_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	if (value < 1_000_000_000) {
		return `${(value / 1_000_000).toFixed(2)}M`;
	}
	return `${(value / 1_000_000_000).toFixed(2)}B`;
}

/**
 * SPEND_USD storage is micro-USD (BigInt). Convert to dollars for
 * display with a `$` prefix and 2 decimals. Per /
 * display rules.
 */
function formatSpendUsd(microUsd: bigint): string {
	const dollars = Number(microUsd) / 1_000_000;
	return `$${dollars.toFixed(2)}`;
}

/**
 * Resolve the `(used / max unit)` row copy. Returns the formatted strings
 * for `used`, `max`, and `unit` ready for the i18n `rowUsedOfMax` key.
 */
function formatUsedOfMax(
	dimension: AiUsageLimitDto["dimension"],
	used: bigint,
	max: bigint,
): { used: string; max: string; unit: string } {
	if (dimension === "SPEND_USD") {
		return {
			used: formatSpendUsd(used),
			max: formatSpendUsd(max),
			unit: "",
		};
	}
	return {
		used: formatTokens(used),
		max: formatTokens(max),
		unit: "tokens",
	};
}

/**
 * Map the status percent to the design-token Tailwind class for the
 * progress fill.:
 * - <80% → `bg-primary` (deep rose)
 * - 80-99% → `bg-highlight` (amber)
 * - >=100% → `bg-destructive` (red)
 */
function progressFillClass(percent: number): string {
	if (percent >= 100) {
		return "bg-destructive";
	}
	if (percent >= 80) {
		return "bg-highlight";
	}
	return "bg-primary";
}

/**
 * Auto-generated fallback label when the user did not name the limit.
 * Format: `"{Window} {Provider} {Dimension}"`
 */
function fallbackLimitName(limit: AiUsageLimitDto): string {
	const windowPart =
		limit.window === "HOURLY"
			? "Hourly"
			: limit.window === "DAILY"
				? "Daily"
				: "Monthly";
	const dimPart = limit.dimension === "SPEND_USD" ? "spend" : "tokens";
	return `${windowPart} ${dimPart}`;
}

interface ProgressBarProps {
	percent: number;
	limitName: string;
	usedDescription: string;
}

/**
 * Plain-DOM progress bar — does NOT use `<Progress>` from `@ui/components`
 * because that primitive applies `transition-all` (an explicit anti-pattern
 * in `CLAUDE.md` "Design Context"). We use `transition-transform` on the
 * fill bar and `transition-colors` on the band colour so only the
 * properties that actually change animate.
 */
function ProgressBar({
	percent,
	limitName,
	usedDescription,
}: ProgressBarProps) {
	const clampedPercent = Math.max(0, Math.min(percent, 100));
	const fillClass = progressFillClass(percent);
	return (
		<div
			role="progressbar"
			aria-label={`${limitName}: ${usedDescription}`}
			aria-valuenow={percent}
			aria-valuemin={0}
			aria-valuemax={100}
			className="relative h-1.5 w-full overflow-hidden rounded-full bg-border"
		>
			<div
				className={cn(
					"h-full rounded-full transition-transform duration-300 ease-out motion-reduce:transition-none",
					fillClass,
				)}
				style={{
					width: "100%",
					transform: `translateX(-${100 - clampedPercent}%)`,
				}}
			/>
		</div>
	);
}

/**
 * Joined view of a `limit` row plus its (optional) live `status`. The
 * `list` and `status` queries are independent — usually they arrive in
 * the same tick, but the card has to render whichever lands first. If
 * the status row is missing we still render the limit with `0%` so the
 * shape stays stable.
 */
interface LimitRowViewModel {
	limit: AiUsageLimitDto;
	status?: AiUsageLimitStatus;
}

function joinLimitsAndStatuses(
	limits: AiUsageLimitDto[],
	statuses: AiUsageLimitStatus[],
): LimitRowViewModel[] {
	const statusById = new Map<string, AiUsageLimitStatus>();
	for (const status of statuses) {
		statusById.set(status.limit.id, status);
	}
	return limits.map((limit) => ({
		limit,
		status: statusById.get(limit.id),
	}));
}

interface LimitRowProps {
	row: LimitRowViewModel;
	canManage: boolean;
	onEdit: (limit: AiUsageLimitDto) => void;
	/** Live ms timestamp re-rendered every 60s for the reset countdown. */
	now: number;
	/** Project name for the limit's projectId — undefined when WORKSPACE-scoped. */
	projectName?: string;
}

function LimitRow({ row, canManage, onEdit, now, projectName }: LimitRowProps) {
	const t = useTranslations("settings.aiUsage.limits");
	const { limit, status } = row;
	const used = status ? BigInt(status.currentValue) : BigInt(0);
	const max = BigInt(limit.maxValue);
	const percent = status?.percent ?? 0;
	const usedOfMax = formatUsedOfMax(limit.dimension, used, max);
	const usedOfMaxLabel = t("rowUsedOfMax", {
		used: usedOfMax.used,
		max: usedOfMax.max,
		unit: usedOfMax.unit,
	}).trim();
	const limitName = limit.name ?? fallbackLimitName(limit);
	const tz = status?.timezone
		? shortTimezoneName(status.timezone)
		: shortTimezoneName(
				typeof Intl !== "undefined" &&
					typeof Intl.DateTimeFormat === "function"
					? (Intl.DateTimeFormat().resolvedOptions().timeZone ??
							"UTC")
					: "UTC",
			);
	const windowLabel = t(windowLabelKey(limit.window), { tz });
	const isHard = limit.enforcement === "HARD";
	const resetsInLabel = formatTimeUntilReset(status?.windowEnd, now, t);

	// Enforcement pill — the same DOM in both modes. The pill is a span
	// (no nested-button trap) so it can sit inside the row button when
	// `canManage` is true; the Tooltip wrapper still provides hover /
	// focus-on-pointer-tooltip behaviour.
	const enforcementPill = (
		<TooltipProvider delayDuration={300}>
			<Tooltip>
				<TooltipTrigger asChild>
					<span
						className={cn(
							"shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
							isHard
								? "bg-destructive/10 text-destructive"
								: "bg-muted text-muted-foreground",
						)}
					>
						{isHard
							? t("rowEnforcementHard")
							: t("rowEnforcementSoft")}
					</span>
				</TooltipTrigger>
				<TooltipContent>
					{isHard
						? t("rowEnforcementHardTooltip")
						: t("rowEnforcementSoftTooltip")}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);

	// Visual row contents — shared between manageable and read-only
	// branches. The pencil icon shows up only when `canManage` so the
	// edit affordance is visible without nesting a `<button>` inside the
	// row `<button>` (which would be invalid HTML and a nested-button
	// trap per `[frontend/accessibility.md]`).
	const projectChip =
		limit.projectId && projectName ? (
			<TooltipProvider delayDuration={300}>
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex max-w-[10rem] items-center gap-1 truncate rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
							<FolderIcon
								className="size-3 shrink-0"
								aria-hidden="true"
							/>
							<span className="truncate">{projectName}</span>
						</span>
					</TooltipTrigger>
					<TooltipContent>
						{t("rowProjectTooltip", { name: projectName })}
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		) : null;

	const rowContent = (
		<div className="flex flex-col gap-2 px-3 py-3">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<span className="truncate font-medium text-foreground text-sm">
						{limitName}
					</span>
					{enforcementPill}
					{projectChip}
				</div>
				{canManage ? (
					<PencilIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
				) : null}
			</div>
			<ProgressBar
				percent={percent}
				limitName={limitName}
				usedDescription={usedOfMaxLabel}
			/>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<span className="truncate">{usedOfMaxLabel}</span>
				<div className="flex shrink-0 items-center gap-2.5">
					{resetsInLabel ? (
						<>
							<span
								className="inline-flex items-center gap-1"
								aria-live="polite"
							>
								<ClockIcon
									className="size-3 shrink-0"
									aria-hidden="true"
								/>
								{resetsInLabel}
							</span>
							<span
								className="h-3 w-px shrink-0 bg-border/80"
								aria-hidden="true"
							/>
						</>
					) : null}
					<span>{windowLabel}</span>
				</div>
			</div>
		</div>
	);

	if (!canManage) {
		return (
			<div className="rounded-md border border-border/60 bg-background/50">
				{rowContent}
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={() => onEdit(limit)}
			aria-label={t("rowEditAriaLabel", { name: limitName })}
			className="block w-full rounded-md border border-border/60 bg-background/50 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
		>
			{rowContent}
		</button>
	);
}

function CardSkeleton() {
	return (
		<div className="space-y-3" aria-hidden="true">
			{[0, 1].map((index) => (
				<div
					key={index}
					className="rounded-md border border-border/60 bg-background/50 px-3 py-3"
				>
					<div className="mb-2 flex items-center justify-between">
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-4 w-12" />
					</div>
					<Skeleton className="h-1.5 w-full rounded-full" />
					<div className="mt-2 flex justify-between">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-3 w-20" />
					</div>
				</div>
			))}
		</div>
	);
}

function ErrorState({ message }: { message: string }) {
	return (
		<div
			role="alert"
			className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
		>
			<AlertCircleIcon
				className="mt-0.5 size-4 shrink-0"
				aria-hidden="true"
			/>
			<p className="text-xs">{message}</p>
		</div>
	);
}

export function AiUsageLimitsCard({
	organizationId,
	canManage,
}: AiUsageLimitsCardProps) {
	const t = useTranslations("settings.aiUsage.limits");
	const [sheetMode, setSheetMode] = useState<SheetMode>({ kind: "closed" });

	const limitsQuery = useAiUsageLimits(organizationId ?? null);
	const statusQuery = useAiUsageLimitsStatus(organizationId ?? null);

	const limits = limitsQuery.data?.limits ?? [];
	const statuses = statusQuery.data?.statuses ?? [];

	const rows = useMemo<LimitRowViewModel[]>(
		() => joinLimitsAndStatuses(limits, statuses),
		[limits, statuses],
	);

	// Fetch a small project map for any row scoped to a specific project,
	// so the row chip can show the project name instead of an opaque id.
	// Enabled only when at least one limit carries a `projectId` — avoids
	// the API call entirely when no project-scoped limits exist (the common
	// case for tenants that haven't adopted project scoping yet).
	const hasProjectScopedLimit = useMemo(
		() => rows.some((row) => row.limit.projectId !== null),
		[rows],
	);
	const projectsQuery = useQuery({
		queryKey: ["aiUsageLimit", "projectPicker", organizationId ?? null],
		queryFn: () =>
			orpcClient.projects.list({
				organizationId: organizationId ?? null,
				limit: 100,
				offset: 0,
			}),
		enabled: hasProjectScopedLimit,
		staleTime: 5 * 60_000,
		refetchOnWindowFocus: false,
	});
	const projectNameById = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of projectsQuery.data?.projects ?? []) {
			map.set(p.id, p.name);
		}
		return map;
	}, [projectsQuery.data]);

	// 60s tick for the reset countdown — only runs while we have at least
	// one row to render, so an empty card has zero background work.
	const now = useMinuteTick(rows.length > 0);

	const isLoading = limitsQuery.isLoading || statusQuery.isLoading;
	const isErrored =
		limitsQuery.isError && statusQuery.isError && !limitsQuery.data;
	const errorMessage =
		limitsQuery.error instanceof Error ? limitsQuery.error.message : null;

	function openCreateSheet() {
		setSheetMode({ kind: "create" });
	}

	function openEditSheet(limit: AiUsageLimitDto) {
		setSheetMode({ kind: "edit", limit });
	}

	function handleSheetOpenChange(open: boolean) {
		if (!open) {
			setSheetMode({ kind: "closed" });
		}
	}

	return (
		<>
			<section
				aria-labelledby={HEADING_ID}
				className="rounded-lg border border-border bg-card"
			>
				<header className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-4 py-3">
					<div className="flex items-center gap-3">
						<span
							className="block h-3.5 w-0.5 shrink-0 bg-primary"
							aria-hidden="true"
						/>
						<p
							id={HEADING_ID}
							className="font-sans font-normal text-[11px] text-primary uppercase tracking-[0.25em]"
						>
							{t("sectionLabel")}
						</p>
					</div>
					{canManage ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 text-xs"
							onClick={openCreateSheet}
						>
							{t("manageButton")}
						</Button>
					) : null}
				</header>

				<div className="px-4 py-4">
					{isLoading ? (
						<CardSkeleton />
					) : isErrored ? (
						<ErrorState
							message={
								errorMessage ??
								"Could not load AI usage limits. Try refreshing."
							}
						/>
					) : rows.length === 0 ? (
						<div className="flex flex-col items-start gap-3 py-2">
							<p className="text-sm text-muted-foreground">
								{t("emptyBody")}
							</p>
							{canManage ? (
								<Button
									type="button"
									variant="default"
									size="sm"
									onClick={openCreateSheet}
									className="motion-safe:transition-colors"
								>
									{t("emptyCta")}
								</Button>
							) : null}
						</div>
					) : (
						<div className="space-y-2">
							{rows.map((row) => (
								<LimitRow
									key={row.limit.id}
									row={row}
									canManage={canManage}
									onEdit={openEditSheet}
									now={now}
									projectName={
										row.limit.projectId
											? projectNameById.get(
													row.limit.projectId,
												)
											: undefined
									}
								/>
							))}
						</div>
					)}
				</div>
			</section>

			<AiUsageLimitEditSheet
				open={sheetMode.kind !== "closed"}
				onOpenChange={handleSheetOpenChange}
				organizationId={organizationId}
				existing={sheetMode.kind === "edit" ? sheetMode.limit : null}
			/>
		</>
	);
}
