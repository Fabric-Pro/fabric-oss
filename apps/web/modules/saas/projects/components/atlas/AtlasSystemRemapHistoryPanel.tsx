"use client";

/**
 * System-map relationship history panel.
 *
 * Lists the cross-repo recompute ("re-map") runs newest-first: who/what
 * triggered it (Auto / Re-map / Re-map fresh), the resulting connection count,
 * the run status, and the AI telemetry line (model · tokens · cost) + duration.
 * RUNNING rows show a spinner. Any null telemetry field is omitted.
 *
 * Mirrors {@link AtlasHistoryPanel} (the per-repo analysis history) for
 * layout, skeletons, telemetry formatting and offset "Show more" pagination —
 * the two panels share the same card/section styles so the SYSTEM view's
 * history reads as the same surface as the GRAPH view's.
 */
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { CpuIcon, Loader2Icon, Share2Icon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import {
	formatDuration,
	formatRelativeTime,
	formatTokens,
	formatUsdFromMicros,
} from "./atlas-utils";

/** Runs loaded per "Show more" click (and the initial page). */
const HISTORY_PAGE_SIZE = 5;

/**
 * One cross-link recompute run, inferred from the oRPC procedure's return type
 * so this panel stays in lock-step with the backend contract without importing
 * the internal `CrossLinkRunSummary` (it isn't part of the public types entry).
 */
type SystemRemapRun = Awaited<
	ReturnType<typeof orpcClient.atlas.systemRemapHistory>
>["runs"][number];

interface AtlasSystemRemapHistoryPanelProps {
	projectId: string;
	onClose: () => void;
}

function SystemRemapRunRow({ run }: { run: SystemRemapRun }) {
	const t = useTranslations("projects.atlas");
	const isRunning = run.status === "RUNNING";
	const isFailed = run.status === "FAILED";

	// AI telemetry meta line (model · tokens · cost). Each piece is omitted when
	// the backend has no value for it, so the whole line disappears for a run
	// with no telemetry at all.
	const telemetry: { key: string; node: ReactNode }[] = [];
	if (run.model) {
		telemetry.push({
			key: "model",
			node: (
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="flex min-w-0 cursor-default items-center gap-1">
							<CpuIcon
								aria-hidden="true"
								className="size-3 shrink-0"
							/>
							<span className="max-w-[10rem] truncate">
								{run.model}
							</span>
						</span>
					</TooltipTrigger>
					<TooltipContent>{run.model}</TooltipContent>
				</Tooltip>
			),
		});
	}
	if (run.totalTokens !== null) {
		telemetry.push({
			key: "tokens",
			node: (
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="cursor-default tabular-nums">
							{t("history.tokensCompact", {
								tokens: formatTokens(run.totalTokens),
							})}
						</span>
					</TooltipTrigger>
					<TooltipContent>
						{t("history.tokensTooltip", {
							count: run.totalTokens,
						})}
					</TooltipContent>
				</Tooltip>
			),
		});
	}
	if (run.costMicroUsd !== null) {
		telemetry.push({
			key: "cost",
			node: (
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="cursor-default tabular-nums">
							{formatUsdFromMicros(run.costMicroUsd)}
						</span>
					</TooltipTrigger>
					<TooltipContent>
						{t("history.costTooltip", {
							usd: (run.costMicroUsd / 1_000_000).toFixed(6),
						})}
					</TooltipContent>
				</Tooltip>
			),
		});
	}

	const triggerLabel =
		run.trigger === "remap"
			? t("system.remapTrigger.remap")
			: run.trigger === "remap_fresh"
				? t("system.remapTrigger.remap_fresh")
				: t("system.remapTrigger.auto");

	return (
		<div className="flex flex-col gap-1 rounded-lg border border-border/40 bg-background/30 p-3">
			{/* First row: who/when + trigger + status badges */}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span className="truncate text-sm font-medium text-foreground/90">
					{run.triggeredByName ?? t("history.triggeredByUnknown")}
				</span>
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="cursor-default text-[11px] text-muted-foreground">
							{formatRelativeTime(run.startedAt)}
						</span>
					</TooltipTrigger>
					<TooltipContent>
						{new Date(run.startedAt).toLocaleString()}
					</TooltipContent>
				</Tooltip>
			</div>

			{/* Second row: trigger badge + status + connection count */}
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge
					variant="outline"
					className={
						run.trigger === "remap_fresh"
							? "border-destructive/40 px-1.5 py-0 text-[10px] text-destructive"
							: "px-1.5 py-0 text-[10px]"
					}
				>
					{triggerLabel}
				</Badge>
				{isRunning ? (
					<Badge
						variant="outline"
						className="gap-1 border-highlight/40 px-1.5 py-0 text-[10px] text-highlight"
					>
						<Loader2Icon
							aria-hidden="true"
							className="size-2.5 motion-safe:animate-spin"
						/>
						{t("history.statusRunning")}
					</Badge>
				) : isFailed ? (
					<Badge
						variant="outline"
						className="border-destructive/40 px-1.5 py-0 text-[10px] text-destructive"
					>
						{t("history.statusFailed")}
					</Badge>
				) : (
					<Badge
						variant="outline"
						className="border-secondary/40 px-1.5 py-0 text-[10px] text-secondary"
					>
						{t("history.statusReady")}
					</Badge>
				)}
				{!isRunning && (
					<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
						<Share2Icon aria-hidden="true" className="size-3" />
						{t("history.edges", { count: run.edgeCount })}
					</span>
				)}
			</div>

			{/* Third row: duration */}
			{!isRunning && run.durationMs !== null && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
					<span>{formatDuration(run.durationMs)}</span>
				</div>
			)}

			{/* Fourth row: AI telemetry (model · tokens · cost) */}
			{!isRunning && telemetry.length > 0 && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
					{telemetry.map((item, index) => (
						<Fragment key={item.key}>
							{index > 0 && (
								<span
									aria-hidden="true"
									className="text-muted-foreground/40"
								>
									·
								</span>
							)}
							{item.node}
						</Fragment>
					))}
				</div>
			)}

			{/* Failed runs surface the error inline (calm, not a toast). */}
			{isFailed && run.error && (
				<p className="text-[11px] text-destructive">{run.error}</p>
			)}
		</div>
	);
}

