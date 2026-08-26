"use client";

/**
 * Indexing details for one connected repository, shown under its status row in
 * repository settings. Surfaces a live progress bar while INDEXING, and the
 * indexed branch / timestamps / pending-changes diff once READY. Colours are
 * design tokens only; animations are `motion-safe:` and icon-only affordances
 * carry an aria-label.
 */

import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Progress } from "@ui/components/progress";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	GitBranchIcon,
	Loader2Icon,
	type LucideIcon,
	PlayIcon,
	RefreshCwIcon,
	SearchIcon,
} from "lucide-react";

export interface CodeIndexDetails {
	status: string;
	branch?: string | null;
	commitSha?: string | null;
	indexedAt?: string | Date | null;
	filesIndexed?: number;
	chunksCreated?: number;
	indexedFileCount?: number | null;
	totalFileCount?: number | null;
	lastFullIndexAt?: string | Date | null;
	lastIncrementalAt?: string | Date | null;
}

interface CodeIndexDetailsPanelProps {
	projectId: string;
	organizationId: string | null;
	repositoryIntegrationId: string;
	codeIndex: CodeIndexDetails | null;
	isStateKnown?: boolean;
	hasLegacyIndexRecord?: boolean;
	canManageIntegrations: boolean;
	/** Start a re-index — "incremental" (fast, diff-only) or "full" (rebuild). */
	onReindex?: (mode: "incremental" | "full") => void;
	isReindexing?: boolean;
}

/** Header meta per code-index status. Fails safe to a neutral "Not indexed". */
function statusHeader(status?: string | null): {
	label: string;
	icon: LucideIcon;
	iconColor: string;
	spin?: boolean;
} {
	switch (status) {
		case "READY":
			return {
				label: "Indexed",
				icon: CheckCircle2Icon,
				iconColor: "text-secondary",
			};
		case "INDEXING":
			return {
				label: "Indexing…",
				icon: Loader2Icon,
				iconColor: "text-highlight",
				spin: true,
			};
		case "PENDING":
			return {
				label: "Queued…",
				icon: Loader2Icon,
				iconColor: "text-highlight",
				spin: true,
			};
		case "STALE":
			return {
				label: "Index out of date",
				icon: AlertTriangleIcon,
				iconColor: "text-highlight",
			};
		case "FAILED":
			return {
				label: "Indexing failed",
				icon: AlertTriangleIcon,
				iconColor: "text-destructive",
			};
		default:
			return {
				label: "Not indexed",
				icon: SearchIcon,
				iconColor: "text-muted-foreground",
			};
	}
}

/** Determinate/indeterminate embed progress while INDEXING or PENDING. */
function IndexingProgress({ codeIndex }: { codeIndex: CodeIndexDetails }) {
	const total = codeIndex.totalFileCount ?? null;
	const done = codeIndex.indexedFileCount ?? 0;

	// Total not known yet (walk/clone still running) — indeterminate bar.
	if (total === null || total <= 0) {
		return (
			<div className="space-y-1">
				<div
					className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
					role="progressbar"
					aria-label="Preparing code index"
				>
					<div className="h-full w-1/3 rounded-full bg-primary/70 motion-safe:animate-pulse" />
				</div>
				<span className="text-muted-foreground">Preparing…</span>
			</div>
		);
	}

	const pct = Math.min(100, Math.round((done / total) * 100));
	return (
		<div className="space-y-1">
			<Progress
				value={pct}
				className="h-1.5"
				aria-label={`Indexing progress: ${pct}%`}
			/>
			<span className="text-muted-foreground tabular-nums">
				{pct}% · {done.toLocaleString()} / {total.toLocaleString()}{" "}
				files
			</span>
		</div>
	);
}

/** One "label value" detail line. */
function DetailLine({
	icon: Icon,
	children,
}: {
	icon: LucideIcon;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-1.5 text-muted-foreground">
			<Icon className="size-3 shrink-0" aria-hidden="true" />
			<span className="min-w-0 truncate">{children}</span>
		</div>
	);
}

