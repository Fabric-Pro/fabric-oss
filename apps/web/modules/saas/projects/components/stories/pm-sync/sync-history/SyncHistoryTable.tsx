"use client";

import { pmDetectedTypeDisplayName } from "@repo/utils";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
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
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	ArrowUpRightIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
} from "lucide-react";
import { HistoryEmptyState } from "../../BacklogHistoryShared";
import { PmToolBrandIcon } from "../pm-tool-brand-icon";
import {
	PM_SYNC_LOG_PAGE_SIZE,
	type PmSyncLogStatusFilter,
} from "./use-pm-sync-log";

export type PmSyncLogRow = {
	id: string;
	createdAt: Date;
	direction: string;
	entityType: string;
	entityId: string;
	title: string;
	pmTool: string;
	status: PmSyncLogStatusFilter;
	statusDetail: string | null;
	batchId: string | null;
	actorUserId: string | null;
	correlationId: string | null;
	durationMs: number | null;
	externalId: string | null;
	externalUrl: string | null;
};

type Props = {
	rows: PmSyncLogRow[];
	total: number;
	isLoading: boolean;
	isFetching: boolean;
};

const STATUS_VARIANT: Record<
	PmSyncLogStatusFilter,
	"success" | "warning" | "error"
> = {
	SUCCESS: "success",
	FAILURE: "error",
	CONFLICT: "warning",
};

const STATUS_LABEL: Record<PmSyncLogStatusFilter, string> = {
	SUCCESS: "Success",
	FAILURE: "Failure",
	CONFLICT: "Conflict",
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

function formatDirection(direction: string): string {
	if (direction === "push") {
		return "Push";
	}
	if (direction === "pull") {
		return "Pull";
	}
	return direction;
}

/**
 * Status badge. When the row carries a detail (failure message / conflict
 * reason) the badge gets a tooltip so the *why* of a non-success outcome is
 * reachable without leaving the table. SUCCESS rows have no detail → plain badge.
 */
function StatusBadge({
	status,
	detail,
}: {
	status: PmSyncLogStatusFilter;
	detail: string | null;
}) {
	const badge = (
		<Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
	);
	if (!detail) {
		return badge;
	}
	// The tooltip is pointer-only — `asChild` on a bare span forwards focus
	// handlers to something that can never be focused, and giving every row's
	// badge a tab stop would add one per row. Since `statusDetail` is now the
	// only representation of WHY a sync failed, the reason is duplicated
	// `sr-only` so it reaches assistive tech regardless of input device.
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="cursor-help">
					{badge}
					<span className="sr-only"> — {detail}</span>
				</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs break-words">
				{detail}
			</TooltipContent>
		</Tooltip>
	);
}

export function SyncHistoryTable({
	rows,
	total,
	isLoading,
	isFetching,
}: Props) {
	if (isLoading) {
		return <SyncHistoryTableSkeleton />;
	}

	if (total === 0) {
		return <SyncHistoryEmptyState />;
	}

	return (
		<div>
			<div className="overflow-hidden rounded-xl border border-border bg-card">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>When</TableHead>
							<TableHead>Item</TableHead>
							<TableHead>Direction</TableHead>
							<TableHead>PM tool</TableHead>
							<TableHead>Status</TableHead>
							<TableHead className="text-right">Link</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody aria-busy={isFetching}>
						{rows.map((row) => {
							const pmToolLabel =
								pmDetectedTypeDisplayName(row.pmTool) ??
								row.pmTool;
							return (
								<TableRow key={row.id}>
									<TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
										{dateFormatter.format(
											new Date(row.createdAt),
										)}
									</TableCell>
									<TableCell className="max-w-xs">
										<div className="min-w-0">
											<p className="truncate font-medium text-foreground">
												{row.title}
											</p>
											<p className="truncate text-xs text-muted-foreground">
												<span className="uppercase tracking-[0.12em]">
													{row.entityType}
												</span>
												<span className="mx-1.5">
													·
												</span>
												<span className="font-mono">
													{row.entityId}
												</span>
											</p>
										</div>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{formatDirection(row.direction)}
									</TableCell>
									<TableCell>
										<span className="flex items-center gap-1.5 text-sm text-foreground">
											<PmToolBrandIcon
												pmToolType={row.pmTool}
												className="size-3.5"
											/>
											{pmToolLabel}
										</span>
									</TableCell>
									<TableCell>
										<StatusBadge
											status={row.status}
											detail={row.statusDetail}
										/>
									</TableCell>
									<TableCell className="text-right">
										{row.externalUrl ? (
											<a
												href={row.externalUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="inline-flex items-center gap-1 rounded-sm text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
												aria-label={`Open ${row.title} in ${pmToolLabel}`}
											>
												Open
												<ArrowUpRightIcon
													className="size-3.5"
													aria-hidden
												/>
											</a>
										) : (
											<span className="text-muted-foreground/60">
												—
											</span>
										)}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

/**
 * Sync-log pager. Rendered by `SyncHistoryView` as pinned footer chrome rather
 * than inside the table, so it stays put while the rows scroll — matching the
 * Change History tab, which pins its own pager the same way.
 */
export function SyncHistoryPager({
	rowCount,
	total,
	page,
	isFetching,
	onPageChange,
}: {
	rowCount: number;
	total: number;
	page: number;
	isFetching: boolean;
	onPageChange: (page: number) => void;
}) {
	const pageCount = Math.max(1, Math.ceil(total / PM_SYNC_LOG_PAGE_SIZE));
	const firstRow = page * PM_SYNC_LOG_PAGE_SIZE + 1;
	const lastRow = Math.min(total, firstRow + rowCount - 1);

	return (
		<nav
			className="flex items-center justify-between gap-4"
			aria-label="Sync history pagination"
		>
			<p className="text-xs text-muted-foreground tabular-nums">
				{firstRow}–{lastRow} of {total}
			</p>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8"
					onClick={() => onPageChange(page - 1)}
					disabled={page === 0 || isFetching}
					aria-label="Previous page"
				>
					<ChevronLeftIcon className="size-4" aria-hidden />
					Previous
				</Button>
				<span className="text-xs text-muted-foreground tabular-nums">
					Page {page + 1} of {pageCount}
				</span>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8"
					onClick={() => onPageChange(page + 1)}
					disabled={page + 1 >= pageCount || isFetching}
					aria-label="Next page"
				>
					Next
					<ChevronRightIcon className="size-4" aria-hidden />
				</Button>
			</div>
		</nav>
	);
}

function SyncHistoryTableSkeleton() {
	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card">
			<div className="space-y-3 p-4">
				{["a", "b", "c", "d", "e"].map((key) => (
					<Skeleton key={key} className="h-10 w-full rounded-md" />
				))}
			</div>
		</div>
	);
}

/**
 * Empty state. Shares `HistoryEmptyState` with the Change History tab rather
 * than styling its own: the two sit one click apart in the same window, and the
 * shared one also gives the heading real `<h3>` semantics and a dot-grid that
 * survives dark mode (the old local copy used `.editorial-label`, whose
 * hardcoded red fails AA contrast on a dark surface).
 */
function SyncHistoryEmptyState() {
	return (
		<HistoryEmptyState
			title="No sync activity yet"
			description="When Fabric pushes features to or pulls changes from your project management tool, every attempt is recorded here."
		/>
	);
}
