"use client";

/**
 * AuditLogStatsStrip
 *
 * Compact stats strip above the audit-log toolbar. Surfaces four
 * high-signal metrics:
 *   - Events today (count + sparkline of hourly volume)
 *   - Failures today (count)
 *   - Avg latency (24h) + sparkline — fixed 24-hour window
 *   - Sessions today (count) — distinct sessionIds in today's window
 *
 * The latency card was previously a dropdown (1h / 6h / 24h / 7d) but
 * operator feedback was "I always pick 24h anyway" — so the window is
 * now hardcoded and the title includes "(24h)" for clarity.
 *
 * Visual rules per CLAUDE.md design context: warm card surfaces, no
 * glassmorphism, no animated gradients, editorial small labels, tokens
 * only for colour. Compact: `p-3`, value font `text-lg font-semibold`.
 *
 * Data source: `audit.stats` oRPC procedure. 30s `staleTime` so the
 * strip refreshes alongside the table's auto-refresh without piling on
 * the DB.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";

/**
 * Latency window is now fixed to 24h. Kept as a type-level constant
 * (rather than inline) so the upstream `audit.stats` procedure type
 * keeps inferring the right argument when we forward it. Operator
 * feedback was that the dropdown was clutter — they always chose 24h.
 */
type LatencyWindow = "24h";
const FIXED_LATENCY_WINDOW: LatencyWindow = "24h";

/**
 * Format an average-latency value for display. Sub-1s → `47 ms`;
 * otherwise `1.2 s`. Null / negative → an em-dash.
 */
export function formatAverageLatency(ms: number | null): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
		return "—";
	}
	if (ms < 1000) {
		return `${Math.round(ms)} ms`;
	}
	return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Optional data-source override. When omitted the strip fetches via
 * the standard `orpc.audit.stats` procedure (in-product viewer's
 * path). The admin "Audit Log Explorer" passes a custom
 * implementation that routes through the staff proxy procedure so the
 * same render path works for cross-tenant reads via API key.
 */
export interface AuditLogStatsStripDataSource {
	/** Stable React-Query key suffix that uniquely identifies the source. */
	cacheKey: readonly unknown[];
	fetch: (args: {
		latencyWindow: LatencyWindow;
	}) => Promise<Awaited<ReturnType<typeof orpcClient.audit.stats>>>;
}

interface AuditLogStatsStripProps {
	organizationId: string | null;
	/** Optional — see {@link AuditLogStatsStripDataSource}. */
	dataSource?: AuditLogStatsStripDataSource;
}

interface StatCardProps {
	label: string;
	value: string;
	tooltip?: string;
	/**
	 * Optional sparkline payload. When supplied, the spark renders inline
	 * to the right of the value on `sm+` viewports. Keeps the four cards
	 * visually symmetric: the layout slot is reserved even on cards
	 * without a spark, so the alignment of the editorial label / value
	 * baseline stays identical across the row.
	 */
	sparkline?: {
		values: number[];
		max: number;
		tone?: "primary" | "secondary";
	};
	/** Suffix rendered after the value, dimmer — useful for "(24h)" hints. */
	suffix?: string;
	/** Optional test id on the editorial label itself (assertion target). */
	labelTestId?: string;
	"aria-live"?: "off" | "polite";
	"data-testid"?: string;
}

function StatCard({
	label,
	value,
	tooltip,
	sparkline,
	suffix,
	labelTestId,
	...rest
}: StatCardProps) {
	const card = (
		<div
			{...rest}
			className={cn(
				"flex flex-col gap-1 rounded-lg border border-border/60 bg-card p-3",
			)}
		>
			<p className="app-editorial-label" data-testid={labelTestId}>
				{label}
				{suffix ? (
					<>
						{" "}
						<span className="font-normal normal-case tracking-normal text-muted-foreground/80">
							{suffix}
						</span>
					</>
				) : null}
			</p>
			<div className="flex items-center justify-between gap-2">
				<div className="font-display text-lg font-semibold tracking-tight text-foreground">
					{value}
				</div>
				{sparkline && sparkline.values.length > 0 ? (
					<Sparkline
						values={sparkline.values}
						max={sparkline.max}
						className="hidden w-20 sm:flex"
						tone={sparkline.tone}
					/>
				) : null}
			</div>
		</div>
	);
	if (!tooltip) {
		return card;
	}
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>{card}</TooltipTrigger>
				<TooltipContent>{tooltip}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

function StatCardSkeleton() {
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card p-3">
			<Skeleton className="h-3 w-24" />
			<Skeleton className="h-5 w-16" />
		</div>
	);
}

/**
 * Bare-bones CSS-only sparkline. Renders one div per bucket with height
 * proportional to the value (clamped to a minimum of 6% so empty hours
 * still register). The bars use `bg-primary` and the container has a
 * dotted-baseline rule to telegraph "ratio chart" without needing a
 * library.
 */
