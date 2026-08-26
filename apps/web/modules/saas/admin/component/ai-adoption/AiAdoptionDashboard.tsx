"use client";

/**
 * Instance-admin AI adoption dashboard (Fizzy #2230).
 *
 * Reads, in order: how maturation answers were sourced (taken as-is /
 * AI-edited / manual), what reviewers did with AI Backlog Update proposals,
 * platform LLM volume, that volume split by the feature that spent it,
 * acceptance segmented by the model and prompt version that produced the
 * output, and the model/prompt changes in the window to read a movement
 * against. Everything here is a read-only aggregate.
 */
import type { ApiRouterClient } from "@repo/api/orpc/router";
import { orpc } from "@shared/lib/orpc-query-utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Tooltip as RechartsTooltip,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";

type AiAdoptionMetrics = Awaited<
	ReturnType<ApiRouterClient["admin"]["aiAdoption"]["metrics"]>
>;

type PeriodKey = "7d" | "30d" | "90d";

const PERIOD_OPTIONS: Array<{ key: PeriodKey; label: string; days: number }> = [
	{ key: "7d", label: "7 days", days: 7 },
	{ key: "30d", label: "30 days", days: 30 },
	{ key: "90d", label: "90 days", days: 90 },
];

/** Below this many observations a rate is too noisy to act on. */
const LOW_SAMPLE_THRESHOLD = 30;

const numberFormat = new Intl.NumberFormat("en-US");
const compactFormat = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

function formatPercent(part: number, whole: number): string {
	if (whole === 0) {
		return "—";
	}
	return `${Math.round((part / whole) * 100)}%`;
}

function formatUsd(microUsd: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	}).format(microUsd / 1_000_000);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span className="h-3.5 w-0.5 bg-primary" aria-hidden="true" />
			<span className="font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
				{children}
			</span>
		</div>
	);
}

function StatTile({
	label,
	value,
	detail,
}: {
	label: string;
	value: string;
	detail?: string;
}) {
	return (
		<div className="rounded-lg border border-border bg-card p-4">
			<p className="text-muted-foreground text-xs">{label}</p>
			<p className="mt-1 font-display font-semibold text-2xl tracking-tight">
				{value}
			</p>
			{detail ? (
				<p className="mt-0.5 text-muted-foreground text-xs">{detail}</p>
			) : null}
		</div>
	);
}

function LowSampleBadge({ total }: { total: number }) {
	if (total >= LOW_SAMPLE_THRESHOLD) {
		return null;
	}
	return (
		<span className="inline-flex items-center rounded-full border border-highlight/40 bg-highlight/10 px-2 py-0.5 text-highlight text-xs">
			Low sample (n={numberFormat.format(total)}) — interpret with caution
		</span>
	);
}

interface CompositionSegment {
	label: string;
	count: number;
	colorClass: string;
}

/**
 * Horizontal 100% composition bar. Identity is carried by the labeled
 * swatch list below the bar (never by color alone); segments keep a 2px
 * surface gap.
 */
function CompositionBar({
	segments,
	ariaLabel,
}: {
	segments: CompositionSegment[];
	ariaLabel: string;
}) {
	const total = segments.reduce((sum, segment) => sum + segment.count, 0);
	if (total === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				No activity in this period.
			</p>
		);
	}
	const visible = segments.filter((segment) => segment.count > 0);
	return (
		<div>
			<div
				className="flex h-3 w-full gap-0.5 overflow-hidden rounded-sm"
				role="img"
				aria-label={ariaLabel}
			>
				{visible.map((segment) => (
					<div
						key={segment.label}
						className={cn(
							"h-full rounded-[2px]",
							segment.colorClass,
						)}
						style={{ width: `${(segment.count / total) * 100}%` }}
					/>
				))}
			</div>
			<div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
				{segments.map((segment) => (
					<span
						key={segment.label}
						className="inline-flex items-center gap-1.5 text-xs"
					>
						<span
							className={cn(
								"size-2 rounded-[2px]",
								segment.colorClass,
							)}
							aria-hidden="true"
						/>
						<span className="text-foreground">{segment.label}</span>
						<span className="text-muted-foreground">
							{formatPercent(segment.count, total)} (
							{numberFormat.format(segment.count)})
						</span>
					</span>
				))}
			</div>
		</div>
	);
}

interface TrendPoint {
	date: string;
	rate: number | null;
	total: number;
	aiSuggested: number;
	aiEdited: number;
	manual: number;
}

