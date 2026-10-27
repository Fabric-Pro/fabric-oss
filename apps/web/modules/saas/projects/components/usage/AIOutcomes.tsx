"use client";

import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { formatDistanceToNow } from "date-fns";
import { ActivityIcon } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { buildProjectProposalRoute } from "../../lib/stories/routes";
import {
	duration,
	isReplayNotFound,
	type Range,
	REPLAY_STALE_TIME,
	type ReplaySummary,
	sourceLabel,
} from "./decision-replay";
import { SummaryTile } from "./SummaryTile";

const Dashboard = dynamic(
	() =>
		import("./DecisionReplayDashboard").then(
			(module) => module.DecisionReplayDashboard,
		),
	{ ssr: false, loading: () => <Skeleton className="h-340 w-full" /> },
);
const percent = (rate: number | null) =>
	rate === null ? "—" : `${Math.round(rate * 100)}%`;
const sign = (n: number) => (n < 0 ? "−" : "+");

export function AIOutcomes(props: Parameters<typeof OutcomesSummary>[0]) {
	const summary = props.summaryQuery.data;
	const hasData =
		summary &&
		(summary.waiting > 0 ||
			Object.values(summary.current.outcomes).some((n) => n > 0) ||
			Object.values(summary.current.changeOutcomes).some((n) => n > 0));
	return (
		<div className="space-y-8">
			<OutcomesSummary {...props} />
			{(hasData || props.summaryQuery.isError) && (
				<section aria-label="Trends and details" className="space-y-3">
					<h3 className="font-display text-xl">Trends and details</h3>
					<Dashboard
						key={props.projectId}
						projectId={props.projectId}
						onNotFound={props.onUnavailable}
					/>
				</section>
			)}
		</div>
	);
}