function Sparkline({
	values,
	max,
	className,
	tone = "primary",
}: {
	values: number[];
	max: number;
	className?: string;
	tone?: "primary" | "secondary";
}) {
	if (values.length === 0) {
		return null;
	}
	const safeMax = Math.max(1, max);
	const barColor = tone === "secondary" ? "bg-secondary/60" : "bg-primary/60";
	return (
		<div
			className={cn(
				"flex h-8 items-end gap-px overflow-hidden rounded-sm",
				className,
			)}
			aria-hidden="true"
		>
			{values.map((value, index) => {
				const heightPct = Math.max(
					6,
					Math.min(100, Math.round((value / safeMax) * 100)),
				);
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: positional bars
						key={index}
						className={cn("flex-1", barColor)}
						style={{ height: `${heightPct}%` }}
					/>
				);
			})}
		</div>
	);
}

export function AuditLogStatsStrip({
	organizationId,
	dataSource,
}: AuditLogStatsStripProps) {
	const t = useTranslations();
	const latencyWindow = FIXED_LATENCY_WINDOW;

	const { data, isLoading, isError } = useQuery({
		queryKey: dataSource
			? ([
					"audit-log-stats",
					...dataSource.cacheKey,
					latencyWindow,
				] as const)
			: (["audit-log", "stats", organizationId, latencyWindow] as const),
		queryFn: () =>
			dataSource
				? dataSource.fetch({ latencyWindow })
				: orpcClient.audit.stats({
						organizationId: organizationId ?? null,
						latencyWindow,
					}),
		staleTime: 30 * 1000,
		refetchOnWindowFocus: false,
	});

	if (isLoading) {
		return (
			<section
				aria-busy="true"
				aria-label={t("settings.auditLog.stats.loading")}
				className="grid grid-cols-2 gap-2 lg:grid-cols-4"
			>
				<StatCardSkeleton />
				<StatCardSkeleton />
				<StatCardSkeleton />
				<StatCardSkeleton />
			</section>
		);
	}

	if (isError) {
		return (
			<div
				role="alert"
				className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-muted-foreground"
			>
				{t("settings.auditLog.stats.error")}
			</div>
		);
	}

	const eventsToday = data?.eventsToday ?? 0;
	const failuresToday = data?.failuresToday ?? 0;
	const sessionsToday = data?.sessionsToday ?? 0;
	const hourlyVolume = (data?.hourlyVolume ?? []) as number[];
	const sparkMax = hourlyVolume.length ? Math.max(...hourlyVolume, 1) : 1;

	const averageLatencyMs = (data?.averageLatencyMs ?? null) as number | null;
	const latencySparkline = (data?.latencySparkline ?? []) as number[];
	const latencySparkMax = latencySparkline.length
		? Math.max(...latencySparkline, 1)
		: 1;

	return (
		// All four cards now go through the same `StatCard` helper so the
		// editorial-label baseline, value typography, and sparkline slot
		// stay structurally identical across the row. Previously two cards
		// were inline divs and the other two used the helper — the
		// resulting padding/font shifts were subtle but read as messy
		// asymmetry in the grid.
		<section
			aria-label={t("settings.auditLog.stats.title")}
			className="grid grid-cols-2 gap-2 lg:grid-cols-4"
			data-testid="audit-stats-strip"
		>
			<StatCard
				label={t("settings.auditLog.stats.eventsToday")}
				value={eventsToday.toLocaleString()}
				tooltip={t("settings.auditLog.tooltips.statsEventsToday")}
				sparkline={
					hourlyVolume.length > 0
						? { values: hourlyVolume, max: sparkMax }
						: undefined
				}
				data-testid="audit-stats-events-today"
			/>
			<StatCard
				label={t("settings.auditLog.stats.failuresToday")}
				value={failuresToday.toLocaleString()}
				tooltip={t("settings.auditLog.tooltips.statsFailuresToday")}
				aria-live="polite"
				data-testid="audit-stats-failures-today"
			/>
			<StatCard
				label={t("settings.auditLog.stats.averageLatency")}
				value={formatAverageLatency(averageLatencyMs)}
				tooltip={t("settings.auditLog.tooltips.statsAverageLatency")}
				suffix="(24h)"
				sparkline={
					latencySparkline.length > 0
						? {
								values: latencySparkline,
								max: latencySparkMax,
								tone: "secondary",
							}
						: undefined
				}
				data-testid="audit-stats-avg-latency"
				labelTestId="audit-stats-avg-latency-label"
			/>
			<StatCard
				label={t("settings.auditLog.stats.sessionsToday")}
				value={sessionsToday.toLocaleString()}
				tooltip={t("settings.auditLog.tooltips.statsSessionsToday")}
				aria-live="polite"
				data-testid="audit-stats-sessions-today"
			/>
		</section>
	);
}