function TrendTooltip({
	active,
	payload,
}: {
	active?: boolean;
	payload?: Array<{ payload: TrendPoint }>;
}) {
	const point = active ? payload?.[0]?.payload : undefined;
	if (!point) {
		return null;
	}
	return (
		<div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm">
			<p className="font-medium text-foreground">{point.date}</p>
			<p className="mt-1 text-muted-foreground">
				Taken as-is: {point.rate === null ? "—" : `${point.rate}%`} (
				{numberFormat.format(point.aiSuggested)} of{" "}
				{numberFormat.format(point.total)})
			</p>
			<p className="text-muted-foreground">
				AI-edited: {numberFormat.format(point.aiEdited)} · Manual:{" "}
				{numberFormat.format(point.manual)}
			</p>
		</div>
	);
}

function AcceptanceTrendChart({ points }: { points: TrendPoint[] }) {
	const hasData = points.some((point) => point.total > 0);
	if (!hasData) {
		return null;
	}
	return (
		<div className="h-56 w-full">
			<ResponsiveContainer width="100%" height="100%">
				<AreaChart
					data={points}
					margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
				>
					<defs>
						<linearGradient
							id="aiAdoptionRateGradient"
							x1="0"
							y1="0"
							x2="0"
							y2="1"
						>
							<stop
								offset="0%"
								stopColor="var(--primary)"
								stopOpacity={0.25}
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
						strokeOpacity={0.5}
						vertical={false}
					/>
					<XAxis
						dataKey="date"
						stroke="var(--muted-foreground)"
						tick={{ fontSize: 11 }}
						tickLine={false}
						axisLine={false}
						minTickGap={32}
					/>
					<YAxis
						domain={[0, 100]}
						stroke="var(--muted-foreground)"
						tick={{ fontSize: 11 }}
						tickLine={false}
						axisLine={false}
						tickFormatter={(value: number) => `${value}%`}
					/>
					<RechartsTooltip
						content={<TrendTooltip />}
						cursor={{
							stroke: "var(--muted-foreground)",
							strokeOpacity: 0.4,
						}}
					/>
					<Area
						type="monotone"
						dataKey="rate"
						stroke="var(--primary)"
						strokeWidth={2}
						fill="url(#aiAdoptionRateGradient)"
						connectNulls={false}
						dot={false}
						activeDot={{ r: 4 }}
					/>
				</AreaChart>
			</ResponsiveContainer>
		</div>
	);
}

function MaturationSection({
	maturation,
}: {
	maturation: AiAdoptionMetrics["maturation"];
}) {
	const { totals } = maturation;
	const trendPoints = useMemo<TrendPoint[]>(
		() =>
			maturation.series.map((day) => {
				const total = day.aiSuggested + day.aiEdited + day.manual;
				return {
					...day,
					total,
					rate:
						total === 0
							? null
							: Math.round((day.aiSuggested / total) * 100),
				};
			}),
		[maturation.series],
	);

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<SectionLabel>Feature maturation</SectionLabel>
					<h2 className="mt-1 font-display font-semibold text-lg tracking-tight">
						Answer acceptance
					</h2>
					<p className="text-muted-foreground text-sm">
						How maturation questions were answered: AI
						recommendation taken as-is, edited, or written manually.
					</p>
				</div>
				<LowSampleBadge total={totals.total} />
			</div>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<StatTile
					label="Taken as-is"
					value={formatPercent(totals.aiSuggested, totals.total)}
					detail={`${numberFormat.format(totals.aiSuggested)} answers`}
				/>
				<StatTile
					label="AI-edited"
					value={formatPercent(totals.aiEdited, totals.total)}
					detail={`${numberFormat.format(totals.aiEdited)} answers`}
				/>
				<StatTile
					label="Manual"
					value={formatPercent(totals.manual, totals.total)}
					detail={`${numberFormat.format(totals.manual)} answers`}
				/>
				<StatTile
					label="Answers"
					value={numberFormat.format(totals.total)}
					detail="in period"
				/>
			</div>
			<div className="rounded-lg border border-border bg-card p-4">
				<CompositionBar
					ariaLabel="Answer source composition"
					segments={[
						{
							label: "Taken as-is",
							count: totals.aiSuggested,
							colorClass: "bg-primary",
						},
						{
							label: "AI-edited",
							count: totals.aiEdited,
							colorClass: "bg-highlight",
						},
						{
							label: "Manual",
							count: totals.manual,
							colorClass: "bg-muted-foreground/50",
						},
					]}
				/>
				{totals.total > 0 ? (
					<div className="mt-4">
						<p className="mb-1 text-muted-foreground text-xs">
							Taken as-is, % of answers per day
						</p>
						<AcceptanceTrendChart points={trendPoints} />
					</div>
				) : null}
			</div>
		</section>
	);
}