export function AtlasSystemRemapHistoryPanel({
	projectId,
	onClose,
}: AtlasSystemRemapHistoryPanelProps) {
	const t = useTranslations("projects.atlas");
	const { organizationId } = useOrganizationContext();

	// Offset-based pagination: a small first page, more on demand. The query key
	// carries the resolved scope so it re-fetches per project/tenant.
	const historyQuery = useInfiniteQuery({
		queryKey: [
			"atlas",
			"systemRemapHistory",
			{
				projectId,
				organizationId: organizationId ?? null,
			},
		] as const,
		initialPageParam: 0,
		queryFn: ({ pageParam }) =>
			orpcClient.atlas.systemRemapHistory({
				projectId,
				organizationId: organizationId ?? null,
				limit: HISTORY_PAGE_SIZE,
				offset: pageParam,
			}),
		getNextPageParam: (lastPage, pages) => {
			const loaded = pages.reduce(
				(sum, page) => sum + page.runs.length,
				0,
			);
			return loaded < lastPage.total ? loaded : undefined;
		},
	});

	const runs = historyQuery.data?.pages.flatMap((page) => page.runs) ?? [];
	const total = historyQuery.data?.pages[0]?.total ?? 0;

	return (
		// Rendered inside a Popover (the surface chrome comes from PopoverContent),
		// so the panel itself is a plain header + scrollable run list — identical
		// to AtlasHistoryPanel.
		<div className="flex flex-col">
			<header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
				<div className="flex items-center gap-2">
					<h3 className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
						{t("system.remapHistoryTitle")}
					</h3>
					{total > 0 && (
						<span
							role="img"
							aria-label={t("history.runsTotal", {
								count: total,
							})}
							className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
						>
							{total}
						</span>
					)}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("history.close")}
					onClick={onClose}
					className="-mr-1"
				>
					<XIcon aria-hidden="true" className="size-4" />
				</Button>
			</header>

			<div className="max-h-[24rem] overflow-y-auto overscroll-contain">
				<div className="space-y-2 p-3">
					{historyQuery.isLoading ? (
						<>
							<Skeleton className="h-16 w-full rounded-lg" />
							<Skeleton className="h-16 w-full rounded-lg" />
						</>
					) : runs.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("system.remapHistoryEmpty")}
						</p>
					) : (
						<>
							{runs.map((run) => (
								<SystemRemapRunRow key={run.id} run={run} />
							))}
							{historyQuery.hasNextPage && (
								<div className="pt-1">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() =>
											historyQuery.fetchNextPage()
										}
										disabled={
											historyQuery.isFetchingNextPage
										}
										className="w-full gap-1.5 text-muted-foreground hover:text-foreground"
									>
										{historyQuery.isFetchingNextPage && (
											<Loader2Icon
												aria-hidden="true"
												className="size-3.5 motion-safe:animate-spin"
											/>
										)}
										{t("history.showMore")}
									</Button>
								</div>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
