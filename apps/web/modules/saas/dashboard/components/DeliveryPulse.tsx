"use client";

import type {
	DeliveryFlowStage,
	DeliveryInsightsRange,
	DeliveryInsightsResult,
} from "@repo/database";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Progress } from "@ui/components/progress";
import { Skeleton } from "@ui/components/skeleton";
import { formatDistanceToNow } from "date-fns";
import {
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { MetricCard } from "./MetricCard";

const RANGE_OPTIONS: Array<{ value: DeliveryInsightsRange; label: string }> = [
	{ value: 7, label: "7 days" },
	{ value: 30, label: "30 days" },
	{ value: 90, label: "90 days" },
];
const FLOW_LABELS: Record<DeliveryFlowStage, string> = {
	drafting: "Drafting",
	sanityCheck: "Sanity check",
	readyForDev: "Ready for dev",
	implementing: "Implementing",
	review: "Review",
	blocked: "Blocked",
};
const OUTCOME_LABELS = {
	active: "In flight",
	completed: "Completed",
	review: "Needs review",
	failed: "Failed or stale",
	cancelled: "Cancelled",
} as const;

function formatChartDate(date: string): string {
	return new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

function briefing(data: DeliveryInsightsResult): string {
	const { readyInRange, previousReady } = data.summary;
	if (readyInRange > previousReady) {
		return `Readiness increased from ${previousReady} to ${readyInRange} features compared with the previous period.`;
	}
	if (readyInRange < previousReady) {
		return `Readiness slowed from ${previousReady} to ${readyInRange} features compared with the previous period.`;
	}
	return `${readyInRange} features reached ready for development, matching the previous period.`;
}

interface DeliveryPulseProps {
	data?: DeliveryInsightsResult;
	loading: boolean;
	error: boolean;
	range: DeliveryInsightsRange;
	onRangeChange: (range: DeliveryInsightsRange) => void;
	onStageChange: (stage: DeliveryFlowStage) => void;
	onRetry: () => void;
}

export function DeliveryPulse({
	data,
	loading,
	error,
	range,
	onRangeChange,
	onStageChange,
	onRetry,
}: DeliveryPulseProps) {
	if (loading) {
		return (
			<section
				aria-labelledby="delivery-pulse-title"
				className="space-y-4"
			>
				<div className="flex items-center justify-between gap-4">
					<div>
						<h2
							id="delivery-pulse-title"
							className="text-base font-semibold"
						>
							Delivery pulse
						</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							Loading your delivery history and current flow.
						</p>
					</div>
				</div>
				<div className="grid gap-4 md:grid-cols-3">
					{Array.from({ length: 3 }, (_, index) => (
						<MetricCard key={index} title="" value="" loading />
					))}
				</div>
				<div className="grid gap-4 lg:grid-cols-5">
					<Card className="min-w-0 lg:col-span-3">
						<CardContent className="p-5">
							<Skeleton className="h-64 w-full" />
						</CardContent>
					</Card>
					<Card className="min-w-0 lg:col-span-2">
						<CardContent className="p-5">
							<Skeleton className="h-64 w-full" />
						</CardContent>
					</Card>
				</div>
			</section>
		);
	}

	if (error) {
		return (
			<Card role="alert">
				<CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
					<div>
						<p className="text-sm font-medium">
							Delivery insights could not load
						</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Your work queues remain available. Retry to reload
							their charts.
						</p>
					</div>
					<Button variant="outline" size="sm" onClick={onRetry}>
						Retry insights
					</Button>
				</CardContent>
			</Card>
		);
	}

	if (!data?.hasData) {
		return null;
	}

	const { summary } = data;
	const flowMaximum = Math.max(...data.flow.map((item) => item.count), 1);
	const outcomeMaximum = Math.max(
		...data.agentOutcomes.map((item) => item.count),
		1,
	);

	return (
		<section aria-labelledby="delivery-pulse-title" className="space-y-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2
						id="delivery-pulse-title"
						className="text-base font-semibold"
					>
						Delivery pulse
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						Your feature progress and coding-run outcomes, based on
						recorded transitions.
					</p>
				</div>
				<fieldset className="flex flex-wrap gap-1">
					<legend className="sr-only">
						Delivery insights date range
					</legend>
					{RANGE_OPTIONS.map((option) => (
						<Button
							key={option.value}
							variant={
								range === option.value ? "secondary" : "ghost"
							}
							size="xs"
							aria-pressed={range === option.value}
							onClick={() => onRangeChange(option.value)}
						>
							{option.label}
						</Button>
					))}
				</fieldset>
			</div>

			<div className="grid gap-4 md:grid-cols-3">
				<MetricCard
					title="Ready for development"
					value={summary.readyInRange}
					subtitle={`${summary.previousReady} in the previous ${range}-day period`}
				/>
				<MetricCard
					title="Median time to ready"
					value={
						summary.medianReadyDays === null
							? "—"
							: `${summary.medianReadyDays}d`
					}
					subtitle={
						summary.readyDurationSamples > 0
							? `Across ${summary.readyDurationSamples} timestamped transitions`
							: "No timestamped transitions in this range"
					}
				/>
				<MetricCard
					title="Runs needing attention"
					value={summary.runsNeedingAttention}
					subtitle={`${summary.failedRuns} failed or stale · ${summary.reviewRuns} in review`}
				/>
			</div>

			<div className="grid gap-4 lg:grid-cols-5 lg:items-stretch">
				<Card className="flex h-full min-w-0 flex-col lg:col-span-3">
					<CardHeader className="px-5 pb-2 pt-4">
						<CardTitle className="text-base">
							Path to development
						</CardTitle>
						<CardDescription>
							Features created versus first marked ready for
							development.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex min-h-0 flex-1 flex-col px-3 pb-4 pt-2">
						<div
							className="min-h-64 w-full flex-1 overflow-hidden"
							aria-hidden
						>
							<ResponsiveContainer
								width="100%"
								height="100%"
								minWidth={0}
								minHeight={0}
								initialDimension={{ width: 1, height: 1 }}
							>
								<LineChart
									data={data.timeline}
									margin={{
										top: 8,
										right: 12,
										left: 0,
										bottom: 0,
									}}
								>
									<CartesianGrid
										stroke="var(--border)"
										strokeDasharray="3 3"
										vertical={false}
									/>
									<XAxis
										dataKey="date"
										tickFormatter={formatChartDate}
										tick={{ fontSize: 11 }}
										stroke="var(--muted-foreground)"
										interval={
											range === 7
												? 0
												: Math.floor(range / 7)
										}
									/>
									<YAxis
										allowDecimals={false}
										tick={{ fontSize: 11 }}
										stroke="var(--muted-foreground)"
										width={32}
									/>
									<Tooltip
										contentStyle={{
											background: "var(--card)",
											border: "1px solid var(--border)",
											borderRadius: 6,
											fontSize: 12,
										}}
										labelFormatter={(label) =>
											formatChartDate(String(label))
										}
									/>
									<Legend />
									<Line
										name="Created scope"
										type="monotone"
										dataKey="scope"
										stroke="var(--primary)"
										strokeWidth={2}
										dot={false}
									/>
									<Line
										name="Ready for development"
										type="monotone"
										dataKey="ready"
										stroke="var(--success)"
										strokeWidth={2}
										dot={false}
									/>
								</LineChart>
							</ResponsiveContainer>
						</div>
						<details className="px-2 text-xs">
							<summary className="cursor-pointer text-muted-foreground">
								View chart data
							</summary>
							<div className="mt-2 max-h-56 overflow-auto">
								<table className="w-full text-left">
									<thead>
										<tr className="text-muted-foreground">
											<th className="py-1 font-medium">
												Date
											</th>
											<th className="py-1 font-medium">
												Created scope
											</th>
											<th className="py-1 font-medium">
												Ready for development
											</th>
										</tr>
									</thead>
									<tbody>
										{data.timeline.map((point) => (
											<tr
												key={point.date}
												className="border-t border-border"
											>
												<td className="py-1">
													{formatChartDate(
														point.date,
													)}
												</td>
												<td className="py-1">
													{point.scope}
												</td>
												<td className="py-1">
													{point.ready}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</details>
					</CardContent>
				</Card>

				<div className="space-y-4 min-w-0 lg:col-span-2">
					<Card>
						<CardHeader className="px-5 pb-3 pt-4">
							<CardTitle className="text-base">
								Current flow
							</CardTitle>
							<CardDescription>
								Select a stage to filter My features below.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-1 px-3 pb-3">
							{data.flow.map((item) => (
								<Button
									key={item.stage}
									variant="ghost"
									className="h-auto w-full justify-start gap-3 px-2 py-2 text-xs"
									onClick={() => onStageChange(item.stage)}
									aria-label={`Show ${FLOW_LABELS[item.stage]} features: ${item.count}`}
								>
									<span className="w-24 shrink-0 text-left">
										{FLOW_LABELS[item.stage]}
									</span>
									<Progress
										value={(item.count / flowMaximum) * 100}
										className="min-w-8 flex-1"
										aria-hidden
									/>
									<span className="w-6 text-right font-medium tabular-nums">
										{item.count}
									</span>
								</Button>
							))}
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="px-5 pb-3 pt-4">
							<CardTitle className="text-base">
								Agent outcomes
							</CardTitle>
							<CardDescription>
								Latest status for your runs updated in this
								range.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-3 px-5 pb-4">
							{data.agentOutcomes.map((item) => (
								<div
									key={item.status}
									className="flex items-center gap-3 text-xs"
								>
									<span className="w-24 shrink-0">
										{OUTCOME_LABELS[item.status]}
									</span>
									<Progress
										value={
											(item.count / outcomeMaximum) * 100
										}
										className="min-w-8 flex-1"
										aria-hidden
									/>
									<span className="w-6 text-right font-medium tabular-nums">
										{item.count}
									</span>
								</div>
							))}
						</CardContent>
					</Card>
				</div>
			</div>

			<Card>
				<CardHeader className="px-5 pb-2 pt-4">
					<CardTitle className="text-base">What changed</CardTitle>
					<CardDescription>
						A deterministic summary of the metrics above, generated{" "}
						{formatDistanceToNow(data.generatedAt, {
							addSuffix: true,
						})}
						.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-2 px-5 pb-4 text-sm">
					<p>{briefing(data)}</p>
					<p className="text-muted-foreground">
						{summary.createdInRange} features were added in this
						range. {summary.failedRuns} runs are failed or stale,
						and {summary.reviewRuns} runs are waiting for review.
					</p>
				</CardContent>
			</Card>
		</section>
	);
}