function BacklogSection({
	backlog,
}: {
	backlog: AiAdoptionMetrics["backlog"];
}) {
	const { statusTotals, sessions } = backlog;
	const accepted = statusTotals.APPROVED + statusTotals.APPLIED;
	const decided = accepted + statusTotals.REJECTED;
	const other =
		statusTotals.PENDING +
		statusTotals.SUPERSEDED +
		statusTotals.BACKLOG +
		statusTotals.FAILED;

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<SectionLabel>AI Backlog Update</SectionLabel>
					<h2 className="mt-1 font-display font-semibold text-lg tracking-tight">
						Proposal outcomes
					</h2>
					<p className="text-muted-foreground text-sm">
						What reviewers did with AI-proposed backlog changes.
					</p>
				</div>
				<LowSampleBadge total={decided} />
			</div>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<StatTile
					label="Review acceptance"
					value={formatPercent(accepted, decided)}
					detail={`${numberFormat.format(accepted)} of ${numberFormat.format(decided)} decided`}
				/>
				<StatTile
					label="Proposals"
					value={numberFormat.format(backlog.totalProposals)}
					detail="in period"
				/>
				<StatTile
					label="Changes applied"
					value={numberFormat.format(sessions.appliedChanges)}
					detail={`${numberFormat.format(sessions.count)} apply sessions`}
				/>
				<StatTile
					label="Changes failed"
					value={numberFormat.format(sessions.failedChanges)}
					detail="technical failures, not rejections"
				/>
			</div>
			<div className="rounded-lg border border-border bg-card p-4">
				<CompositionBar
					ariaLabel="Backlog proposal status composition"
					segments={[
						{
							label: "Accepted",
							count: accepted,
							colorClass: "bg-secondary",
						},
						{
							label: "Rejected",
							count: statusTotals.REJECTED,
							colorClass: "bg-destructive",
						},
						{
							label: "Pending / other",
							count: other,
							colorClass: "bg-muted-foreground/30",
						},
					]}
				/>
			</div>
		</section>
	);
}

function UsageSection({ usage }: { usage: AiAdoptionMetrics["usage"] }) {
	return (
		<section className="space-y-4">
			<div>
				<SectionLabel>Context</SectionLabel>
				<h2 className="mt-1 font-display font-semibold text-lg tracking-tight">
					Platform LLM volume
				</h2>
			</div>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<StatTile
					label="LLM requests"
					value={compactFormat.format(usage.requests)}
				/>
				<StatTile
					label="Tokens"
					value={compactFormat.format(usage.totalTokens)}
				/>
				<StatTile
					label="Estimated cost"
					value={formatUsd(usage.costMicroUsd)}
				/>
				<StatTile
					label="Error rate"
					value={formatPercent(usage.failedRequests, usage.requests)}
					detail={`${numberFormat.format(usage.failedRequests)} failed`}
				/>
			</div>
			<p className="text-muted-foreground text-xs">
				Counts come from the model-call usage log; standalone agent
				runtimes bypass it, so agent traffic is undercounted.
			</p>
		</section>
	);
}

const FEATURE_LABELS: Record<string, string> = {
	maturation: "Feature maturation",
	"answer-recommendation": "Answer recommendations",
	"clean-spec": "Clean Spec",
	"backlog-update": "AI Backlog Update",
	"document-generation": "Document generation",
	"generate-tasks": "Generate tasks",
	"enhance-feature": "Enhance feature",
	"regenerate-title": "Regenerate title",
	"bug-reevaluation": "Bug re-evaluation",
	"duplicate-scan": "Duplicate scan",
	"chat-agent": "Chat agents",
	// Embeddings resolve through a different path that cannot carry a feature
	// key, and they are usually the bulk of the rows. Naming them keeps the
	// genuine "not tagged yet" bucket meaningful.
	__embeddings__: "Embeddings (RAG indexing)",
};

function featureLabel(key: string | null): string {
	if (key === null) {
		return "Untagged";
	}
	return FEATURE_LABELS[key] ?? key;
}

