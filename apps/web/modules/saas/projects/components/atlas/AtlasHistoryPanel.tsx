"use client";

/**
 * Analysis history panel (AC#11).
 *
 * Renders a list of past analysis runs: who triggered, when, commit short SHA,
 * branch, mode (full/incremental) badge, status, node/edge/files/modules
 * counts, duration, and AI telemetry (model · tokens · cost). RUNNING rows show
 * a spinner. Newest first. Any null telemetry field is omitted.
 *
 * Pagination: the panel loads a small first page (5) and fetches further pages
 * on demand via "Show more" (offset-based `useInfiniteQuery`), so a long-lived
 * project's older runs stay reachable instead of being truncated. The header
 * shows the true total run count. The list scrolls within a bounded height.
 */
import type { AnalysisRunSummary } from "@repo/atlas/types";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CpuIcon,
	GitBranchIcon,
	GitCommitHorizontalIcon,
	Loader2Icon,
	XIcon,
} from "lucide-react";
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

interface AtlasHistoryPanelProps {
	projectId: string;
	repositoryIntegrationId: string | null;
	onClose: () => void;
}

function getUserInitials(name: string | null): string {
	if (!name) {
		return "?";
	}
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) {
		return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

/** Map a run's mode to its history-panel badge label. */
function modeLabelKey(mode: AnalysisRunSummary["mode"]): string {
	switch (mode) {
		case "full":
			return "modeFull";
		case "remap":
			return "modeRemap";
		case "remap_fresh":
			return "modeRemapFresh";
		default:
			return "modeIncremental";
	}
}

function HistoryRunRow({ run }: { run: AnalysisRunSummary }) {
	const t = useTranslations("projects.atlas.history");
	const isRunning = run.status === "RUNNING";
	const isFailed = run.status === "FAILED";
	// "Re-map fresh" is a destructive reset — flag it in the badge so it reads
	// distinctly from the additive full/incremental/keep runs.
	const isFreshRemap = run.mode === "remap_fresh";

	// AI telemetry meta line (model · tokens · cost). Each piece is omitted when
	// the backend has no value for it (structure-only / no-AI-provider runs), so
	// the whole line disappears for a run with no telemetry at all.
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
							{t("tokensCompact", {
								tokens: formatTokens(run.totalTokens),
							})}
						</span>
					</TooltipTrigger>
					<TooltipContent>
						{t("tokensTooltip", { count: run.totalTokens })}
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
						{t("costTooltip", {
							usd: (run.costMicroUsd / 1_000_000).toFixed(6),
						})}
					</TooltipContent>
				</Tooltip>
			),
		});
	}

	return (
		<div className="flex items-start gap-3 rounded-lg border border-border/40 bg-background/30 p-3">
			{/* Triggering user avatar */}
			<Avatar className="mt-0.5 size-7 shrink-0">
				<AvatarFallback className="bg-muted/70 text-[11px] font-medium text-muted-foreground">
					{getUserInitials(run.triggeredByName)}
				</AvatarFallback>
			</Avatar>

			<div className="min-w-0 flex-1 space-y-1">
				{/* First row: who + when */}
				<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
					<span className="truncate text-sm font-medium text-foreground/90">
						{run.triggeredByName ?? t("triggeredByUnknown")}
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

				{/* Second row: badges + commit */}
				<div className="flex flex-wrap items-center gap-1.5">
					<Badge
						variant="outline"
						className={
							isFreshRemap
								? "border-destructive/40 px-1.5 py-0 text-[10px] text-destructive"
								: "px-1.5 py-0 text-[10px]"
						}
					>
						{t(modeLabelKey(run.mode))}
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
							{t("statusRunning")}
						</Badge>
					) : isFailed ? (
						<Badge
							variant="outline"
							className="border-destructive/40 px-1.5 py-0 text-[10px] text-destructive"
						>
							{t("statusFailed")}
						</Badge>
					) : (
						<Badge
							variant="outline"
							className="border-secondary/40 px-1.5 py-0 text-[10px] text-secondary"
						>
							{t("statusReady")}
						</Badge>
					)}
					{run.commitShortSha && (
						<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
							<GitCommitHorizontalIcon
								aria-hidden="true"
								className="size-3"
							/>
							<code className="rounded bg-muted/60 px-1 font-mono">
								{run.commitShortSha}
							</code>
						</span>
					)}
					{run.branch && (
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="flex min-w-0 cursor-default items-center gap-1 text-[11px] text-muted-foreground">
									<GitBranchIcon
										aria-hidden="true"
										className="size-3 shrink-0"
									/>
									<span className="max-w-[8rem] truncate">
										{run.branch}
									</span>
								</span>
							</TooltipTrigger>
							<TooltipContent>{run.branch}</TooltipContent>
						</Tooltip>
					)}
				</div>

				{/* Third row: counts + duration */}
				{!isRunning && (
					<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
						{run.nodeCount > 0 && (
							<span>{t("nodes", { count: run.nodeCount })}</span>
						)}
						{run.edgeCount > 0 && (
							<span>{t("edges", { count: run.edgeCount })}</span>
						)}
						{run.filesAnalyzed > 0 && (
							<span>
								{t("files", { count: run.filesAnalyzed })}
							</span>
						)}
						{run.durationMs !== null && (
							<>
								<span
									aria-hidden="true"
									className="text-muted-foreground/40"
								>
									·
								</span>
								<span>{formatDuration(run.durationMs)}</span>
							</>
						)}
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
			</div>
		</div>
	);
}

export function AtlasHistoryPanel({
	projectId,
	repositoryIntegrationId,
	onClose,
}: AtlasHistoryPanelProps) {
	const t = useTranslations("projects.atlas.history");
	const { organizationId } = useOrganizationContext();

	// Offset-based pagination: a small first page, more on demand. The query key
	// carries the resolved scope so switching repository re-fetches the right
	// analysis's runs.
	const historyQuery = useInfiniteQuery({
		queryKey: [
			"atlas",
			"history",
			{
				projectId,
				repositoryIntegrationId: repositoryIntegrationId ?? null,
				organizationId: organizationId ?? null,
			},
		] as const,
		initialPageParam: 0,
		queryFn: ({ pageParam }) =>
			orpcClient.atlas.history({
				projectId,
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
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
		// Rendered inside a Popover (the surface chrome — border, background,
		// shadow, rounding — comes from PopoverContent), so the panel itself is a
		// plain header + scrollable run list.
		<div className="flex flex-col">
			<header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
				<div className="flex items-center gap-2">
					<h3 className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
						{t("title")}
					</h3>
					{total > 0 && (
						<span
							role="img"
							aria-label={t("runsTotal", { count: total })}
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
					aria-label={t("close")}
					onClick={onClose}
					className="-mr-1"
				>
					<XIcon aria-hidden="true" className="size-4" />
				</Button>
			</header>

			{/* Plain overflow container (not Radix ScrollArea): a bounded height
			    with native scrolling that reliably scrolls once the loaded runs
			    exceed it. */}
			<div className="max-h-[24rem] overflow-y-auto overscroll-contain">
				<div className="space-y-2 p-3">
					{historyQuery.isLoading ? (
						<>
							<Skeleton className="h-16 w-full rounded-lg" />
							<Skeleton className="h-16 w-full rounded-lg" />
						</>
					) : runs.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("empty")}
						</p>
					) : (
						<>
							{runs.map((run) => (
								<HistoryRunRow key={run.id} run={run} />
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
										{t("showMore")}
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
