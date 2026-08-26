"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { getBillingCategoryLabel } from "@shared/lib/billing-categories";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { format, formatDistanceToNow } from "date-fns";
import { HelpCircleIcon, Loader2Icon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Tooltip as RechartsTooltip,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";

type Range = "7d" | "30d" | "90d" | "all";
type GroupBy =
	| "model"
	| "provider"
	| "taskType"
	| "agentId"
	| "billingCategory";

const RANGE_OPTIONS: Array<{ value: Range; label: string }> = [
	{ value: "7d", label: "Last 7 days" },
	{ value: "30d", label: "Last 30 days" },
	{ value: "90d", label: "Last 90 days" },
	{ value: "all", label: "All time" },
];

const GROUP_BY_OPTIONS: Array<{ value: GroupBy; label: string }> = [
	{ value: "model", label: "Model" },
	{ value: "provider", label: "Provider" },
	{ value: "taskType", label: "Task type" },
	{ value: "agentId", label: "Agent" },
];

// Dashboard data doesn't need sub-minute freshness; avoids refetching five
// queries every time the user switches back to the Usage tab.
const USAGE_STALE_TIME = 60_000;
const CONFIGURED_MODELS_STALE_TIME = 5 * 60_000;

function formatUsd(cents: number): string {
	const usd = cents / 100;
	if (usd === 0) {
		return "$0.00";
	}
	if (usd < 0.01) {
		return "< $0.01";
	}
	if (usd < 1) {
		return `$${usd.toFixed(3)}`;
	}
	if (usd < 100) {
		return `$${usd.toFixed(2)}`;
	}
	return `$${Math.round(usd).toLocaleString()}`;
}

function formatTokens(n: number): string {
	if (n < 1_000) {
		return n.toString();
	}
	if (n < 1_000_000) {
		return `${(n / 1_000).toFixed(1)}k`;
	}
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatPct(n: number): string {
	return `${Math.round(n * 100)}%`;
}

// Model IDs include a provider prefix ("anthropic/claude-haiku-4.5") when
// written through the AI Gateway, but the Temporal-originated rows already
// store just the canonical name. Strip the prefix so both look the same.
function formatModel(raw: string | null | undefined): string {
	if (!raw) {
		return "—";
	}
	const slash = raw.lastIndexOf("/");
	return slash >= 0 ? raw.slice(slash + 1) : raw;
}

function SummaryTile({
	label,
	value,
	subtitle,
	tooltip,
}: {
	label: string;
	value: string;
	subtitle?: string;
	tooltip?: ReactNode;
}) {
	return (
		<Card className="bg-muted/40">
			<CardHeader className="pb-1">
				<CardTitle className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{label}
					{tooltip ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="text-muted-foreground/60 hover:text-muted-foreground"
									aria-label={`${label} details`}
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
				<div className="font-display text-2xl font-semibold tabular-nums">
					{value}
				</div>
				{subtitle ? (
					<div className="mt-0.5 text-[11px] text-muted-foreground">
						{subtitle}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

export function ProjectUsage({ projectId }: { projectId: string }) {
	const [range, setRange] = useState<Range>("30d");
	const [groupBy, setGroupBy] = useState<GroupBy>("model");

	const summaryQuery = useQuery(
		orpc.projects.usage.getSummary.queryOptions({
			input: { projectId, range },
			staleTime: USAGE_STALE_TIME,
		}),
	);
	const timeSeriesQuery = useQuery(
		orpc.projects.usage.getTimeSeries.queryOptions({
			input: { projectId, range, bucket: "day" },
			staleTime: USAGE_STALE_TIME,
		}),
	);
	const breakdownQuery = useQuery(
		orpc.projects.usage.getBreakdown.queryOptions({
			input: { projectId, range, groupBy },
			staleTime: USAGE_STALE_TIME,
		}),
	);
	const recentQuery = useInfiniteQuery(
		orpc.projects.usage.listRecent.infiniteOptions({
			input: (cursor: string | undefined) => ({
				projectId,
				limit: 25,
				cursor,
			}),
			initialPageParam: undefined as string | undefined,
			getNextPageParam: (lastPage: {
				nextCursor: string | null;
			}): string | undefined => lastPage.nextCursor ?? undefined,
			staleTime: USAGE_STALE_TIME,
		}),
	);
	const configuredQuery = useQuery(
		orpc.projects.usage.getConfiguredModels.queryOptions({
			input: { projectId },
			staleTime: CONFIGURED_MODELS_STALE_TIME,
		}),
	);

	const summary = summaryQuery.data;
	const timeSeries = timeSeriesQuery.data ?? [];
	const breakdown = breakdownQuery.data ?? [];
	const recent = useMemo(
		() => recentQuery.data?.pages.flatMap((page) => page.items) ?? [],
		[recentQuery.data],
	);
	const configured = configuredQuery.data;

	// Infinite scroll: fetch the next page when the sentinel scrolls into view
	// inside the recent-activity scroll container. Same pattern as CopilotPage /
	// ChatHistorySidebar but scoped to the table's own scroll region.
	const loadMoreRef = useRef<HTMLDivElement | null>(null);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = loadMoreRef.current;
		const root = scrollContainerRef.current;
		if (!el || !root) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (
					entries[0].isIntersecting &&
					recentQuery.hasNextPage &&
					!recentQuery.isFetchingNextPage
				) {
					recentQuery.fetchNextPage();
				}
			},
			{ root, threshold: 0.1 },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [
		recentQuery.hasNextPage,
		recentQuery.isFetchingNextPage,
		recentQuery.fetchNextPage,
	]);

	const platformBilledCents = summary
		? summary.byBillingCategory.INCLUDED_CREDIT.costCents +
			summary.byBillingCategory.STRIPE_METERED.costCents
		: 0;
	const platformUnbilledCents =
		summary?.byBillingCategory.PLATFORM_UNBILLED.costCents ?? 0;
	const platformCostCents = platformBilledCents + platformUnbilledCents;
	const byokCostCents =
		summary?.byBillingCategory.EXTERNAL_BYOK.costCents ?? 0;

	const chartData = useMemo(
		() =>
			timeSeries.map((point) => ({
				date: point.bucketStart,
				label: format(new Date(point.bucketStart), "MMM d"),
				usd: point.costCents / 100,
				tokens: point.totalTokens,
			})),
		[timeSeries],
	);

	const maxBreakdownCost = breakdown.reduce(
		(max, item) => Math.max(max, item.costCents),
		0,
	);

	return (
		<TooltipProvider delayDuration={150}>
			<div className="space-y-8">
				<header className="space-y-4">
					<span className="editorial-label">Project · Usage</span>
					<div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
						<div>
							<div className="flex items-center gap-1.5">
								<h2 className="font-serif text-[2.25rem] font-normal leading-tight tracking-tight text-foreground">
									Usage &amp; cost
								</h2>
								<PageTourButton pageId="usage" />
							</div>
							<p className="mt-2 max-w-2xl text-sm text-muted-foreground">
								AI spend attributed to this project across
								chats, documents, agents, and workflows.
							</p>
							{configured && (
								<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
									{configured.patternModel && (
										<span>
											<span className="font-medium text-foreground">
												Pattern:
											</span>{" "}
											{configured.patternModel}
										</span>
									)}
									{configured.shuttleModel && (
										<span>
											<span className="font-medium text-foreground">
												Shuttle:
											</span>{" "}
											{configured.shuttleModel}
										</span>
									)}
									{configured.implementationProvider && (
										<span>
											<span className="font-medium text-foreground">
												Implementation:
											</span>{" "}
											{configured.implementationProvider}
										</span>
									)}
								</div>
							)}
						</div>
						<div
							data-onboarding-target="usage-range"
							className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/40 p-1"
						>
							{RANGE_OPTIONS.map((option) => (
								<Button
									key={option.value}
									variant={
										range === option.value
											? "default"
											: "ghost"
									}
									size="sm"
									className="h-8 px-3 text-xs"
									onClick={() => setRange(option.value)}
								>
									{option.label}
								</Button>
							))}
						</div>
					</div>
				</header>

				<div
					data-onboarding-target="usage-summary"
					className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
				>
					<SummaryTile
						label="Platform spend"
						value={formatUsd(platformCostCents)}
						subtitle={
							platformUnbilledCents > 0
								? `incl. ${formatUsd(platformUnbilledCents)} unbilled`
								: undefined
						}
						tooltip="Fabric-hosted AI usage for this project: included credit, Stripe-metered usage, and any unbilled platform usage. Does not include usage on your own API keys (shown separately)."
					/>
					<SummaryTile
						label="BYOK usage"
						value={formatUsd(byokCostCents)}
						subtitle="On your own key · not billed by Fabric"
					/>
					<SummaryTile
						label="Total tokens"
						value={formatTokens(summary?.totalTokens ?? 0)}
					/>
					<SummaryTile
						label="Total calls"
						value={(summary?.totalCalls ?? 0).toLocaleString()}
					/>
					<SummaryTile
						label="Success rate"
						value={
							summary?.successRate == null
								? "—"
								: formatPct(summary.successRate)
						}
					/>
				</div>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between pb-2">
						<CardTitle className="text-base font-medium">
							Cost over time
						</CardTitle>
						<span className="text-xs text-muted-foreground">
							Daily buckets · USD
						</span>
					</CardHeader>
					<CardContent>
						{timeSeriesQuery.isLoading ? (
							<div className="h-56 animate-pulse rounded bg-muted/40" />
						) : chartData.length === 0 ? (
							<div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
								No usage recorded in this range.
							</div>
						) : (
							<div className="h-56 w-full">
								<ResponsiveContainer width="100%" height="100%">
									<AreaChart
										data={chartData}
										margin={{
											top: 8,
											right: 8,
											left: 0,
											bottom: 0,
										}}
									>
										<defs>
											<linearGradient
												id="usd-gradient"
												x1="0"
												y1="0"
												x2="0"
												y2="1"
											>
												<stop
													offset="0%"
													stopColor="var(--primary)"
													stopOpacity={0.35}
												/>
												<stop
													offset="100%"
													stopColor="var(--primary)"
													stopOpacity={0}
												/>
											</linearGradient>
										</defs>
										<CartesianGrid
											stroke="var(--border)"
											strokeDasharray="3 3"
											vertical={false}
										/>
										<XAxis
											dataKey="label"
											tick={{ fontSize: 11 }}
											stroke="var(--muted-foreground)"
										/>
										<YAxis
											tickFormatter={(value: number) =>
												`$${value.toFixed(value < 1 ? 2 : 0)}`
											}
											tick={{ fontSize: 11 }}
											stroke="var(--muted-foreground)"
											width={52}
										/>
										<RechartsTooltip
											contentStyle={{
												background: "var(--card)",
												border: "1px solid var(--border)",
												borderRadius: 6,
												fontSize: 12,
											}}
											labelStyle={{
												color: "var(--foreground)",
												fontWeight: 500,
											}}
											formatter={(value) => [
												`$${Number(value ?? 0).toFixed(4)}`,
												"Cost",
											]}
										/>
										<Area
											type="monotone"
											dataKey="usd"
											stroke="var(--primary)"
											strokeWidth={2}
											fill="url(#usd-gradient)"
										/>
									</AreaChart>
								</ResponsiveContainer>
							</div>
						)}
					</CardContent>
				</Card>

				<Card data-onboarding-target="usage-breakdown">
					<CardHeader className="flex flex-row items-center justify-between pb-2">
						<CardTitle className="text-base font-medium">
							Breakdown
						</CardTitle>
						<div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 p-0.5">
							{GROUP_BY_OPTIONS.map((option) => (
								<Button
									key={option.value}
									variant={
										groupBy === option.value
											? "default"
											: "ghost"
									}
									size="sm"
									className="h-7 px-2.5 text-xs"
									onClick={() => setGroupBy(option.value)}
								>
									{option.label}
								</Button>
							))}
						</div>
					</CardHeader>
					<CardContent>
						{breakdownQuery.isLoading ? (
							<div className="space-y-2">
								{[0, 1, 2].map((i) => (
									<div
										key={i}
										className="h-9 animate-pulse rounded bg-muted/40"
									/>
								))}
							</div>
						) : breakdown.length === 0 ? (
							<div className="py-6 text-center text-sm text-muted-foreground">
								No data to break down for this range.
							</div>
						) : (
							<div className="space-y-2">
								{breakdown.map((item) => {
									const pct =
										maxBreakdownCost === 0
											? 0
											: (item.costCents /
													maxBreakdownCost) *
												100;
									return (
										<div
											key={item.key}
											className="grid grid-cols-[minmax(0,1fr)_80px_90px_80px] items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm"
										>
											<div className="min-w-0 truncate font-medium">
												{item.label}
											</div>
											<div className="tabular-nums text-muted-foreground">
												{formatTokens(item.totalTokens)}
											</div>
											<div className="h-2 rounded-full bg-muted">
												<div
													className="h-full rounded-full bg-primary/70"
													style={{ width: `${pct}%` }}
												/>
											</div>
											<div className="text-right font-mono text-sm tabular-nums">
												{formatUsd(item.costCents)}
											</div>
										</div>
									);
								})}
							</div>
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-base font-medium">
							Recent activity
						</CardTitle>
					</CardHeader>
					<CardContent>
						{recentQuery.isLoading ? (
							<div className="h-24 animate-pulse rounded bg-muted/40" />
						) : recent.length === 0 ? (
							<div className="py-6 text-center text-sm text-muted-foreground">
								No AI calls recorded for this project yet.
							</div>
						) : (
							<div
								ref={scrollContainerRef}
								className="max-h-[480px] overflow-auto rounded-md border border-border"
							>
								<Table>
									<TableHeader className="sticky top-0 z-10 bg-card">
										<TableRow>
											<TableHead className="text-xs uppercase tracking-wider">
												When
											</TableHead>
											<TableHead className="text-xs uppercase tracking-wider">
												Model
											</TableHead>
											<TableHead className="text-xs uppercase tracking-wider">
												Task
											</TableHead>
											<TableHead className="text-xs uppercase tracking-wider">
												Agent
											</TableHead>
											<TableHead className="text-right text-xs uppercase tracking-wider">
												Tokens
											</TableHead>
											<TableHead className="text-right text-xs uppercase tracking-wider">
												Cost
											</TableHead>
											<TableHead className="text-xs uppercase tracking-wider">
												Billing
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{recent.map((item) => (
											<TableRow
												key={item.id}
												className={
													item.success
														? ""
														: "opacity-60"
												}
											>
												<TableCell className="text-xs text-muted-foreground">
													{formatDistanceToNow(
														new Date(
															item.createdAt,
														),
														{ addSuffix: true },
													)}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{formatModel(
														item.modelCanonicalName ??
															item.providerModelId,
													)}
												</TableCell>
												<TableCell className="text-xs">
													{item.taskType ?? "—"}
												</TableCell>
												<TableCell className="text-xs text-muted-foreground">
													{item.agentId ?? "—"}
												</TableCell>
												<TableCell className="text-right font-mono tabular-nums text-xs">
													{formatTokens(
														item.totalTokens,
													)}
												</TableCell>
												<TableCell className="text-right font-mono tabular-nums text-xs">
													{formatUsd(item.costCents)}
												</TableCell>
												<TableCell>
													{item.billingCategory ? (
														<Badge
															variant="outline"
															className="text-[10px]"
														>
															{getBillingCategoryLabel(
																item.billingCategory,
															)}
														</Badge>
													) : (
														<span className="text-xs text-muted-foreground">
															—
														</span>
													)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
								{recentQuery.hasNextPage ? (
									<div
										ref={loadMoreRef}
										className="py-3 text-center"
									>
										{recentQuery.isFetchingNextPage ? (
											<Loader2Icon className="mx-auto size-4 animate-spin text-muted-foreground" />
										) : (
											<span className="text-xs text-muted-foreground">
												Load more
											</span>
										)}
									</div>
								) : null}
							</div>
						)}
					</CardContent>
				</Card>
			</div>
		</TooltipProvider>
	);
}