function FeatureUsageSection({
	rows,
}: {
	rows: AiAdoptionMetrics["usageByFeature"];
}) {
	const total = rows.reduce((sum, row) => sum + row.requests, 0);
	if (total === 0) {
		return null;
	}
	const tagged = rows.filter((row) => row.featureKey !== null);
	const untagged = rows.find((row) => row.featureKey === null);

	return (
		<section className="space-y-4">
			<div>
				<SectionLabel>By feature</SectionLabel>
				<h2 className="mt-1 font-display font-semibold text-lg tracking-tight">
					Where the AI spend goes
				</h2>
				<p className="text-muted-foreground text-sm">
					LLM calls and cost attributed to the feature that made them.
				</p>
			</div>
			<div className="overflow-x-auto rounded-lg border border-border bg-card">
				<table className="w-full min-w-[32rem] text-sm">
					<thead>
						<tr className="border-border border-b text-muted-foreground text-xs">
							<th className="px-4 py-2 text-left font-medium">
								Feature
							</th>
							<th className="px-4 py-2 text-right font-medium">
								Calls
							</th>
							<th className="px-4 py-2 text-right font-medium">
								Share
							</th>
							<th className="px-4 py-2 text-right font-medium">
								Tokens
							</th>
							<th className="px-4 py-2 text-right font-medium">
								Cost
							</th>
						</tr>
					</thead>
					<tbody>
						{tagged.map((row) => (
							<tr
								key={row.featureKey}
								className="border-border/60 border-b last:border-0"
							>
								<td className="px-4 py-2">
									{featureLabel(row.featureKey)}
								</td>
								<td className="px-4 py-2 text-right tabular-nums">
									{numberFormat.format(row.requests)}
								</td>
								<td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
									{formatPercent(row.requests, total)}
								</td>
								<td className="px-4 py-2 text-right tabular-nums">
									{compactFormat.format(row.totalTokens)}
								</td>
								<td className="px-4 py-2 text-right tabular-nums">
									{formatUsd(row.costMicroUsd)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{untagged ? (
				<p className="text-muted-foreground text-xs">
					{numberFormat.format(untagged.requests)} calls (
					{formatPercent(untagged.requests, total)}) come from
					language-model call sites that are not tagged yet —
					untagged, not feature-less. Embeddings are listed
					separately: they resolve through a path that cannot carry a
					feature key, so they are not a coverage gap.
				</p>
			) : null}
		</section>
	);
}

function SegmentationSection({
	segments,
	minSampleSize,
}: {
	segments: AiAdoptionMetrics["outcomeSegments"];
	minSampleSize: number;
}) {
	return (
		<section className="space-y-4">
			<div>
				<SectionLabel>Model &amp; prompt</SectionLabel>
				<h2 className="mt-1 font-display font-semibold text-lg tracking-tight">
					Acceptance by what produced it
				</h2>
				<p className="text-muted-foreground text-sm">
					Each row is the model and prompt version recorded at the
					moment the output was judged, so a later config change does
					not rewrite history.
				</p>
			</div>
			{segments.length === 0 ? (
				<p className="rounded-lg border border-border bg-card p-4 text-muted-foreground text-sm">
					No verdicts recorded yet in this period. Rows appear once
					people accept, reject, or rate AI output.
				</p>
			) : (
				<div className="overflow-x-auto rounded-lg border border-border bg-card">
					<table className="w-full min-w-[36rem] text-sm">
						<thead>
							<tr className="border-border border-b text-muted-foreground text-xs">
								<th className="px-4 py-2 text-left font-medium">
									Feature
								</th>
								<th className="px-4 py-2 text-left font-medium">
									Model
								</th>
								<th className="px-4 py-2 text-left font-medium">
									Prompt
								</th>
								<th className="px-4 py-2 text-right font-medium">
									Verdicts
								</th>
								<th className="px-4 py-2 text-right font-medium">
									Accepted
								</th>
							</tr>
						</thead>
						<tbody>
							{segments.map((segment) => {
								const low = segment.total < minSampleSize;
								return (
									<tr
										key={`${segment.featureKey}|${segment.modelCanonicalName ?? ""}|${segment.promptVersionId ?? ""}`}
										className="border-border/60 border-b last:border-0"
									>
										<td className="px-4 py-2">
											{featureLabel(segment.featureKey)}
										</td>
										<td className="px-4 py-2 text-muted-foreground">
											{segment.modelCanonicalName ?? "—"}
										</td>
										<td className="px-4 py-2 text-muted-foreground">
											{segment.promptVersionId
												? `${segment.promptVersionId.slice(0, 8)}…`
												: "—"}
										</td>
										<td className="px-4 py-2 text-right tabular-nums">
											{numberFormat.format(segment.total)}
										</td>
										<td
											className={cn(
												"px-4 py-2 text-right tabular-nums",
												low && "text-muted-foreground",
											)}
										>
											{segment.acceptanceRate === null
												? "—"
												: `${segment.acceptanceRate}%`}
											{low ? (
												<span className="ml-1 text-highlight text-xs">
													low n
												</span>
											) : null}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			<p className="text-muted-foreground text-xs">
				Rows marked “low n” have fewer than{" "}
				{numberFormat.format(minSampleSize)} verdicts — too few to read
				a rate from. An edit counts as acceptance: the AI still did the
				work.
			</p>
		</section>
	);
}

function ChangeLogSection({
	annotations,
}: {
	annotations: AiAdoptionMetrics["changeAnnotations"];
}) {
	if (annotations.length === 0) {
		return null;
	}
	return (
		<section className="space-y-4">
			<div>
				<SectionLabel>What changed</SectionLabel>
				<h2 className="mt-1 font-display font-semibold text-lg tracking-tight">
					Model &amp; prompt changes in this window
				</h2>
				<p className="text-muted-foreground text-sm">
					Read an acceptance movement against the change that
					plausibly caused it.
				</p>
			</div>
			<ol className="space-y-2 rounded-lg border border-border bg-card p-4">
				{annotations.map((annotation) => (
					<li
						key={`${annotation.kind}|${annotation.date}|${annotation.label}`}
						className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm"
					>
						<span className="text-muted-foreground text-xs tabular-nums">
							{annotation.date}
						</span>
						<span
							className={cn(
								"rounded px-1.5 py-0.5 text-xs",
								annotation.kind === "PROMPT_VERSION"
									? "bg-primary/10 text-primary"
									: "bg-highlight/10 text-highlight",
							)}
						>
							{annotation.kind === "PROMPT_VERSION"
								? "Prompt"
								: "Model"}
						</span>
						<span className="text-foreground">
							{annotation.label}
						</span>
						{annotation.detail ? (
							<span className="text-muted-foreground text-xs">
								{annotation.detail}
							</span>
						) : null}
					</li>
				))}
			</ol>
			<p className="text-muted-foreground text-xs">
				Prompt entries are a complete history — every published version
				has its own row. Model entries show only each task default’s
				most recent change: there is no history table, so an earlier
				swap leaves no trace once a later one overwrites it.
			</p>
		</section>
	);
}

export function AiAdoptionDashboard() {
	const [period, setPeriod] = useState<PeriodKey>("30d");
	const days =
		PERIOD_OPTIONS.find((option) => option.key === period)?.days ?? 30;

	const { data, isLoading, isError } = useQuery(
		orpc.admin.aiAdoption.metrics.queryOptions({
			input: { days },
			staleTime: 60_000,
			placeholderData: keepPreviousData,
		}),
	);

	return (
		<div className="space-y-8">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="font-serif text-2xl">AI Adoption</h1>
					<p className="text-muted-foreground text-sm">
						How AI-generated output is received across the platform.
					</p>
				</div>
				<div
					role="tablist"
					aria-label="Period"
					className="inline-flex rounded-md border border-border/60 bg-muted/40 p-0.5"
				>
					{PERIOD_OPTIONS.map((option) => (
						<button
							key={option.key}
							type="button"
							role="tab"
							aria-selected={period === option.key}
							onClick={() => setPeriod(option.key)}
							className={cn(
								"rounded-[5px] px-3 py-1 text-sm transition-colors",
								period === option.key
									? "bg-card text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{option.label}
						</button>
					))}
				</div>
			</div>

			{isError ? (
				<p className="text-destructive text-sm">
					Failed to load adoption metrics.
				</p>
			) : isLoading || !data ? (
				<div className="space-y-4">
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-56 w-full" />
					<Skeleton className="h-24 w-full" />
				</div>
			) : (
				<>
					<MaturationSection maturation={data.maturation} />
					<BacklogSection backlog={data.backlog} />
					<UsageSection usage={data.usage} />
					<FeatureUsageSection rows={data.usageByFeature} />
					<SegmentationSection
						segments={data.outcomeSegments}
						minSampleSize={data.minSampleSize}
					/>
					<ChangeLogSection annotations={data.changeAnnotations} />
				</>
			)}
		</div>
	);
}