/** "Up to date" / "N commits behind · M files changed" for a READY/STALE repo. */
function PendingChangesLine({
	projectId,
	organizationId,
	repositoryIntegrationId,
	canManageIntegrations,
	onReindex,
	isReindexing,
}: {
	projectId: string;
	organizationId: string | null;
	repositoryIntegrationId: string;
	canManageIntegrations: boolean;
	onReindex?: (mode: "incremental" | "full") => void;
	isReindexing?: boolean;
}) {
	const { data, isPending } = useQuery(
		orpc.agents.codeIndex.pendingChanges.queryOptions({
			input: { projectId, organizationId, repositoryIntegrationId },
		}),
	);

	// Unknown (unsupported provider, no token, failed compare) or still loading —
	// omit the line rather than guessing.
	if (isPending || !data || data.upToDate === null) {
		return null;
	}

	if (data.upToDate) {
		return (
			<DetailLine icon={CheckCircle2Icon}>
				<span className="text-secondary">Up to date</span>
			</DetailLine>
		);
	}

	const commits = data.behindByCommits;
	const files = data.changedFiles;
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-highlight">
			<span className="flex items-center gap-1.5">
				<AlertTriangleIcon
					className="size-3 shrink-0"
					aria-hidden="true"
				/>
				{commits.toLocaleString()} commit{commits === 1 ? "" : "s"}{" "}
				behind
				{files > 0
					? ` · ${files.toLocaleString()} file${files === 1 ? "" : "s"} changed since last index`
					: ""}
			</span>
			{canManageIntegrations && onReindex && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => onReindex("incremental")}
					disabled={isReindexing}
					title="Re-embed only the files changed since the last index"
					className="h-6 gap-1 px-2 text-xs text-highlight hover:text-highlight"
				>
					{isReindexing ? (
						<Loader2Icon
							className="size-3 motion-safe:animate-spin"
							aria-hidden="true"
						/>
					) : (
						<RefreshCwIcon className="size-3" aria-hidden="true" />
					)}
					Update index
				</Button>
			)}
		</div>
	);
}

export function CodeIndexDetailsPanel({
	projectId,
	organizationId,
	repositoryIntegrationId,
	codeIndex,
	isStateKnown = false,
	hasLegacyIndexRecord = false,
	canManageIntegrations,
	onReindex,
	isReindexing,
}: CodeIndexDetailsPanelProps) {
	const header = statusHeader(codeIndex?.status);
	const HeaderIcon = header.icon;
	const isIndexing =
		codeIndex?.status === "INDEXING" || codeIndex?.status === "PENDING";
	const isReady = codeIndex?.status === "READY";
	const showsPendingChanges = isReady || codeIndex?.status === "STALE";

	const branch = codeIndex?.branch ?? null;
	const files = codeIndex?.filesIndexed ?? 0;
	const chunks = codeIndex?.chunksCreated ?? 0;

	const isFirstTimeIndex =
		isStateKnown && !hasLegacyIndexRecord && codeIndex === null;

	return (
		// Distinct inset "section" inside the repo's connected (green) card, so the
		// code-index detail reads as its own block rather than bleeding into the
		// connection status. Neutral card surface (design token) contrasts with the
		// green without a hardcoded colour.
		<div className="mt-2.5 space-y-1.5 rounded-md border border-border/60 bg-card p-2.5 text-xs">
			<div className="flex items-center gap-1.5">
				<HeaderIcon
					className={cn(
						"size-3.5 shrink-0",
						header.iconColor,
						header.spin && "motion-safe:animate-spin",
					)}
					aria-hidden="true"
				/>
				<span className="font-medium text-foreground">
					{header.label}
				</span>
				{branch && (
					<span className="flex items-center gap-1 text-muted-foreground">
						<span aria-hidden="true">·</span>
						<GitBranchIcon className="size-3" aria-hidden="true" />
						<span className="truncate">{branch}</span>
					</span>
				)}
			</div>

			{isIndexing && codeIndex && (
				<IndexingProgress codeIndex={codeIndex} />
			)}

			{!isIndexing && codeIndex?.indexedAt && (
				<DetailLine icon={SearchIcon}>
					{isReady ? "Indexed " : "Last indexed "}
					{formatRelativeTime(codeIndex.indexedAt)}
					{isReady && (files > 0 || chunks > 0)
						? ` · ${files.toLocaleString()} files · ${chunks.toLocaleString()} chunks`
						: ""}
				</DetailLine>
			)}

			{isReady && codeIndex?.lastFullIndexAt && (
				<DetailLine icon={CheckCircle2Icon}>
					Full index {formatRelativeTime(codeIndex.lastFullIndexAt)}
					{codeIndex.lastIncrementalAt
						? ` · updated ${formatRelativeTime(codeIndex.lastIncrementalAt)}`
						: ""}
				</DetailLine>
			)}

			{showsPendingChanges && (
				<PendingChangesLine
					projectId={projectId}
					organizationId={organizationId}
					repositoryIntegrationId={repositoryIntegrationId}
					canManageIntegrations={canManageIntegrations}
					onReindex={onReindex}
					isReindexing={isReindexing}
				/>
			)}

			{isFirstTimeIndex && canManageIntegrations && onReindex && (
				<div className="mt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 p-2 sm:max-w-xl">
					<div className="space-y-0.5">
						<p className="font-medium text-foreground">
							Index your codebase
						</p>
						<p className="text-muted-foreground">
							Enable AI code understanding and context search for
							this repository.
						</p>
					</div>
					<Button
						type="button"
						size="sm"
						onClick={() => onReindex("full")}
						disabled={isReindexing}
						className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
					>
						{isReindexing ? (
							<Loader2Icon
								className="size-3 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<PlayIcon className="size-3" aria-hidden="true" />
						)}
						Start indexing
					</Button>
				</div>
			)}
		</div>
	);
}