function OutcomesSummary({
	projectId,
	range,
	setRange,
	summaryQuery,
	onUnavailable,
}: {
	projectId: string;
	range: Range;
	setRange: (range: Range) => void;
	summaryQuery: UseQueryResult<ReplaySummary, Error>;
	onUnavailable: () => void;
}) {
	const basePath = useBasePath();
	const roadmap = `${basePath}/projects/${projectId}?tab=stories`;
	const needsReviewId = useId();
	const reviewHeading = useRef<HTMLHeadingElement>(null);
	const review = useQuery(
		orpc.projects.decisionReplay.listNeedsReview.queryOptions({
			input: { projectId, limit: 5 },
			staleTime: REPLAY_STALE_TIME,
			retry: false,
		}),
	);
	const notFound = isReplayNotFound(review.error);
	useEffect(() => {
		if (notFound) {
			onUnavailable();
		}
	}, [notFound, onUnavailable]);
	const summary = summaryQuery.data;
	const widerRange = { "7d": "30d", "30d": "90d", "90d": "all", all: null }[
		range
	] as Range | null;
	if (summaryQuery.isError) {
		return (
			<div role="alert" className="rounded-lg border p-6 text-sm">
				AI outcomes could not load.{" "}
				<Button
					variant="outline"
					onClick={() => void summaryQuery.refetch()}
				>
					Try again
				</Button>
			</div>
		);
	}
	if (!summary) {
		return (
			// biome-ignore lint/a11y/useSemanticElements: A loading region contains block content, not a calculation result.
			<div
				role="status"
				aria-label="Loading AI outcomes"
				className="space-y-6"
			>
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{[0, 1, 2, 3].map((n) => (
						<Skeleton key={n} className="h-28" />
					))}
				</div>
				<div className="grid gap-3 lg:grid-cols-2">
					<Skeleton className="h-80" />
					<Skeleton className="h-80" />
				</div>
			</div>
		);
	}
	const { current, previous } = summary;
	const total = Object.values(current.outcomes).reduce(
		(sum, n) => sum + n,
		0,
	);
	if (
		total === 0 &&
		summary.waiting === 0 &&
		!Object.values(current.changeOutcomes).some((n) => n > 0)
	) {
		return (
			<Card>
				<CardContent className="flex flex-col items-center gap-4 py-12 text-center">
					<ActivityIcon
						aria-hidden="true"
						className="size-10 text-muted-foreground"
					/>
					{!summary.changeCoverageStartedAt && (
						<p className="text-sm text-muted-foreground">
							Change review recording has not started for this
							project yet.
						</p>
					)}
					<h3 className="font-display text-xl">
						No AI suggestions{" "}
						{range === "all"
							? "yet"
							: `in the last ${range.slice(0, -1)} days`}
					</h3>
					<p className="max-w-xl text-sm text-muted-foreground">
						Suggestions appear here when the AI Update sidebar,
						meeting or channel monitoring, or roadmap
						recommendations propose changes to this project's
						backlog, and when someone rates AI output.
					</p>
					<div className="flex flex-wrap justify-center gap-3">
						<Button asChild>
							<Link href={roadmap}>Open the Roadmap</Link>
						</Button>
						{widerRange && (
							<Button
								variant="outline"
								onClick={() => setRange(widerRange)}
							>
								{widerRange === "all"
									? "Show all time"
									: `Show last ${widerRange.slice(0, -1)} days`}
							</Button>
						)}
					</div>
				</CardContent>
			</Card>
		);
	}
	const proposalFallback =
		!summary.changeCoverageStartedAt &&
		current.changeAcceptance.decided === 0;
	const displayedAcceptance = proposalFallback
		? current.acceptance
		: current.changeAcceptance;
	const previousAcceptance = proposalFallback
		? previous?.acceptance
		: previous?.changeAcceptance;
	const acceptanceDelta =
		previousAcceptance?.rate != null && displayedAcceptance.rate != null
			? Math.round(
					(displayedAcceptance.rate - previousAcceptance.rate) * 1000,
				) / 10
			: null;
	const reviewDelta =
		previous?.medianReviewSeconds != null &&
		current.medianReviewSeconds != null
			? current.medianReviewSeconds - previous.medianReviewSeconds
			: null;
	// Neighbors in the full six-segment order, checked against tooling/tailwind/theme.css
	// defaults composited over --card: light 3.90/11.66/3.22/5.49/5.99, dark
	// 7.00/8.17/3.88/3.14/5.52. A zero-count segment lets non-neighbors touch at lower
	// contrast, so the counts are also given as text by the legend and the aria-label.
	// The contrast regression test measures both themes; organization overrides need rechecking.
	const changeTotal =
		Object.values(current.changeOutcomes).reduce((sum, n) => sum + n, 0) -
		current.changeOutcomes.superseded;
	const segments = [
		{
			label: "Applied",
			count: current.changeOutcomes.applied,
			color: "fill-success stroke-background",
			swatch: "bg-success",
		},
		{
			label: "Not selected",
			count: current.changeOutcomes.notSelected,
			color: "fill-highlight/35 stroke-background dark:fill-highlight/20",
			swatch: "bg-highlight/35 dark:bg-highlight/20",
		},
		{
			label: "Already on roadmap",
			count: current.changeOutcomes.alreadyOnRoadmap,
			color: "fill-primary stroke-background",
			swatch: "bg-primary",
		},
		{
			label: "Rejected",
			count: current.changeOutcomes.rejected,
			color: "fill-destructive/95 stroke-background dark:fill-destructive/70",
			swatch: "bg-destructive/95 dark:bg-destructive/70",
		},
		{
			label: "Pending",
			count: current.changeOutcomes.pending,
			color: "fill-muted stroke-foreground",
			swatch: "bg-muted",
		},
		{
			label: "Failed / in progress",
			count:
				current.changeOutcomes.failed +
				current.changeOutcomes.inProgress,
			color: "fill-muted-foreground stroke-background",
			swatch: "bg-muted-foreground",
		},
	];
	let offset = 0;
	return (
		<div
			aria-busy={summaryQuery.isPlaceholderData}
			className={`space-y-8${summaryQuery.isPlaceholderData ? " opacity-50" : ""}`}
		>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<a
					href={`#${needsReviewId}`}
					className="rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={(event) => {
						event.preventDefault();
						reviewHeading.current?.scrollIntoView({
							block: "start",
							behavior: "instant",
						});
						reviewHeading.current?.focus({ preventScroll: true });
					}}
				>
					<SummaryTile
						label="Waiting for review"
						value={String(summary.waiting)}
						subtitle={
							summary.oldestWaitingAt
								? `oldest ${formatDistanceToNow(new Date(summary.oldestWaitingAt))} · Review now ↓`
								: "nothing waiting"
						}
					/>
				</a>
				<SummaryTile
					label={
						proposalFallback
							? "Acceptance rate"
							: "Changes accepted"
					}
					value={
						proposalFallback
							? percent(displayedAcceptance.rate)
							: `${displayedAcceptance.accepted} of ${displayedAcceptance.decided}`
					}
					subtitle={
						displayedAcceptance.rate === null
							? "no decisions yet"
							: `${proposalFallback ? `${displayedAcceptance.accepted} accepted of ${displayedAcceptance.decided} decided` : `${percent(displayedAcceptance.rate)} accepted`}${acceptanceDelta === null ? "" : acceptanceDelta === 0 ? " · No change vs previous period" : ` · ${sign(acceptanceDelta)}${Math.abs(acceptanceDelta)} percentage points vs previous period`}`
					}
				/>

				<SummaryTile
					label="Median time to review"
					value={
						current.medianReviewSeconds === null
							? "—"
							: duration(current.medianReviewSeconds)
					}
					subtitle={
						current.medianReviewSeconds === null
							? "no reviewed inbox proposals yet"
							: `inbox proposals only${reviewDelta === null ? "" : Math.round(Math.abs(reviewDelta) * 10) === 0 ? " · No change vs previous period" : ` · ${sign(reviewDelta)}${duration(Math.abs(reviewDelta))} vs previous period`}`
					}
				/>
				<SummaryTile
					label="Kept as applied"
					value={percent(current.keptAsApplied.rate)}
					subtitle={
						current.keptAsApplied.rate === null
							? "no proposals applied at least 7 days ago"
							: "not edited within 7 days of applying"
					}
				/>
			</div>
			{proposalFallback && (
				<p className="text-sm text-muted-foreground">
					Proposal acceptance is shown here. Per-change counts start
					when reviews are recorded.
				</p>
			)}
			<div className="grid gap-3 lg:grid-cols-2">
				<Card role="region" aria-labelledby={needsReviewId}>
					<CardHeader className="flex flex-row flex-wrap justify-between gap-3 pb-2">
						<div>
							<h3
								id={needsReviewId}
								ref={reviewHeading}
								tabIndex={-1}
								className="scroll-mt-6 text-base font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								Needs review
							</h3>
							{review.data && (
								<p className="text-xs text-muted-foreground">
									Oldest first · showing{" "}
									{review.data.items.length} of{" "}
									{review.data.total}
								</p>
							)}
						</div>
						<Link
							className="text-sm underline underline-offset-4"
							href={`${roadmap}&inbox=proposals`}
						>
							Open inbox ({review.data?.total ?? summary.waiting})
						</Link>
					</CardHeader>
					<CardContent>
						{review.isError ? (
							<div role="alert">
								Review queue could not load.{" "}
								<Button
									variant="outline"
									onClick={() => void review.refetch()}
								>
									Try again
								</Button>
							</div>
						) : !review.data ? (
							<Skeleton className="h-64" />
						) : review.data.items.length === 0 ? (
							<p className="py-6 text-sm text-muted-foreground">
								Nothing waiting for review
							</p>
						) : (
							<ul className="space-y-2">
								{review.data.items.map((item, index) => (
									<li key={item.id}>
										<Link
											href={buildProjectProposalRoute(
												basePath,
												projectId,
												item.id,
											)}
											className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<span className="min-w-0">
												<span className="block break-words">
													{item.summary}
												</span>
												<span className="text-xs text-muted-foreground">
													{sourceLabel(item.source)} ·{" "}
													{item.changeCount}{" "}
													{item.changeCount === 1
														? "change"
														: "changes"}
												</span>
											</span>
											<span
												className={
													index === 0
														? "shrink-0 text-xs font-semibold text-foreground"
														: "shrink-0 text-xs text-muted-foreground"
												}
											>
												{formatDistanceToNow(
													new Date(item.createdAt),
												)}{" "}
												waiting
											</span>
											<span className="text-xs underline">
												Review
											</span>
										</Link>
									</li>
								))}
							</ul>
						)}
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-base font-medium">
							Where changes ended up
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						{!summary.changeCoverageStartedAt ? (
							<p className="text-sm text-muted-foreground">
								Change review recording has not started for this
								project yet.
							</p>
						) : changeTotal === 0 ? (
							<p className="text-sm text-muted-foreground">
								No covered change decisions in this period.
							</p>
						) : (
							<svg
								role="img"
								aria-label={segments
									.map((s) => `${s.label}: ${s.count}`)
									.join(", ")}
								viewBox="0 0 100 4"
								preserveAspectRatio="none"
								className="h-4 w-full overflow-hidden rounded border border-foreground"
							>
								<title>Share of changes by outcome</title>
								{segments.map((segment) => {
									const width = changeTotal
										? (segment.count / changeTotal) * 100
										: 0;
									const x = offset;
									offset += width;
									return (
										<rect
											key={segment.label}
											x={x}
											y="0"
											width={width}
											height="4"
											className={segment.color}
											strokeWidth="0.5"
										/>
									);
								})}
							</svg>
						)}
						<p className="text-sm">
							Superseded · {current.changeOutcomes.superseded}
						</p>
						<ul className="grid gap-3 sm:grid-cols-2">
							{segments.map((segment) => (
								<li
									key={segment.label}
									className="flex items-center gap-2 text-sm"
								>
									<span
										aria-hidden="true"
										className={`size-3 shrink-0 rounded-sm border border-foreground ${segment.swatch}`}
									/>
									{segment.label} · {segment.count}
								</li>
							))}
						</ul>
						<p className="text-xs text-muted-foreground">
							Not selected means omitted in the latest review;
							unchosen recommendation changes stay pending until
							the batch closes.
						</p>
						<p className="text-xs text-muted-foreground">
							Changes are counted from when review recording
							started for this project. Incomplete sidebar reviews
							are excluded. Already on roadmap, Pending and
							Superseded are outside the acceptance rate.
						</p>
					</CardContent>
				</Card>
			</div>
			<Card>
				<CardHeader>
					<CardTitle className="text-base font-medium">
						Proposal outcomes
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<ul className="grid gap-3 sm:grid-cols-2">
						<li>Applied proposals · {current.outcomes.applied}</li>
						<li>
							Partly applied · {current.partlyApplied} (included
							in applied)
						</li>
						<li>
							Rejected proposals · {current.outcomes.rejected}
						</li>
						<li>Pending proposals · {current.outcomes.pending}</li>
						<li>Other proposals · {current.outcomes.other}</li>
					</ul>
					<p className="text-xs text-muted-foreground">
						Rejected includes Move to Rejected. Other includes
						failed, superseded, approved and applying proposals.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
